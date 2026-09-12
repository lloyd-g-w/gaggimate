import { asTaste } from "./flow.js";
import type { NotesPatch, Step } from "./types.js";

const aliases: Record<string, keyof NotesPatch> = {
  rating:"rating", rate:"rating", stars:"rating", grind:"grindSetting", grinder:"grindSetting",
  in:"doseIn", dose:"doseIn", dosein:"doseIn", out:"doseOut", yield:"doseOut", doseout:"doseOut",
  bean:"beanType", beans:"beanType", coffee:"beanType", balance:"balanceTaste", taste:"balanceTaste", balancetaste:"balanceTaste",
  note:"notes", notes:"notes"
};
const limits: Record<keyof NotesPatch, number> = { rating:1, grindSetting:100, doseIn:1, doseOut:1, beanType:200, balanceTaste:8, notes:1500 };

export function parseReply(raw: string, current: Step): NotesPatch {
  const clean = raw.replace(/```|`/g, "").trim().slice(0, 2000);
  const patch: NotesPatch = {};
  let keyed = false;
  for (const segment of clean.split(/\n|\|/)) {
    const m = segment.match(/^\s*([a-zA-Z]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = aliases[(m[1] ?? "").toLowerCase()];
    if (!key || !m[2] || placeholder(m[2])) continue;
    assign(patch, key, m[2]); keyed = true;
  }
  if (!keyed && clean && !placeholder(clean)) {
    // A bare answer belongs to the field being asked. On the rating step a digit 1-5 is the rating;
    // free text there is a note and the rating question stays open (mirrors the display).
    if (current === "rating" || current === "balanceTaste") {
      // Steps with a fixed set of answers: a matching answer fills the step, anything else is a note.
      assign(patch, current, clean);
      if (patch[current] === undefined) assign(patch, "notes", clean);
    } else {
      assign(patch, current, clean);
    }
  }
  return patch;
}

function assign(p: NotesPatch, key: keyof NotesPatch, raw: string): void {
  const rawValue = raw.trim();
  if (key === "rating") { const n = Number(rawValue); if (Number.isInteger(n) && n >= 1 && n <= 5) p.rating = n; }
  else if (key === "balanceTaste") { const t = asTaste(rawValue); if (t) p.balanceTaste = t; }
  else if (key === "doseIn" || key === "doseOut") { const n=Number(rawValue); if (Number.isFinite(n) && n >= 0 && n <= (key === "doseIn" ? 200 : 500)) p[key]=n; }
  else p[key] = rawValue.slice(0, limits[key]) as never;
}
function placeholder(v: string): boolean { return /^<[^>]+>$/.test(v.trim()); }

export async function parseWithAi(raw: string, current: Step, cfg: {url:string;key:string;model:string}): Promise<NotesPatch | null> {
  // OpenAI JSON mode first; some OpenAI-compatible providers reject response_format with HTTP 400,
  // so retry once without it (Groq, Ollama, LM Studio, older proxies).
  const first = await requestAi(raw, current, cfg, true);
  if (first.patch) return first.patch;
  if (first.status !== 400) return null; // network error/timeout: do not pay for a second request
  const second = await requestAi(raw, current, cfg, false);
  return second.patch;
}

type AiAttempt = {patch: NotesPatch | null; status: number};

async function requestAi(raw: string, current: Step, cfg: {url:string;key:string;model:string}, jsonMode: boolean): Promise<AiAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(cfg.url, { method:"POST", signal:controller.signal,
      headers:{"content-type":"application/json", ...(cfg.key ? {authorization:`Bearer ${cfg.key}`} : {})},
      body:JSON.stringify({model:cfg.model,temperature:0,...(jsonMode?{response_format:{type:"json_object"}}:{}),messages:[
        {role:"system",content:`Extract espresso feedback as JSON using only rating (integer 1-5), grindSetting (string), doseIn/doseOut (number), beanType (string), balanceTaste (one of "sour", "balanced", "bitter"), notes (string). Field being asked: ${current}. Omit unknown fields.`},
        {role:"user",content:raw.slice(0,2000)}]}) });
    if (!response.ok) return {patch:null,status:response.status};
    const json = await response.json() as {choices?:{message?:{content?:string}}[]};
    const content=json.choices?.[0]?.message?.content; if (!content) return {patch:null,status:response.status};
    const parsed=JSON.parse(content) as Record<string,unknown>;
    const patch:NotesPatch={};
    for (const key of Object.keys(parsed) as (keyof NotesPatch)[]) {
      const value=parsed[key];
      // JSON mode models routinely emit explicit nulls for "not mentioned"; never turn those into
      // the literal strings "null"/"undefined" in the shot notes.
      if (!(key in limits) || value === null || value === undefined || value === "") continue;
      if (typeof value === "object") continue;
      assign(patch,key,String(value));
    }
    // Unusable JSON ({}, all-null) must fall through to the deterministic parser.
    return {patch:Object.keys(patch).length ? patch : null, status:response.status};
  } catch { return {patch:null,status:0}; } finally { clearTimeout(timer); }
}
