import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { actionFromCustomId } from "./flow.js";
import type { Config } from "./config.js";
import type { DiscordBot } from "./discordBot.js";
import type { Store } from "./db.js";

type Log = ReturnType<typeof import("./logger.js").logger>;
const text=z.string().trim().max(200);
const priorText=z.string().trim().max(1500);
// The display's notes file is written by the web UI, which stores `rating: 0` for "unrated" and keeps
// doses as JSON strings ("18.0"). Those values are forwarded verbatim in `previous`, so coerce them
// into the documented shape instead of rejecting the whole upload — a 400 here would wedge the
// device's upload queue permanently, because it retries the same shot forever.
const asRating=(value:unknown):number|undefined=>{const n=Number(value);return Number.isInteger(n)&&n>=1&&n<=5?n:undefined;};
const asDose=(value:unknown,max:number):number|undefined=>{if(value===null||value===undefined||value==="")return undefined;const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=max?n:undefined;};
const asText=(value:unknown,max:number):string|undefined=>{
  if(typeof value==="number"&&Number.isFinite(value))return String(value).slice(0,max);
  if(typeof value!=="string")return undefined;
  const trimmed=value.trim();
  return trimmed?trimmed.slice(0,max):undefined;
};
export const cleanPrevious=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  const src=value as Record<string,unknown>;
  const out:Record<string,unknown>={};
  const rating=asRating(src.rating); if(rating!==undefined)out.rating=rating;
  const doseIn=asDose(src.doseIn,200); if(doseIn!==undefined)out.doseIn=doseIn;
  const doseOut=asDose(src.doseOut,500); if(doseOut!==undefined)out.doseOut=doseOut;
  const grind=asText(src.grindSetting,100); if(grind!==undefined)out.grindSetting=grind;
  const bean=asText(src.beanType,200); if(bean!==undefined)out.beanType=bean;
  const notes=asText(src.notes,1500); if(notes!==undefined)out.notes=notes;
  return out;
};

const priorNotes=z.object({rating:z.number().int().min(1).max(5).optional(),grindSetting:priorText.optional(),doseIn:z.number().finite().min(0).max(200).optional(),doseOut:z.number().finite().min(0).max(500).optional(),beanType:priorText.optional(),notes:priorText.optional()}).strict();
const shotSchema=z.object({
  deviceId:z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  shot:z.object({id:z.number().int().nonnegative().max(0xffffffff),profile:text,duration:z.number().finite().min(0).max(3600),weight:z.number().finite().min(-100).max(1000),temperature:z.number().finite().min(0).max(200),pressure:z.number().finite().min(0).max(30),flow:z.number().finite().min(0).max(100)}).strict(),
  previous:z.preprocess(cleanPrevious,priorNotes).optional().default({})
}).strict();

