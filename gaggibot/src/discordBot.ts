import { Client, GatewayIntentBits, Partials, type Message, type MessageReaction, type PartialMessageReaction, type User, type PartialUser } from "discord.js";
import type { Config } from "./config.js";
import { applyFields, fieldsIn, normalizePatch, patchForReuse, RATING_EMOJIS, REUSE_EMOJI, savedPart, SKIP_EMOJI, stepMessage } from "./flow.js";
import { parseReply, parseWithAi } from "./parser.js";
import { STEPS, type NotesPatch, type ShotPayload, type Workflow } from "./types.js";
import type { Store } from "./db.js";

type Log = ReturnType<typeof import("./logger.js").logger>;

export const TEST_MESSAGE = "\u{1F9EA} **Gaggibot test** \u2014 GaggiMate reached the bridge and the bot can DM you. Nothing was recorded; pull a shot for the real flow.";

/** A message the bot "sent". In dry-run mode nothing leaves the process. */
export type OutboxEntry = { seq: number; userId: string; channelId: string; messageId: string; content: string; reactions: string[]; at: string };

export class DiscordBot {
  private client = new Client({ intents:[GatewayIntentBits.Guilds,GatewayIntentBits.DirectMessages,GatewayIntentBits.DirectMessageReactions,GatewayIntentBits.MessageContent], partials:[Partials.Channel,Partials.Message,Partials.Reaction] });
  private locks = new Set<number>();
  private reconciling = false;
  private pendingReconcile = false;
  private outbox: OutboxEntry[] = [];
  private outboxSeq = 0;
  ready = false;
  constructor(private cfg:Config, private store:Store, private log:Log) {
    this.client.once("ready", async () => {
      this.ready=true; this.log.info("Discord Gateway ready", {bot:this.client.user?.id});
      await this.reconcile();
    });
    this.client.on("messageCreate", m => void this.onMessage(m));
    this.client.on("messageReactionAdd", (r,u) => void this.onReaction(r,u));
    this.client.on("error", e => this.log.error("Discord client error", {error:e.message}));
  }
  async start():Promise<void> {
    if (this.cfg.dryRun) {
      // No Gateway connection: the HTTP API plus the dev endpoints are the whole surface under test.
      this.ready=true;
      this.log.warn("DRY RUN: Discord login skipped; messages are recorded, never sent");
      await this.reconcile();
      return;
    }
    await this.client.login(this.cfg.DISCORD_BOT_TOKEN);
  }
  async stop():Promise<void> { this.ready=false; if (this.cfg.dryRun) return; this.client.destroy(); }

  outboxSnapshot():OutboxEntry[] { return [...this.outbox]; }
  clearOutbox():void { this.outbox=[]; }

  /**
   * Called by the display's "Test" button (and by curl): sends one clearly-labelled DM to each
   * configured user and adds a ✅ reaction, which together prove the bot can DM the user and react —
   * the two things every real shot flow depends on.
   */
  async sendTestMessage():Promise<{userId:string;delivered:boolean;error?:string}[]> {
    const results:{userId:string;delivered:boolean;error?:string}[]=[];
    for (const userId of this.cfg.userIds) {
      try { await this.deliver(userId,null,TEST_MESSAGE,["✅"]); results.push({userId,delivered:true}); }
      catch(e) { results.push({userId,delivered:false,error:safeError(e)}); }
    }
    return results;
  }

