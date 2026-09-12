import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createApp } from "../src/server.js";
import { Store } from "../src/db.js";
import { DiscordBot } from "../src/discordBot.js";
import { logger } from "../src/logger.js";
import type { Config } from "../src/config.js";

/**
 * End-to-end conversation test with no Discord account: the bot runs in dry-run mode, so every
 * message it would send is recorded in its outbox and replies/button taps are injected through the
 * dev endpoints. This exercises the real state machine, the real SQLite store and the real HTTP API.
 */
const TOKEN="0123456789abcdef0123456789abcdef";
type Embed={title:string;description?:string;fields:{name:string;value:string}[];footer?:{text:string}};
type Msg={content:string;embed?:Embed;buttons:{customId:string;label:string}[];deleted?:boolean;messageId:string};
// Everything visible on a card, flattened, so tests can grep it like the old plain-text prompts.
const text=(m:Msg)=>[m.content,m.embed?.title,m.embed?.description,...(m.embed?.fields.flatMap(f=>[f.name,f.value])??[]),m.embed?.footer?.text].filter(Boolean).join("\n");
const isStep=(m:Msg)=>/Step \d+ of \d+/.test(text(m));
const labels=(m:Msg)=>m.buttons.map(b=>b.label);
const ids=(m:Msg)=>m.buttons.map(b=>b.customId);
const USER="100000000000000000";
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));

function harness() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gaggibot-e2e-")); dirs.push(dir);
  const store=new Store(dir);
  const cfg={GAGGIBOT_SHARED_TOKEN:TOKEN,dryRun:true,userIds:[USER],AI_URL:"",AI_API_KEY:"",AI_MODEL:"gpt-4o-mini",DataDir:dir} as unknown as Config;
  const bot=new DiscordBot(cfg,store,logger("error"));
  const app=createApp(cfg,store,bot,logger("error"));
  const server=app.listen(0);
  const port=(server.address() as {port:number}).port;
  const base=`http://127.0.0.1:${port}`;
  const call=(p:string,body?:unknown)=>{
    const headers={authorization:`Bearer ${TOKEN}`,"content-type":"application/json"};
    return body===undefined?fetch(`${base}${p}`,{headers}):fetch(`${base}${p}`,{method:"POST",headers,body:JSON.stringify(body)});
  };
  const outbox=async()=>((await (await call("/api/v1/_dev/outbox")).json()) as {messages:Msg[]}).messages;
  return {server,store,bot,call,outbox,base};
}
const shot=(id:number,previous={})=>({deviceId:"machine",shot:{id,profile:"Direct Lever",duration:28.4,weight:36.2,temperature:93,pressure:9.1,flow:1.8},previous});
const flush=()=>new Promise(resolve=>setTimeout(resolve,50));

