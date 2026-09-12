import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Partials, type Interaction, type Message, type MessageReaction, type PartialMessageReaction, type User, type PartialUser } from "discord.js";
import type { Config } from "./config.js";
import { actionFromCustomId, actionFromEmoji, applyFields, BUTTON_PREFIX, clipUnits, fieldsIn, normalizePatch, patchForReuse, savedPart, stepButtons, stepMessage, type StepAction, type StepButton } from "./flow.js";
import { parseReply, parseWithAi } from "./parser.js";
import { STEPS, type NotesPatch, type ShotPayload, type Workflow } from "./types.js";
import type { Store } from "./db.js";

type Log = ReturnType<typeof import("./logger.js").logger>;

export const TEST_MESSAGE = "\u{1F9EA} **Gaggibot test** \u2014 GaggiMate reached the bridge and the bot can DM you. Nothing was recorded; pull a shot for the real flow.";

/** A message the bot "sent". In dry-run mode nothing leaves the process. */
export type OutboxEntry = { seq: number; userId: string; channelId: string; messageId: string; content: string; buttons: {customId:string;label:string}[]; buttonsRemoved?: boolean; at: string };

const TEST_BUTTON_ID=`${BUTTON_PREFIX}test`;
const TEST_DONE_MESSAGE="✅ **Buttons work too.** GaggiMate can reach the bridge, the bot can DM you, and you can answer with a tap. Nothing was recorded; pull a shot for the real flow.";

export class DiscordBot {
  // The client is (re)created per login attempt: discord.js leaves a client in an unusable state
  // after a failed login, and a bad token or a disabled privileged intent must not crash-loop the
  // container — it has to keep serving HTTP and report why Discord is unavailable.
  private client: Client | null = null;
  private locks = new Set<number>();
  private reconciling = false;
  private pendingReconcile = false;
  private outbox: OutboxEntry[] = [];
  private outboxSeq = 0;
  private stopping = false;
  private loginError = "";
  private retryMs = 2000;
  private reconcileTimer: NodeJS.Timeout | null = null;
  ready = false;

  constructor(private cfg:Config, private store:Store, private log:Log) {}

  private createClient(): Client {
    const client = new Client({ intents:[GatewayIntentBits.Guilds,GatewayIntentBits.DirectMessages,GatewayIntentBits.DirectMessageReactions,GatewayIntentBits.MessageContent], partials:[Partials.Channel,Partials.Message,Partials.Reaction] });
    client.once("clientReady", async () => {
      this.ready = true;
      this.loginError = "";
      this.retryMs = 2000;
      this.log.info("Discord Gateway ready", {bot:client.user?.id});
      this.startReconcileTimer();
      await this.reconcile();
    });
    client.on("messageCreate", m => void this.onMessage(m));
    client.on("messageReactionAdd", (r,u) => void this.onReaction(r,u));
    client.on("interactionCreate", i => void this.onInteraction(i));
    client.on("error", e => this.log.error("Discord client error", {error:e.message}));
    return client;
  }

  /**
   * A prompt send can fail after the workflow already advanced (network blip, container restart in
   * the window). Rather than waiting for the next shot to trigger reconcile(), re-check every 30 s so
   * a stalled flow re-sends its prompt on its own.
   */
  private startReconcileTimer():void {
    if (this.reconcileTimer) return;
    this.reconcileTimer=setInterval(()=>{ if (this.ready) void this.reconcile(); },30_000);
    this.reconcileTimer.unref();
  }

  async start():Promise<void> {
    if (this.cfg.dryRun) {
      // No Gateway connection: the HTTP API plus the dev endpoints are the whole surface under test.
      this.ready=true;
      this.log.warn("DRY RUN: Discord login skipped; messages are recorded, never sent");
      this.startReconcileTimer();
      await this.reconcile();
      return;
    }
    this.stopping=false;
    void this.loginLoop();
  }

  private async loginLoop():Promise<void> {
    while (!this.stopping) {
      const client=this.createClient();
      this.client=client;
      try {
        await client.login(this.cfg.DISCORD_BOT_TOKEN);
        return; // the "ready" handler flips this.ready
      } catch(e) {
        this.ready=false;
        this.loginError=describeDiscordError(e);
        this.client=null;
        try { client.destroy(); } catch { /* already dead */ }
        const waitMs=this.retryMs;
        this.log.error("Discord login failed; keeping the API up and retrying",{error:this.loginError,retryInSeconds:Math.round(waitMs/1000)});
        await this.interruptibleSleep(waitMs);
        this.retryMs=Math.min(this.retryMs*2,300_000);
      }
    }
  }