  createForShot(payload:ShotPayload):void {
    // Normalise the display's notes into wire form once, so reuse and prompts use the same values.
    const previous=normalizePatch(payload.previous);
    for (const user of this.cfg.userIds) this.store.prepareWorkflow(payload.deviceId,payload.shot.id,user,previous);
    if (this.ready) void this.reconcile();
  }
  private async reconcile():Promise<void> {
    // Serialise passes, but never drop one: a shot ingested while a pass is awaiting Discord I/O must
    // still be started, otherwise its flow stays queued until some later shot supersedes it.
    this.pendingReconcile = true;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      while (this.pendingReconcile) {
        this.pendingReconcile = false;
        for (const w of this.store.listWorkflows(["queued"])) await this.startWorkflow(w);
        // Workflows retain their current Discord message across service restarts. No prompt is duplicated.
        for (const w of this.store.listWorkflows(["active"])) await this.resumeWorkflow(w);
      }
    } finally { this.reconciling = false; }
  }
  /**
   * Recover an active workflow that is not currently waiting on a live prompt: either its next prompt
   * never went out (step advanced, message id cleared, crash or send failure) or every step is done
   * and only the recap is missing.
   */
  private async resumeWorkflow(w:Workflow):Promise<void> {
    const needsWork = w.step >= STEPS.length || !w.currentMessageId;
    if (!needsWork) { await this.consumeExistingReaction(w); return; }
    if (!this.lock(w)) return;
    try {
      if (w.step >= STEPS.length) await this.finish(w);
      else await this.sendStep(w);
    } catch(e) { this.log.warn("Could not resume workflow",{workflow:w.id,error:safeError(e)}); }
    finally { this.unlock(w); }
  }
  private async startWorkflow(w:Workflow):Promise<void> {
    if (!this.lock(w)) return;
    try {
      this.store.supersedeOtherWorkflows(w.userId,w.id);
      const payload=this.store.getShot(w.deviceId,w.shotId); if (!payload) throw new Error("shot missing");
      w.status="active";
      const sent=await this.deliver(w.userId,w.channelId,this.summary(payload),[]);
      w.channelId=sent.channelId;
      this.store.saveWorkflow(w);
      await this.sendStep(w);
    } catch(e) { this.log.warn("Could not start workflow; it remains queued",{workflow:w.id,error:safeError(e)}); w.status="queued"; this.store.saveWorkflow(w); }
    finally { this.unlock(w); }
  }
  private summary(p:ShotPayload):string {
    const s=p.shot;
    return `☕ **Shot #${s.id} — ${s.profile || "Unknown profile"}**\n`+
      `⏱ ${s.duration.toFixed(1)} s   ⚖️ ${s.weight.toFixed(1)} g   🌡️ ${s.temperature.toFixed(1)} °C   `+
      `⏫ ${s.pressure.toFixed(1)} bar   💧 ${s.flow.toFixed(1)} ml/s\n`+
      "Let's log it — answer each step; use the reactions below each prompt.";
  }
  /** Reactions the bot pre-adds to a step prompt. */
  private reactionsFor(w:Workflow):string[] {
    const field=STEPS[w.step]; if (!field) return [];
    if (field === "rating") return [...RATING_EMOJIS, SKIP_EMOJI];
    const reactions:string[]=[];
    if (field !== "notes" && w.lastValues[field] !== undefined) reactions.push(REUSE_EMOJI);
    reactions.push(SKIP_EMOJI);
    return reactions;
  }
  private async sendStep(w:Workflow):Promise<void> {
    if (w.step >= STEPS.length) { await this.finish(w); return; }
    const sent=await this.deliver(w.userId,w.channelId,stepMessage(w),this.reactionsFor(w));
    w.channelId=sent.channelId; w.currentMessageId=sent.messageId; this.store.saveWorkflow(w);
  }
  /** Single send path: real DM in production, in-memory outbox under dry-run. */
  private async deliver(userId:string,channelId:string|null,content:string,reactions:string[]):Promise<{channelId:string;messageId:string}> {
    if (this.cfg.dryRun) {
      const channel=channelId ?? `dry-dm-${userId}`;
      const messageId=`dry-msg-${++this.outboxSeq}`;
      this.outbox.push({seq:this.outboxSeq,userId,channelId:channel,messageId,content,reactions,at:new Date().toISOString()});
      if (this.outbox.length>100) this.outbox.shift();
      this.log.info("DRY RUN message",{to:userId,messageId,reactions,content});
      return {channelId:channel,messageId};
    }
    const channel=channelId ? await this.client.channels.fetch(channelId) : await (await this.client.users.fetch(userId)).createDM();
    if (!channel?.isSendable()) throw new Error("DM channel unavailable");
    const message=await channel.send({content});
    for (const emoji of reactions) await message.react(emoji);
    return {channelId:channel.id,messageId:message.id};
  }
  private async onMessage(message:Message):Promise<void> {
    if (message.author.bot || message.guildId || !message.content.trim()) return;
    await this.handleUserText(message.author.id, message.content);
  }
  /** Shared by Discord DMs and the dry-run endpoint, so both drive the same state machine. */
  async handleUserText(userId:string,content:string):Promise<void> {
    const w=this.store.getActiveByUser(userId); if (!w || !this.lock(w)) return;
    try {
      const current=STEPS[w.step]; if (!current) return;
      let patch:NotesPatch|null=null;
      if (this.cfg.AI_URL) patch=await parseWithAi(content,current,{url:this.cfg.AI_URL,key:this.cfg.AI_API_KEY,model:this.cfg.AI_MODEL});
      patch=patch ?? parseReply(content,current);
      await this.applyPatch(w,patch);
    } catch(e) { this.log.warn("Failed to handle Discord message",{workflow:w.id,error:safeError(e)}); }
    finally { this.unlock(w); }
  }
  private async onReaction(reaction:MessageReaction|PartialMessageReaction,user:User|PartialUser):Promise<void> {
    if (user.bot) return;
    try { if (reaction.partial) await reaction.fetch(); } catch { return; }
    await this.handleUserReaction(user.id, reaction.message.id, reaction.emoji.name ?? "");
  }
  async handleUserReaction(userId:string,messageId:string,emoji:string):Promise<void> {
    const w=this.store.getActiveByUser(userId);
    if (!w || messageId !== w.currentMessageId || !this.lock(w)) return;
    try {
      if (w.step === 0) {
        const n=RATING_EMOJIS.indexOf(emoji as typeof RATING_EMOJIS[number]);
        if (n >= 0) { await this.applyPatch(w,{rating:n+1}); return; }
      }
      if (emoji === REUSE_EMOJI || emoji === "↩") {
        // The rating step offers keycaps only: reusing an old rating would silently re-rate this shot.
        if (w.step === 0) return;
        const patch=patchForReuse(w); if (patch) await this.applyPatch(w,patch); return;
      }
      if (emoji === SKIP_EMOJI || emoji === "➡") await this.skip(w);
    } catch(e) { this.log.warn("Failed to handle reaction",{workflow:w.id,error:safeError(e)}); }
    finally { this.unlock(w); }
  }
  private async applyPatch(w:Workflow,patch:NotesPatch):Promise<void> {
    const clean=normalizePatch(patch);
    const fields=fieldsIn(clean);
    if (!fields.length && clean.doseOut === undefined) return;
    for (const field of [...fields,...(clean.doseOut !== undefined ? ["doseOut" as const] : [])]) {
      const value=clean[field]; if (value === undefined) continue;
      this.store.queuePatch(w.deviceId,w.shotId,{[field]:value});
      w.savedParts.push(savedPart(field,value));
    }
    const result=applyFields(w,clean); this.store.saveWorkflow(w);
    if (result.answeredCurrent) { w.step=result.next; w.currentMessageId=null; this.store.saveWorkflow(w); await this.sendStep(w); }
  }
  private async skip(w:Workflow):Promise<void> {
    let next=w.step+1; while (next<STEPS.length && (w.answeredMask&(1<<next))) next++;
    w.step=next; w.currentMessageId=null; this.store.saveWorkflow(w); await this.sendStep(w);
  }
  private async finish(w:Workflow):Promise<void> {
    const recap=w.savedParts.length ? w.savedParts.join(", ") : "nothing recorded";
    const sent=await this.deliver(w.userId,w.channelId,`✅ Shot #${w.shotId} logged: ${recap.slice(0,1900)}.`,[]);
    w.channelId=sent.channelId; w.status="done"; w.currentMessageId=null; this.store.saveWorkflow(w);
  }
  private async consumeExistingReaction(w:Workflow):Promise<void> {
    if (this.cfg.dryRun || !w.channelId || !w.currentMessageId) return;
    try {
      const channel=await this.client.channels.fetch(w.channelId); if (!channel?.isTextBased()) return;
      const message=await channel.messages.fetch(w.currentMessageId);
      for (const reaction of message.reactions.cache.values()) {
        const users=await reaction.users.fetch(); const user=users.get(w.userId);
        if (user) { await this.onReaction(reaction,user); break; }
      }
    } catch(e) { this.log.warn("Could not reconcile prior reaction",{workflow:w.id,error:safeError(e)}); }
  }
  private lock(w:Workflow):boolean { if(this.locks.has(w.id))return false; this.locks.add(w.id); return true; }
  private unlock(w:Workflow):void { this.locks.delete(w.id); }
}
function safeError(e:unknown):string { return e instanceof Error ? e.message.slice(0,300) : "unknown error"; }
