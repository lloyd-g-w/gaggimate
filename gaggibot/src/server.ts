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