  private async interruptibleSleep(ms:number):Promise<void> {
    const until=Date.now()+ms;
    while (!this.stopping && Date.now()<until) await new Promise(r=>setTimeout(r,Math.min(250,until-Date.now())));
  }

  status():{ready:boolean;error:string} { return {ready:this.ready,error:this.loginError}; }

  async stop():Promise<void> { this.stopping=true; this.ready=false; if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer=null; } if (this.cfg.dryRun) return; try { this.client?.destroy(); } catch { /* already dead */ } this.client=null; }

  private requireClient():Client {
    if (!this.client) throw new Error("Discord is not connected");
    return this.client;
  }

  outboxSnapshot():OutboxEntry[] { return [...this.outbox]; }
  clearOutbox():void { this.outbox=[]; }

  /**
   * Called by the display's "Test" button (and by curl): sends one clearly-labelled DM to each
   * configured user with a button on it. Delivery proves the bot can DM the user; tapping the button
   * proves interactions reach the bot — the two things every real shot flow depends on.
   */
  async sendTestMessage():Promise<{userId:string;delivered:boolean;error?:string}[]> {
    const results:{userId:string;delivered:boolean;error?:string}[]=[];
    for (const userId of this.cfg.userIds) {
      try { await this.deliver(userId,null,TEST_MESSAGE,[[{customId:TEST_BUTTON_ID,label:"✅ Tap to confirm buttons work",primary:true}]]); results.push({userId,delivered:true}); }
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
      // A superseded flow's prompt would otherwise keep live buttons that ack a tap and then do
      // nothing (its message id no longer anchors any workflow). Retire them.
      for (const old of this.store.listWorkflows(["superseded"])) {
        if (old.userId === w.userId && old.channelId && old.currentMessageId) {
          void this.removeButtons(old.channelId, old.currentMessageId);
          old.currentMessageId=null; this.store.saveWorkflow(old);
        }
      }
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
      "Let's log it — tap the buttons under each prompt, or just reply.";
  }
  private async sendStep(w:Workflow):Promise<void> {
    if (w.step >= STEPS.length) { await this.finish(w); return; }
    const sent=await this.deliver(w.userId,w.channelId,stepMessage(w),stepButtons(w));
    w.channelId=sent.channelId; w.currentMessageId=sent.messageId; this.store.saveWorkflow(w);
  }
  /**
   * Single send path: real DM in production, in-memory outbox under dry-run. Buttons travel in the
   * same request as the text, so a prompt is interactive the instant it appears (reactions had to be
   * added one REST call at a time and Discord rate-limits those to ~4/s).
   */
  private async deliver(userId:string,channelId:string|null,content:string,buttons:StepButton[][]):Promise<{channelId:string;messageId:string}> {
    if (this.cfg.dryRun) {
      const channel=channelId ?? `dry-dm-${userId}`;
      const messageId=`dry-msg-${++this.outboxSeq}`;
      const flat=buttons.flat().map(b=>({customId:b.customId,label:b.label}));
      this.outbox.push({seq:this.outboxSeq,userId,channelId:channel,messageId,content,buttons:flat,at:new Date().toISOString()});
      if (this.outbox.length>100) this.outbox.shift();
      this.log.info("DRY RUN message",{to:userId,messageId,buttons:flat.map(b=>b.label),content});
      return {channelId:channel,messageId};
    }
    const client=this.requireClient();
    // users.createDM(id) opens (or returns the cached) DM in one call; fetching the user first was a
    // second round-trip on every new conversation. If a stored channel id fails to resolve (e.g.
    // after a restart it is no longer cached and the GET fails), fall back to reopening the DM
    // rather than retrying the same failing fetch forever.
    const channel=(channelId ? await client.channels.fetch(channelId).catch(()=>null) : null) ?? await client.users.createDM(userId);
    if (!channel?.isSendable()) throw new Error("DM channel unavailable");
    const components=buttons.map(row=>new ActionRowBuilder<ButtonBuilder>().addComponents(
      row.map(b=>new ButtonBuilder().setCustomId(b.customId).setLabel(clipUnits(b.label,80)).setStyle(b.primary?ButtonStyle.Primary:ButtonStyle.Secondary))));
    const message=await channel.send({content,components});
    return {channelId:channel.id,messageId:message.id};
  }
  /** Remove the buttons from a prompt that has been answered, so a stale tap cannot happen. */
  private async removeButtons(channelId:string,messageId:string):Promise<void> {
    try {
      if (this.cfg.dryRun) { const entry=this.outbox.find(m=>m.messageId===messageId); if (entry) { entry.buttons=[]; entry.buttonsRemoved=true; } return; }
      const channel=await this.requireClient().channels.fetch(channelId);
      if (!channel?.isSendable()) return;
      await channel.messages.edit(messageId,{components:[]});
    } catch(e) { this.log.debug("Could not remove buttons from an answered prompt",{messageId,error:safeError(e)}); }
  }
  private async onInteraction(interaction:Interaction):Promise<void> {
    if (!interaction.isButton()) return;
    if (interaction.customId === TEST_BUTTON_ID) {
      try { await interaction.update({content:TEST_DONE_MESSAGE,components:[]}); }
      catch(e) { this.log.warn("Could not acknowledge the test button",{error:safeError(e)}); }
      return;
    }
    const action=actionFromCustomId(interaction.customId);
    // Acknowledge within Discord's 3 s window no matter what, or the user sees "This interaction failed".
    try { await interaction.deferUpdate(); } catch { /* expired or already acknowledged */ }
    if (!action) return;
    await this.handleUserAction(interaction.user.id, interaction.message.id, action);
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
  /** Manually added reactions still work (1️⃣–5️⃣, ↩️, ➡️); they map onto the same actions as the buttons. */
  async handleUserReaction(userId:string,messageId:string,emoji:string):Promise<void> {
    const w=this.store.getActiveByUser(userId);
    if (!w || messageId !== w.currentMessageId) return;
    const action=actionFromEmoji(emoji,w.step); if (!action) return;
    await this.handleUserAction(userId,messageId,action);
  }
  /** Shared by button taps, reactions and the dry-run endpoint. Anchored to the live prompt. */
  async handleUserAction(userId:string,messageId:string,action:StepAction):Promise<void> {
    const w=this.store.getActiveByUser(userId);
    if (!w || messageId !== w.currentMessageId) return;
    if (!this.lock(w)) {
      // Arrived while the previous answer is still being processed (prompt send or AI parse in
      // flight). The buttons stay on the message, so the user can simply tap again.
      this.log.debug("Dropped an action while the workflow was busy",{workflow:w.id,action:action.type});
      return;
    }
    try {
      if (action.type === "rate") { if (w.step === 0) await this.applyPatch(w,{rating:action.value}); return; }
      if (action.type === "reuse") { const patch=patchForReuse(w); if (patch) await this.applyPatch(w,patch); return; }
      await this.skip(w);
    } catch(e) { this.log.warn("Failed to handle action",{workflow:w.id,error:safeError(e)}); }
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
    if (result.answeredCurrent) await this.advance(w,result.next);
  }
  private async skip(w:Workflow):Promise<void> {
    let next=w.step+1; while (next<STEPS.length && (w.answeredMask&(1<<next))) next++;
    await this.advance(w,next);
  }
  /** Move to `next`, send its prompt, then retire the answered prompt's buttons. */
  private async advance(w:Workflow,next:number):Promise<void> {
    const answeredPrompt=w.currentMessageId;
    w.step=next; w.currentMessageId=null; this.store.saveWorkflow(w);
    await this.sendStep(w);
    // Only once the next prompt is out: if that send failed, a stale prompt with live buttons is
    // still better than one with none until the reconcile timer re-sends it.
    if (answeredPrompt && w.channelId) void this.removeButtons(w.channelId,answeredPrompt);
  }
  private async finish(w:Workflow):Promise<void> {
    const recap=w.savedParts.length ? w.savedParts.join(", ") : "nothing recorded";
    const sent=await this.deliver(w.userId,w.channelId,`✅ Shot #${w.shotId} logged: ${recap.slice(0,1900)}.`,[]);
    w.channelId=sent.channelId; w.status="done"; w.currentMessageId=null; this.store.saveWorkflow(w);
  }
  private async consumeExistingReaction(w:Workflow):Promise<void> {
    if (this.cfg.dryRun || !w.channelId || !w.currentMessageId) return;
    try {
      const channel=await this.requireClient().channels.fetch(w.channelId); if (!channel?.isTextBased()) return;
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

/** Turns a Discord login failure into something the user can act on. */
export function describeDiscordError(e:unknown):string {
  const raw=e instanceof Error?e.message:String(e);
  const text=raw.toLowerCase();
  if(text.includes("disallowed intent")||text.includes("disallowed intent(s)"))
    return "Discord rejected the requested intents: enable Message Content Intent in the Discord Developer Portal (your app -> Bot -> Privileged Gateway Intents), then restart the container";
  if(text.includes("invalid token")||text.includes("4014")||text.includes("unauthorized"))
    return "Discord rejected the bot token: reset it in the Developer Portal (Bot -> Reset Token) and update DISCORD_BOT_TOKEN";
  if(text.includes("enotfound")||text.includes("eai_again")||text.includes("etimedout")||text.includes("fetch failed"))
    return "Could not reach Discord; check the container's DNS and internet access";
  return raw.slice(0,300);
}
