import { Client, GatewayIntentBits, Partials, type Message, type MessageReaction, type PartialMessageReaction, type User, type PartialUser } from "discord.js";
import type { Config } from "./config.js";
import { applyFields, fieldsIn, patchForReuse, RATING_EMOJIS, REUSE_EMOJI, savedPart, SKIP_EMOJI, stepMessage } from "./flow.js";
import { parseReply, parseWithAi } from "./parser.js";
import { STEPS, type NotesPatch, type ShotPayload, type Workflow } from "./types.js";
import type { Store } from "./db.js";

type Log = ReturnType<typeof import("./logger.js").logger>;
export class DiscordBot {
  private client = new Client({ intents:[GatewayIntentBits.Guilds,GatewayIntentBits.DirectMessages,GatewayIntentBits.DirectMessageReactions,GatewayIntentBits.MessageContent], partials:[Partials.Channel,Partials.Message,Partials.Reaction] });
  private locks = new Set<number>();
  private reconciling = false;
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
  async start():Promise<void> { await this.client.login(this.cfg.DISCORD_BOT_TOKEN); }
  async stop():Promise<void> { this.ready=false; this.client.destroy(); }

  createForShot(payload:ShotPayload):void {
    for (const user of this.cfg.userIds) this.store.prepareWorkflow(payload.deviceId,payload.shot.id,user,payload.previous);
    if (this.ready) void this.reconcile();
  }
  private async reconcile():Promise<void> {
    // reconcile() runs on ready and after every ingest; a single in-flight pass keeps two
    // overlapping passes from starting the same queued workflow twice.
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const w of this.store.listWorkflows(["queued"])) await this.startWorkflow(w);
      // Workflows retain their current Discord message across service restarts. No prompt is duplicated.
      for (const w of this.store.listWorkflows(["active"])) await this.consumeExistingReaction(w);
    } finally { this.reconciling = false; }
  }
  private async startWorkflow(w:Workflow):Promise<void> {
    if (!this.lock(w)) return;
    try {
      this.store.supersedeOtherWorkflows(w.userId,w.id);
      const user=await this.client.users.fetch(w.userId);
      const dm=await user.createDM();
      w.channelId=dm.id; w.status="active";
      const payload=this.store.getShot(w.deviceId,w.shotId); if (!payload) throw new Error("shot missing");
      await dm.send({content:this.summary(payload).slice(0,2000)});
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
  private async sendStep(w:Workflow):Promise<void> {
    if (!w.channelId) throw new Error("workflow has no DM channel");
    if (w.step >= STEPS.length) { await this.finish(w); return; }
    const channel=await this.client.channels.fetch(w.channelId);
    if (!channel?.isSendable()) throw new Error("DM channel unavailable");
    const message=await channel.send({content:stepMessage(w)});
    w.currentMessageId=message.id; this.store.saveWorkflow(w);
    const field=STEPS[w.step];
    if (field === "rating") for (const emoji of RATING_EMOJIS) await message.react(emoji);
    else if (field !== "notes" && w.lastValues[field!] !== undefined) await message.react(REUSE_EMOJI);
    await message.react(SKIP_EMOJI);
  }
  private async onMessage(message:Message):Promise<void> {
    if (message.author.bot || message.guildId || !message.content.trim()) return;
    const w=this.store.getActiveByUser(message.author.id); if (!w || !this.lock(w)) return;
    try {
      const current=STEPS[w.step]; if (!current) return;
      let patch:NotesPatch|null=null;
      if (this.cfg.AI_URL) patch=await parseWithAi(message.content,current,{url:this.cfg.AI_URL,key:this.cfg.AI_API_KEY,model:this.cfg.AI_MODEL});
      patch=patch ?? parseReply(message.content,current);
      await this.applyPatch(w,patch);
    } catch(e) { this.log.warn("Failed to handle Discord message",{workflow:w.id,error:safeError(e)}); }
    finally { this.unlock(w); }
  }
  private async onReaction(reaction:MessageReaction|PartialMessageReaction,user:User|PartialUser):Promise<void> {
    if (user.bot) return;
    try { if (reaction.partial) await reaction.fetch(); } catch { return; }
    const w=this.store.getActiveByUser(user.id);
    if (!w || reaction.message.id !== w.currentMessageId || !this.lock(w)) return;
    try {
      const emoji=reaction.emoji.name ?? "";
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
    const fields=fieldsIn(patch);
    if (!fields.length && patch.doseOut === undefined) return;
    for (const field of [...fields,...(patch.doseOut !== undefined ? ["doseOut" as const] : [])]) {
      const value=patch[field]; if (value === undefined) continue;
      this.store.queuePatch(w.deviceId,w.shotId,{[field]:value});
      w.savedParts.push(savedPart(field,value));
    }
    const result=applyFields(w,patch); this.store.saveWorkflow(w);
    if (result.answeredCurrent) { w.step=result.next; w.currentMessageId=null; this.store.saveWorkflow(w); await this.sendStep(w); }
  }
  private async skip(w:Workflow):Promise<void> {
    let next=w.step+1; while (next<STEPS.length && (w.answeredMask&(1<<next))) next++;
    w.step=next; w.currentMessageId=null; this.store.saveWorkflow(w); await this.sendStep(w);
  }
  private async finish(w:Workflow):Promise<void> {
    if (!w.channelId) return;
    const channel=await this.client.channels.fetch(w.channelId); if (!channel?.isSendable()) throw new Error("DM channel unavailable");
    const recap=w.savedParts.length ? w.savedParts.join(", ") : "nothing recorded";
    await channel.send({content:`✅ Shot #${w.shotId} logged: ${recap.slice(0,1900)}.`});
    w.status="done"; w.currentMessageId=null; this.store.saveWorkflow(w);
  }
  private async consumeExistingReaction(w:Workflow):Promise<void> {
    if (!w.channelId || !w.currentMessageId) return;
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
