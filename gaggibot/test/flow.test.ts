import { describe,expect,it } from "vitest";
import { applyFields,asNotesValue,normalizePatch,patchForReuse } from "../src/flow.js";
import type { Workflow } from "../src/types.js";
const workflow=():Workflow=>({id:1,deviceId:"machine",shotId:7,userId:"1",channelId:"2",step:0,answeredMask:0,currentMessageId:null,lastValues:{grindSetting:"3.5"},savedParts:[],status:"active"});
describe("sequential state",()=>{
  it("does not leave current step when only a future field is answered",()=>{const w=workflow();expect(applyFields(w,{beanType:"Guji"})).toEqual({answeredCurrent:false,next:0});expect(w.answeredMask).toBe(8);});
  it("skips fields already answered by an earlier multi-field response",()=>{const w=workflow();applyFields(w,{grindSetting:"3.2",beanType:"Guji"});const r=applyFields(w,{rating:4});expect(r).toEqual({answeredCurrent:true,next:2});w.step=2;expect(applyFields(w,{doseIn:18})).toEqual({answeredCurrent:true,next:4});});
  it("reuses previous value but never a previous note",()=>{const w=workflow();w.step=1;expect(patchForReuse(w)).toEqual({grindSetting:"3.5"});w.step=4;w.lastValues.notes="old";expect(patchForReuse(w)).toBeNull();});
});

describe("wire values",()=>{
  it("sends doses as strings so the display recomputes ratio and index volume",()=>{
    expect(asNotesValue("doseIn",18)).toBe("18");
    expect(asNotesValue("doseOut","36.0")).toBe("36");
    expect(asNotesValue("doseIn",18.456)).toBe("18.46");
  });
  it("drops values the display cannot store",()=>{
    expect(asNotesValue("rating",0)).toBeUndefined();
    expect(asNotesValue("rating","4")).toBe(4);
    expect(asNotesValue("doseIn","nonsense")).toBeUndefined();
    expect(asNotesValue("beanType","   ")).toBeUndefined();
    expect(asNotesValue("notes","n".repeat(3000))).toHaveLength(1500);
  });
  it("normalises the display's own notes format (rating 0, string doses)",()=>{
    expect(normalizePatch({rating:0,doseIn:"18.0",doseOut:"36.0",grindSetting:"",beanType:"Guji"} as never))
      .toEqual({doseIn:"18",doseOut:"36",beanType:"Guji"});
  });
});
