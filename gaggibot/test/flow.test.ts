import { describe,expect,it } from "vitest";
import { applyFields,asNotesValue,clipUnits,normalizePatch,patchForReuse,stepButtons } from "../src/flow.js";
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

// tsconfig targets ES2022, which predates String.prototype.isWellFormed; a lone surrogate is any
// high surrogate not followed by a low one, or a low surrogate not preceded by a high one.
const wellFormed=(s:string)=>!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(s);

describe("button labels",()=>{
  it("never splits a surrogate pair when clipping",()=>{
    // "🇪🇹" is two regional-indicator code points = 4 UTF-16 units; a naive slice at 3 would leave a lone high surrogate.
    const s="ab"+"\u{1F1EA}\u{1F1F9}"+"cd";
    const clipped=clipUnits(s,3);
    expect(clipped).toBe("ab");                    // dropped the whole pair rather than half of it
    expect(clipUnits(s,4)).toBe("ab\u{1F1EA}");     // a full pair fits exactly
    expect(clipUnits("short",10)).toBe("short");
    // Sanity: every clipped result is valid UTF-16 (no lone surrogates).
    for (let n=0;n<=s.length;n++) expect(wellFormed(clipUnits(s,n))).toBe(true);
  });
  it("keeps the reuse label under Discord's 80-unit limit even for a long emoji bean name",()=>{
    const bean="\u{1F1EA}\u{1F1F9} Ethiopia Guji natural anaerobic lot #42 washed station ".repeat(4);
    const w={id:1,deviceId:"m",shotId:1,userId:"1",channelId:"2",step:3,answeredMask:0,currentMessageId:null,lastValues:{beanType:bean},savedParts:[],status:"active"} as const;
    const rows=stepButtons(w as never);
    const reuse=rows.flat().find(b=>b.customId==="gm:reuse")!;
    expect(reuse.label.length).toBeLessThanOrEqual(80);
    expect(wellFormed(reuse.label)).toBe(true);
    expect(reuse.label.startsWith("\u21a9\ufe0f Reuse ")).toBe(true);
  });
  it("offers 1-5 + reuse + skip on a rated rating step, in two rows",()=>{
    const w={id:1,deviceId:"m",shotId:1,userId:"1",channelId:"2",step:0,answeredMask:0,currentMessageId:null,lastValues:{rating:2},savedParts:[],status:"active"} as const;
    const rows=stepButtons(w as never);
    expect(rows.map(r=>r.map(b=>b.label))).toEqual([["1","2","3","4","5"],["\u21a9\ufe0f Reuse 2/5","\u27a1\ufe0f Skip"]]);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(5);
  });
});
