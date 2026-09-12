import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Config } from "./config.js";
import type { DiscordBot } from "./discordBot.js";
import type { Store } from "./db.js";

type Log = ReturnType<typeof import("./logger.js").logger>;
const text=z.string().trim().max(200);
const priorText=z.string().trim().max(1500);
// The display sends `previous` with an explicit null for every field it has no value for, so drop
// null/undefined before validation instead of failing the whole upload on a strict object.
const stripNulls=(value:unknown):unknown=>value&&typeof value==="object"&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==null&&v!==undefined))
  :value;
const priorNotes=z.object({rating:z.number().int().min(1).max(5).optional(),grindSetting:priorText.optional(),doseIn:z.number().finite().min(0).max(200).optional(),doseOut:z.number().finite().min(0).max(500).optional(),beanType:priorText.optional(),notes:priorText.optional()}).strict();
const shotSchema=z.object({
  deviceId:z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  shot:z.object({id:z.number().int().nonnegative().max(0xffffffff),profile:text,duration:z.number().finite().min(0).max(3600),weight:z.number().finite().min(-100).max(1000),temperature:z.number().finite().min(0).max(200),pressure:z.number().finite().min(0).max(30),flow:z.number().finite().min(0).max(100)}).strict(),
  previous:z.preprocess(stripNulls,priorNotes).optional().default({})
}).strict();

export function createApp(cfg:Config,store:Store,bot:DiscordBot,log:Log) {
  const app=express();
  app.disable("x-powered-by"); app.set("trust proxy",1); app.use(helmet());
  app.use(express.json({limit:"32kb",strict:true}));
  app.get("/health",(_req,res)=>res.status(bot.ready&&store.healthCheck()?200:503).json({ok:bot.ready&&store.healthCheck(),discord:bot.ready,database:true}));
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
  app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(err instanceof z.ZodError)return res.status(400).json({error:"invalid_request",issues:err.issues.map(i=>({path:i.path.join("."),message:i.message}))});
    if(err instanceof SyntaxError)return res.status(400).json({error:"invalid_json"});
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