export function createApp(cfg:Config,store:Store,bot:DiscordBot,log:Log) {
  const app=express();
  app.disable("x-powered-by"); app.set("trust proxy",1); app.use(helmet());
  app.use(express.json({limit:"32kb",strict:true}));
  app.get("/health",(_req,res)=>{
    const status=bot.status();
    const database=store.healthCheck();
    const body:Record<string,unknown>={ok:status.ready&&database,discord:status.ready,database,dryRun:cfg.dryRun};
    // Report *why* Discord is unavailable, so a bad token or a disabled privileged intent is
    // visible without digging through container logs.
    if(!status.ready&&status.error) body.reason=status.error;
    res.status(status.ready&&database?200:503).json(body);
  });
  const limiter=rateLimit({windowMs:60_000,limit:120,standardHeaders:"draft-7",legacyHeaders:false});
  app.use("/api",limiter,authenticate(cfg.GAGGIBOT_SHARED_TOKEN));
  app.post("/api/v1/shots",(req,res,next)=>{
    try { const payload=shotSchema.parse(req.body); const created=store.insertShot(payload); if(created)bot.createForShot(payload); res.status(created?202:200).json({accepted:true,created}); }
    catch(e){next(e);}
  });
  app.get("/api/v1/feedback/:deviceId",(req,res,next)=>{
    try {
      const device=z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).parse(req.params.deviceId);
      const after=z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0).parse(req.query.after);
      // `through` is the durable acknowledgement watermark: a display that rebooted (and lost its
      // in-RAM cursor) adopts it instead of replaying every patch it already applied.
      res.json({events:store.getEvents(device,after),through:store.getAcknowledged(device)});
    }
    catch(e){next(e);}
  });
  app.post("/api/v1/feedback/:deviceId/ack",(req,res,next)=>{
    try { const device=z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).parse(req.params.deviceId); const body=z.object({through:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict().parse(req.body); store.acknowledge(device,body.through); res.status(204).end(); }
    catch(e){next(e);}
  });

  // Connectivity test: sends a real DM to every configured user. Also the endpoint behind the
  // display's "Test" button, so a misconfigured token or missing DM permission is diagnosable
  // without pulling a shot.
  app.post("/api/v1/test",async(_req,res)=>{
    const status=bot.status();
    if(!status.ready) return res.status(503).json({ok:false,error:"discord_not_ready",dryRun:cfg.dryRun,reason:status.error});
    try {
      const results=await bot.sendTestMessage();
      const ok=results.length>0&&results.every(r=>r.delivered);
      if(!ok) log.warn("Test message delivery failed",{failed:results.filter(r=>!r.delivered).length});
      return res.status(ok?200:502).json({ok,dryRun:cfg.dryRun,results});
    } catch(e) {
      log.error("Test message request failed",{error:e instanceof Error?e.message.slice(0,300):"unknown"});
      return res.status(500).json({ok:false,error:"internal_error"});
    }
  });
  // Cheap readiness probe (no Discord call): lets the display distinguish "unreachable/wrong token"
  // from "reachable but Discord is down".
  app.get("/api/v1/ping",(_req,res)=>res.json({ok:true,dryRun:cfg.dryRun,discord:bot.status().ready,reason:bot.status().error,users:cfg.userIds.length}));

  // Dry-run harness: only exists when GAGGIBOT_DRY_RUN=1, and still requires the bearer token. It
  // drives the exact same handlers as Discord events so the state machine can be tested end to end
  // without a bot account, and lets a script read back what the bot would have sent.
  if (cfg.dryRun) {
    app.get("/api/v1/_dev/outbox",(_req,res)=>res.json({messages:bot.outboxSnapshot()}));
    app.post("/api/v1/_dev/outbox/clear",(_req,res)=>{bot.clearOutbox();res.status(204).end();});
    app.post("/api/v1/_dev/reply",(req,res,next)=>{
      try {
        const body=z.object({text:z.string().min(1).max(2000),userId:z.string().regex(/^\d{15,22}$/).optional()}).strict().parse(req.body);
        void bot.handleUserText(body.userId??cfg.userIds[0]!,body.text);
        res.status(202).json({accepted:true});
      } catch(e){next(e);}
    });
    app.post("/api/v1/_dev/react",(req,res,next)=>{
      try {
        const body=z.object({emoji:z.string().min(1).max(32),userId:z.string().regex(/^\d{15,22}$/).optional()}).strict().parse(req.body);
        const userId=body.userId??cfg.userIds[0]!;
        const workflow=store.getActiveByUser(userId);
        if (!workflow?.currentMessageId) return res.status(409).json({error:"no_active_prompt"});
        void bot.handleUserReaction(userId,workflow.currentMessageId,body.emoji);
        res.status(202).json({accepted:true,messageId:workflow.currentMessageId,step:workflow.step});
      } catch(e){next(e);}
    });
    // Tap a button on the current prompt by custom id (gm:rate:4, gm:reuse, gm:skip).
    app.post("/api/v1/_dev/press",(req,res,next)=>{
      try {
        const body=z.object({customId:z.string().min(1).max(64),userId:z.string().regex(/^\d{15,22}$/).optional()}).strict().parse(req.body);
        const userId=body.userId??cfg.userIds[0]!;
        const action=actionFromCustomId(body.customId);
        if (!action) return res.status(400).json({error:"unknown_button"});
        const workflow=store.getActiveByUser(userId);
        if (!workflow?.currentMessageId) return res.status(409).json({error:"no_active_prompt"});
        void bot.handleUserAction(userId,workflow.currentMessageId,action);
        res.status(202).json({accepted:true,messageId:workflow.currentMessageId,step:workflow.step});
      } catch(e){next(e);}
    });
    app.get("/api/v1/_dev/state",(_req,res)=>res.json({workflows:store.listWorkflows(["queued","active"]).map(w=>({id:w.id,userId:w.userId,shotId:w.shotId,step:w.step,status:w.status,answeredMask:w.answeredMask,savedParts:w.savedParts,currentMessageId:w.currentMessageId}))}));
  }
  app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(err instanceof z.ZodError)return res.status(400).json({error:"invalid_request",issues:err.issues.map(i=>({path:i.path.join("."),message:i.message}))});
    // http-errors from body-parser (express.json limit / malformed JSON).
    const status=(err as {status?:number;statusCode?:number;type?:string}|null)?.status??(err as {statusCode?:number}|null)?.statusCode;
    if(status===413||(err as {type?:string}|null)?.type==="entity.too.large")return res.status(413).json({error:"payload_too_large"});
    if(err instanceof SyntaxError||status===400)return res.status(400).json({error:"invalid_json"});
    log.error("Unhandled API error",{error:err instanceof Error?err.message.slice(0,300):"unknown"}); return res.status(500).json({error:"internal_error"});
  });
  return app;
}
function authenticate(expected:string) {
  const expectedBytes=Buffer.from(expected);
  return (req:Request,res:Response,next:NextFunction) => {
    const header=req.header("authorization")??""; const supplied=header.startsWith("Bearer ")?header.slice(7):""; const bytes=Buffer.from(supplied);
    if(bytes.length!==expectedBytes.length || !crypto.timingSafeEqual(bytes,expectedBytes)) return res.status(401).json({error:"unauthorized"});
    next();
  };
}
