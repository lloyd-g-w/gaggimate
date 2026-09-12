import { afterEach,describe,expect,it } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Store } from "../src/db.js";
const dirs:string[]=[]; afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
function store(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"gaggibot-"));dirs.push(d);return new Store(d);}
const shot={deviceId:"machine",shot:{id:1,profile:"Default",duration:28,weight:36,temperature:93,pressure:9,flow:2},previous:{grindSetting:"3"}};
describe("flow version guard",()=>{
 it("retires in-flight workflows when the step layout changes, but not on a plain restart",()=>{
   const s=store(); s.insertShot(shot);
   expect(s.ensureFlowVersion("a,b,c")).toBe(0);            // first run: nothing to retire
   s.prepareWorkflow("machine",1,"100000000000000000",{});
   const w=s.listWorkflows(["queued"])[0]!; w.status="active"; w.step=3; w.currentMessageId="m1"; s.saveWorkflow(w);
   expect(s.ensureFlowVersion("a,b,c")).toBe(0);            // same layout: untouched
   expect(s.listWorkflows(["active"])).toHaveLength(1);
   expect(s.ensureFlowVersion("a,b,X,c")).toBe(1);          // layout changed: abandoned
   expect(s.listWorkflows(["active","queued"])).toHaveLength(0);
   expect(s.listWorkflows(["superseded"])[0]!.currentMessageId).toBeNull();
   expect(s.ensureFlowVersion("a,b,X,c")).toBe(0);          // and recorded, so the next start is quiet
   s.close();
 });
});

describe("persistent store",()=>{
 it("makes shot ingestion idempotent",()=>{const s=store();expect(s.insertShot(shot)).toBe(true);expect(s.insertShot(shot)).toBe(false);s.close();});
 it("queues ordered feedback and acknowledges it",()=>{const s=store();s.insertShot(shot);const a=s.queuePatch("machine",1,{rating:4});const b=s.queuePatch("machine",1,{doseIn:18});expect(s.getEvents("machine",0)).toEqual([{id:a,shotId:1,patch:{rating:4}},{id:b,shotId:1,patch:{doseIn:18}}]);s.acknowledge("machine",b);s.close();});
});
