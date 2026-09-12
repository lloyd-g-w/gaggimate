import { describe,expect,it } from "vitest";
import { createApp } from "../src/server.js";
import { Store } from "../src/db.js";
import { logger } from "../src/logger.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import type { Config } from "../src/config.js";
import type { DiscordBot } from "../src/discordBot.js";

const TOKEN="0123456789abcdef0123456789abcdef";
const dirs:string[]=[];
function make() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gaggibot-api-")); dirs.push(dir);
  const store=new Store(dir);
  const ingested:number[]=[];
  const bot={ready:true,createForShot:(p:{shot:{id:number}})=>{ingested.push(p.shot.id);}} as unknown as DiscordBot;
  const cfg={GAGGIBOT_SHARED_TOKEN:TOKEN} as unknown as Config;
  return {app:createApp(cfg,store,bot,logger("error")),store,ingested};
}
function listen(app:ReturnType<typeof createApp>) {
  const server=app.listen(0);
  const port=(server.address() as {port:number}).port;
  return {server,url:`http://127.0.0.1:${port}`};
}
function post(url:string,body:unknown,token=TOKEN) {
  return fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
}
const shotBody=(id=1)=>({deviceId:"machine",shot:{id,profile:"Default",duration:28.4,weight:36.2,temperature:93,pressure:9.1,flow:1.8},
  // The display sends explicit nulls for fields it has no value for.
  previous:{rating:null,grindSetting:"3.5",doseIn:null,doseOut:null,beanType:null,notes:null}});

describe("bridge API",()=>{
  it("accepts the display payload with null previous fields",async()=>{
    const {app,store,ingested}=make();
    const {server,url}=listen(app);
    try {
      const res=await post(`${url}/api/v1/shots`,shotBody(7));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({accepted:true,created:true});
      expect(ingested).toEqual([7]);
      // Idempotent on device + shot id.
      const again=await post(`${url}/api/v1/shots`,shotBody(7));
      expect(again.status).toBe(200);
      expect((await again.json()).created).toBe(false);
      expect(ingested).toEqual([7]);
      void store;
    } finally { server.close(); }
  });
  it("tolerates the notes format the shot-notes UI actually writes",async()=>{
    const {app,store}=make();
    const {server,url}=listen(app);
    try {
      // The web UI stores rating 0 for "unrated" and keeps doses as strings. Rejecting these would
      // wedge the display's upload queue permanently, since it retries the same shot forever.
      const res=await post(`${url}/api/v1/shots`,{...shotBody(21),previous:{rating:0,doseIn:"18.0",doseOut:"36.0",grindSetting:"",beanType:"  ",notes:null}});
      expect(res.status).toBe(202);
      const stored=store.getShot("machine",21);
      expect(stored?.previous).toEqual({doseIn:18,doseOut:36});
    } finally { server.close(); }
  });
  it("clamps unusable previous values instead of failing the upload",async()=>{
    const {app,store}=make();
    const {server,url}=listen(app);
    try {
      const res=await post(`${url}/api/v1/shots`,{...shotBody(22),previous:{rating:9,doseIn:"nonsense",doseOut:-4,beanType:"Guji",notes:"x".repeat(3000)}});
      expect(res.status).toBe(202);
      const stored=store.getShot("machine",22);
      expect(stored?.previous).toEqual({beanType:"Guji",notes:"x".repeat(1500)});
    } finally { server.close(); }
  });
  it("requires a bearer token",async()=>{
    const {app}=make();
    const {server,url}=listen(app);
    try {
      expect((await post(`${url}/api/v1/shots`,shotBody(9),"wrong-token-but-same-length-000000")).status).toBe(401);
      expect((await fetch(`${url}/api/v1/feedback/machine?after=0`)).status).toBe(401);
    } finally { server.close(); }
  });
  it("reports events with a durable acknowledgement watermark",async()=>{
    const {app,store}=make();
    const {server,url}=listen(app);
    try {
      await post(`${url}/api/v1/shots`,shotBody(11));
      const a=store.queuePatch("machine",11,{rating:4});
      const b=store.queuePatch("machine",11,{grindSetting:"3.2"});
      const first=await (await fetch(`${url}/api/v1/feedback/machine?after=0`,{headers:{authorization:`Bearer ${TOKEN}`}})).json();
      expect(first).toEqual({events:[{id:a,shotId:11,patch:{rating:4}},{id:b,shotId:11,patch:{grindSetting:"3.2"}}],through:0});
      const ack=await post(`${url}/api/v1/feedback/machine/ack`,{through:b});
      expect(ack.status).toBe(204);
      const second=await (await fetch(`${url}/api/v1/feedback/machine?after=${b}`,{headers:{authorization:`Bearer ${TOKEN}`}})).json();
      expect(second.events).toEqual([]);
      expect(second.through).toBe(b);
      // A rebooted display asks with after=0 and must be told what was already applied.
      const rebooted=await (await fetch(`${url}/api/v1/feedback/machine?after=0`,{headers:{authorization:`Bearer ${TOKEN}`}})).json();
      expect(rebooted.through).toBe(b);
    } finally { server.close(); }
  });
  it("bounds the feedback page by bytes so the queue cannot deadlock",async()=>{
    const {app,store}=make();
    const {server,url}=listen(app);
    try {
      await post(`${url}/api/v1/shots`,shotBody(31));
      // Long notes answers are legitimate; a page of them must still fit the display's 16 KiB cap.
      for (let i=0;i<40;i++) store.queuePatch("machine",31,{notes:`${i}:`+"y".repeat(1400)});
      const page=await (await fetch(`${url}/api/v1/feedback/machine?after=0`,{headers:{authorization:`Bearer ${TOKEN}`}})).json();
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(16_384);
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.events.length).toBeLessThan(40);
      // The returned page is contiguous from the cursor, so acknowledging it always makes progress.
      expect(page.events[0].id).toBe(1);
    } finally { server.close(); }
  });
  it("answers an oversized body with 413",async()=>{
    const {app}=make();
    const {server,url}=listen(app);
    try {
      const res=await fetch(`${url}/api/v1/shots`,{method:"POST",headers:{authorization:`Bearer ${TOKEN}`,"content-type":"application/json"},body:JSON.stringify({padding:"z".repeat(40_000)})});
      expect(res.status).toBe(413);
    } finally { server.close(); }
  });
  it("exposes health without authentication",async()=>{
    const {app}=make();
    const {server,url}=listen(app);
    try { expect((await fetch(`${url}/health`)).status).toBe(200); } finally { server.close(); }
  });
});