describe("gaggibot conversation (dry run)",()=>{
  it("walks a full shot through every step and queues one event per answer",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/shots",shot(224));
      await flush();

      let messages=await h.outbox();
      expect(messages).toHaveLength(1); // one card: summary + step 1 together
      expect(text(messages[0]!)).toContain("Shot #224");
      expect(text(messages[0]!)).toContain("Step 1 of 6 — Rate this shot");
      // Buttons arrive with the card itself: 1-5 plus skip (no previous rating, so no reuse).
      expect(ids(messages[0]!)).toEqual(["gm:rate:1","gm:rate:2","gm:rate:3","gm:rate:4","gm:rate:5","gm:skip"]);
      expect(text(messages[0]!)).toContain("Tap **1–5** below or send a number from *1 to 5*.");

      // Rate by tapping a button, then answer the rest by text.
      expect((await h.call("/api/v1/_dev/press",{customId:"gm:rate:4"})).status).toBe(202);
      await flush();
      await h.call("/api/v1/_dev/reply",{text:"3.2"});          // grind
      await flush();
      await h.call("/api/v1/_dev/reply",{text:"18"});           // dose in
      await flush();
      await h.call("/api/v1/_dev/reply",{text:"Ethiopia Guji"});// bean
      await flush();
      await h.call("/api/v1/_dev/press",{customId:"gm:taste:sour"}); // balance / taste
      await flush();
      await h.call("/api/v1/_dev/reply",{text:"bright, a bit sour"});
      await flush();

      messages=await h.outbox();
      const cards=messages.filter(isStep);
      expect(cards.map(c=>c.embed!.fields[0]!.name)).toEqual([
        "Step 1 of 6 — Rate this shot","Step 2 of 6 — Grind","Step 3 of 6 — Dose in","Step 4 of 6 — Bean","Step 5 of 6 — Balance / taste","Step 6 of 6 — Note"
      ]);
      // Every card was deleted once its successor was out, so only the result remains.
      for (const c of cards) expect(c.deleted).toBe(true);
      const result=messages.at(-1)!;
      expect(result.deleted).toBeUndefined();
      expect(result.embed!.title).toBe("✅ Shot #224  ·  Direct Lever");
      const byName=Object.fromEntries(result.embed!.fields.map(f=>[f.name,f.value]));
      expect(byName["⭐ Rating"]).toBe("★★★★☆  4/5");
      expect(byName["👅 Balance"]).toBe("🍋 Sour");
      expect(byName["📝 Notes"]).toBe("bright, a bit sour");
      // The "recorded so far" line accumulated as the flow progressed.
      expect(text(cards[5]!)).toContain("⭐ 4/5  ·  🔧 3.2  ·  ⚖️ 18 g  ·  🫘 Ethiopia Guji  ·  👅 🍋 Sour");
      // Doses are queued as strings so the display recomputes ratio and index volume.
      const events=await (await h.call("/api/v1/feedback/machine?after=0")).json() as {events:{patch:Record<string,unknown>}[];through:number};
      expect(events.events.map(e=>e.patch)).toEqual([
        {rating:4},{grindSetting:"3.2"},{doseIn:"18"},{beanType:"Ethiopia Guji"},{balanceTaste:"sour"},{notes:"bright, a bit sour"}
      ]);
      expect(events.through).toBe(0);

      // The display applies and acknowledges; the watermark then reports what it consumed.
      const last=events.events.at(-1) as unknown as {id:number};
      expect((await h.call("/api/v1/feedback/machine/ack",{through:last.id})).status).toBe(204);
      const after=await (await h.call(`/api/v1/feedback/machine?after=${last.id}`)).json() as {events:unknown[];through:number};
      expect(after.events).toEqual([]);
      expect(after.through).toBe(last.id);
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("offers reuse from the previous shot and saves it on ↩️",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/shots",shot(300,{rating:3,grindSetting:"3.5",doseIn:"18.0",beanType:"Guji",notes:"older"}));
      await flush();
      await h.call("/api/v1/_dev/press",{customId:"gm:skip"}); // skip rating
      await flush();

      const cards=(await h.outbox()).filter(isStep);
      const grind=cards.at(-1)!;
      expect(text(grind)).toContain("Step 2 of 6 — Grind");
      expect(text(grind)).toContain("Your last shot was *3.5*");   // previous value shown
      expect(labels(grind)).toEqual(["↩️ Reuse 3.5","➡️ Skip"]);      // reuse + skip, no rating buttons

      await h.call("/api/v1/_dev/press",{customId:"gm:reuse"});
      await flush();
      const events=await (await h.call("/api/v1/feedback/machine?after=0")).json() as {events:{patch:Record<string,unknown>}[]};
      expect(events.events.map(e=>e.patch)).toEqual([{grindSetting:"3.5"}]);
      // Nothing was saved for the skipped rating.
      expect(events.events.some(e=>"rating" in e.patch)).toBe(false);
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("offers reuse on the rating step when the last shot was rated",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/shots",shot(310,{rating:1}));
      await flush();
      const rating=(await h.outbox()).filter(isStep).at(-1)!;
      expect(text(rating)).toContain("Your last shot was rated *1/5*.");
      expect(text(rating)).toContain("*1–5 to rate · ↩️ to reuse *1/5* · ➡️ to skip*");
      expect(labels(rating)).toEqual(["1","2","3","4","5","↩️ Reuse 1/5","➡️ Skip"]);

      await h.call("/api/v1/_dev/press",{customId:"gm:reuse"});
      await flush();
      const events=await (await h.call("/api/v1/feedback/machine?after=0")).json() as {events:{patch:Record<string,unknown>}[]};
      expect(events.events.map(e=>e.patch)).toEqual([{rating:1}]);
      // and the flow moved on to grind
      expect(text((await h.outbox()).filter(isStep).at(-1)!)).toContain("Step 2 of 6 — Grind");
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("still accepts a manually added reaction",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/shots",shot(320));
      await flush();
      await h.call("/api/v1/_dev/react",{emoji:"3️⃣"});
      await flush();
      const events=await (await h.call("/api/v1/feedback/machine?after=0")).json() as {events:{patch:Record<string,unknown>}[]};
      expect(events.events.map(e=>e.patch)).toEqual([{rating:3}]);
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("never offers reuse on the note step",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/shots",shot(400,{rating:5,grindSetting:"2",doseIn:"18.0",beanType:"Guji",balanceTaste:"bitter",notes:"a previous note"}));
      await flush();
      for (const _ of [0,1,2,3,4]) { await h.call("/api/v1/_dev/press",{customId:"gm:skip"}); await flush(); }
      const note=(await h.outbox()).filter(isStep).at(-1)!;
      expect(text(note)).toContain("Step 6 of 6 — Note");
      expect(labels(note)).toEqual(["➡️ Skip"]);
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("answers several steps at once and skips the ones already filled",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/shots",shot(500));
      await flush();
      await h.call("/api/v1/_dev/reply",{text:"rating: 5 | in: 18\nbean: Kenya AA"});
      await flush();
      const cards=(await h.outbox()).filter(isStep);
      // rating and dose in are answered, so the next card is grind, then bean is skipped after it.
      expect(text(cards.at(-1)!)).toContain("Step 2 of 6 — Grind");
      await h.call("/api/v1/_dev/reply",{text:"3.1"});
      await flush();
      const after=(await h.outbox()).filter(isStep);
      expect(text(after.at(-1)!)).toContain("Step 5 of 6 — Balance / taste");
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("supersedes an unfinished flow when a newer shot arrives",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/shots",shot(600));
      await flush();
      await h.call("/api/v1/shots",shot(601));
      await flush();
      const state=await (await h.call("/api/v1/_dev/state")).json() as {workflows:{shotId:number;status:string}[]};
      expect(state.workflows.map(w=>w.shotId)).toEqual([601]); // the older flow is superseded, not doubled
      // The superseded card was taken down, so a stale tap can't ack-and-do-nothing.
      const cards=(await h.outbox()).filter(isStep);
      expect(text(cards[0]!)).toContain("Shot #600");
      expect(cards[0]!.deleted).toBe(true);
      expect(text(cards.at(-1)!)).toContain("Shot #601");
      expect(cards.at(-1)!.buttons.length).toBeGreaterThan(0);
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("rejects dev endpoints without the bearer token",async()=>{
    const h=harness();
    try {
      const res=await fetch(`${h.base}/api/v1/_dev/outbox`);
      expect(res.status).toBe(401);
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("sends a test message to every configured user via POST /api/v1/test",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      await h.call("/api/v1/_dev/outbox/clear",{});
      const res=await h.call("/api/v1/test",{});
      expect(res.status).toBe(200);
      const body=await res.json() as {ok:boolean;dryRun:boolean;results:{userId:string;delivered:boolean}[]};
      expect(body.ok).toBe(true);
      expect(body.dryRun).toBe(true);
      expect(body.results).toEqual([{userId:USER,delivered:true}]);
      const messages=await h.outbox();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.embed!.title).toContain("Gaggibot test");
      // The button proves interactions reach the bot, which is how every real step is answered.
      expect(ids(messages[0]!)).toEqual(["gm:test"]);
      // A test must never be recorded as shot feedback.
      const events=await (await h.call("/api/v1/feedback/machine?after=0")).json() as {events:unknown[]};
      expect(events.events).toEqual([]);
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("reports the ping probe without touching Discord",async()=>{
    const h=harness();
    try {
      await h.bot.start();
      const body=await (await h.call("/api/v1/ping")).json() as {ok:boolean;discord:boolean;users:number};
      expect(body).toEqual({ok:true,dryRun:true,discord:true,reason:"",users:1});
    } finally { h.server.close(); await h.bot.stop(); }
  });

  it("stays up and explains itself when Discord is unavailable",async()=>{
    // Reproduces the field failure: the bot never becomes ready. The API must keep serving a
    // diagnosable response instead of the container exiting and restarting in a loop.
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gaggibot-nodiscord-")); dirs.push(dir);
    const store=new Store(dir);
    const cfg={GAGGIBOT_SHARED_TOKEN:TOKEN,dryRun:false,userIds:[USER]} as unknown as Config;
    const bot=new DiscordBot(cfg,store,logger("error"));
    const app=createApp(cfg,store,bot,logger("error"));
    const server=app.listen(0);
    const port=(server.address() as {port:number}).port;
    const base=`http://127.0.0.1:${port}`;
    const auth={authorization:`Bearer ${TOKEN}`,"content-type":"application/json"};
    try {
      // Not started at all: equivalent to a login that never succeeds.
      const health=await fetch(`${base}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ok:false,discord:false,database:true,dryRun:false});

      const test=await fetch(`${base}/api/v1/test`,{method:"POST",headers:auth,body:"{}"});
      expect(test.status).toBe(503);
      expect(await test.json()).toMatchObject({ok:false,error:"discord_not_ready"});
    } finally { server.close(); await bot.stop(); }
  });
});
