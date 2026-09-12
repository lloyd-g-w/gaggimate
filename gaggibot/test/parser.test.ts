import { describe,expect,it } from "vitest";
import { parseReply } from "../src/parser.js";

describe("parseReply",()=>{
  it("assigns a bare answer to the current step",()=>expect(parseReply("3.5","grindSetting")).toEqual({grindSetting:"3.5"}));
  it("extracts multiple keyed fields",()=>expect(parseReply("rating: 4 | in: 18\nbean: Guji","notes")).toEqual({rating:4,doseIn:18,beanType:"Guji"}));
  it("rejects invalid ratings and placeholders",()=>expect(parseReply("rating: 8 | bean: <bean>","rating")).toEqual({}));
  it("bounds input",()=>expect(parseReply("x".repeat(3000),"notes").notes).toHaveLength(1500));
  it("treats free text on the rating step as a note so the rating stays open",()=>{
    expect(parseReply("tasted a bit sour","rating")).toEqual({notes:"tasted a bit sour"});
  });
  it("still parses a bare rating digits on the rating step",()=>expect(parseReply("4","rating")).toEqual({rating:4}));
  it("keeps a bare answer on the note step as notes",()=>expect(parseReply("great body","notes")).toEqual({notes:"great body"}));
  it("strips backticks from pasted templates",()=>expect(parseReply("```\ngrind: 3.2\n```","grindSetting")).toEqual({grindSetting:"3.2"}));
  it("accepts an out-only reply without touching other fields",()=>expect(parseReply("out: 36","doseIn")).toEqual({doseOut:36}));
});
