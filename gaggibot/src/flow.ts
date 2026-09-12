import { STEPS, TASTES, type NotesPatch, type ShotPayload, type Step, type Taste, type Workflow } from "./types.js";

export const RATING_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"] as const;
export const REUSE_EMOJI = "↩️";
export const SKIP_EMOJI = "➡️";

const KEYS = ["rating", "grindSetting", "doseIn", "doseOut", "beanType", "balanceTaste", "notes"] as const;

/** Colours for the embed sidebar: coffee while collecting, green once logged. */
export const COLOR_IN_PROGRESS = 0x8b5a2b;
export const COLOR_DONE = 0x2ecc71;

const TASTE_LABEL: Record<Taste, string> = { sour: "🍋 Sour", balanced: "⚖️ Balanced", bitter: "🍫 Bitter" };

export function fieldsIn(patch: NotesPatch): Step[] {
  return STEPS.filter(s => patch[s] !== undefined);
}

/**
 * Cut to at most `maxUnits` UTF-16 units without splitting a surrogate pair. Both Discord and the
 * discord.js builders validate lengths in UTF-16 units, and a lone surrogate from a naive slice of
 * an emoji-bearing bean name can be rejected as an invalid form body.
 */
export function clipUnits(s: string, maxUnits: number): string {
  if (s.length <= maxUnits) return s;
  const cut=s.charCodeAt(maxUnits-1);
  return s.slice(0, cut >= 0xd800 && cut <= 0xdbff ? maxUnits-1 : maxUnits);
}

export function asTaste(value: unknown): Taste | undefined {
  const text=String(value ?? "").trim().toLowerCase();
  return (TASTES as readonly string[]).includes(text) ? (text as Taste) : undefined;
}

/**
 * Normalise one field for the wire. Doses are sent as strings because the display's notes files store
 * them that way and `ShotHistory::applyNotesPatch` only recomputes the ratio and overrides the shot
 * index volume when doseIn/doseOut are strings; a JSON number silently skips both side effects.
 */
export function asNotesValue(field: keyof NotesPatch, value: unknown): string | number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (field === "rating") {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
  }
  if (field === "doseIn" || field === "doseOut") {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= (field === "doseIn" ? 200 : 500) ? String(Number(n.toFixed(2))) : undefined;
  }
  if (field === "balanceTaste") return asTaste(value);
  if (typeof value === "object") return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.slice(0, field === "notes" ? 1500 : field === "beanType" ? 200 : 100);
}

/** Coerce a whole patch (used for `previous` values and parsed replies) into wire form. */
export function normalizePatch(patch: NotesPatch): NotesPatch {
  const out: NotesPatch = {};
  for (const field of KEYS) {
    const value = asNotesValue(field, patch[field]);
    if (value !== undefined) out[field] = value as never;
  }
  return out;
}

export function applyFields(w: Workflow, patch: NotesPatch): {answeredCurrent:boolean; next:number} {
  for (const field of fieldsIn(patch)) w.answeredMask |= 1 << STEPS.indexOf(field);
  const answeredCurrent = Boolean(w.answeredMask & (1 << w.step));
  let next=w.step;
  if (answeredCurrent) {
    next++;
    while (next < STEPS.length && (w.answeredMask & (1 << next))) next++;
  }
  return {answeredCurrent,next};
}

export function patchForReuse(w: Workflow): NotesPatch | null {
  const field=STEPS[w.step]; if (!field) return null;
  // Notes are never reused (a tasting note is about one shot); everything else, including the
  // rating, can be carried over with an explicit button that shows the value being reused.
  const value=w.lastValues[field]; if (value === undefined || field === "notes") return null;
  return { [field]: value } as NotesPatch;
}

/** Text shown for a previous/recorded value, e.g. "3/5", "18 g", "⚖️ Balanced", "Ethiopia Guji". */
export function previousLabel(field: keyof NotesPatch, value: unknown): string {
  if (field === "balanceTaste") { const t=asTaste(value); return t ? TASTE_LABEL[t] : String(value); }
  const text=clipUnits(String(value),120);
  if (field === "rating") return `${text}/5`;
  if (field === "doseIn" || field === "doseOut") return `${text} g`;
  return text;
}

/** Button custom ids, kept short: gm:rate:<1-5>, gm:taste:<sour|balanced|bitter>, gm:reuse, gm:skip. */
export const BUTTON_PREFIX="gm:";
export type StepAction={type:"rate";value:number}|{type:"taste";value:Taste}|{type:"reuse"}|{type:"skip"};
export function actionFromCustomId(customId: string): StepAction | null {
  if (!customId.startsWith(BUTTON_PREFIX)) return null;
  const rest=customId.slice(BUTTON_PREFIX.length);
  if (rest === "reuse") return {type:"reuse"};
  if (rest === "skip") return {type:"skip"};
  const rate=/^rate:([1-5])$/.exec(rest);
  if (rate) return {type:"rate",value:Number(rate[1])};
  const taste=/^taste:(sour|balanced|bitter)$/.exec(rest);
  if (taste) return {type:"taste",value:taste[1] as Taste};
  return null;
}
export function actionFromEmoji(emoji: string, step: number): StepAction | null {
  const n=RATING_EMOJIS.indexOf(emoji as typeof RATING_EMOJIS[number]);
  if (n >= 0) return step === 0 ? {type:"rate",value:n+1} : null;
  if (emoji === REUSE_EMOJI || emoji === "↩") return {type:"reuse"};
  if (emoji === SKIP_EMOJI || emoji === "➡") return {type:"skip"};
  return null;
}

/**
 * Buttons for a step prompt. They travel inside the same send() as the card, so a prompt appears
 * fully interactive in one request — unlike reactions, which Discord rate-limits to ~4/s and which
 * therefore trickled in for 1.5 s+ after every prompt.
 */
export type StepButton={customId:string;label:string;primary?:boolean};
export function stepButtons(w: Workflow): StepButton[][] {
  const field=STEPS[w.step]; if (!field) return [];
  const previous=w.lastValues[field];
  const rows:StepButton[][]=[];
  if (field === "rating") rows.push([1,2,3,4,5].map(n=>({customId:`${BUTTON_PREFIX}rate:${n}`,label:String(n)})));
  if (field === "balanceTaste") {
    // Three options; the previous choice is highlighted instead of a separate reuse button.
    rows.push(TASTES.map(t=>({customId:`${BUTTON_PREFIX}taste:${t}`,label:TASTE_LABEL[t],primary:previous === t})));
  }
  const controls:StepButton[]=[];
  if (field !== "notes" && field !== "balanceTaste" && previous !== undefined) controls.push({customId:`${BUTTON_PREFIX}reuse`,label:`↩️ Reuse ${clipUnits(previousLabel(field,previous),60)}`,primary:true});
  controls.push({customId:`${BUTTON_PREFIX}skip`,label:"➡️ Skip"});
  rows.push(controls);
  return rows;
}

// ---------------------------------------------------------------------------------------------------
// Cards (Discord embeds as plain JSON, so this module stays free of discord.js and easy to test)
// ---------------------------------------------------------------------------------------------------

export type Embed={title:string;description?:string;color:number;fields:{name:string;value:string;inline?:boolean}[];footer?:{text:string}};

const TITLES:Record<Step,string>={rating:"Rate this shot",grindSetting:"Grind",doseIn:"Dose in",beanType:"Bean",balanceTaste:"Balance / taste",notes:"Note"};
const PROMPTS:Record<Step,string>={
  rating:"Tap **1–5** below or send a number from *1 to 5*.",
  grindSetting:"Send the grind setting for this shot, e.g. **3.5**",
  doseIn:"Send the dose for this shot, e.g. **18**",
  beanType:"Send the bean for this shot.",
  balanceTaste:"How did it taste? Tap one below.",
  notes:"Send a note for this shot — anything worth remembering."
};
const ICON:Record<keyof NotesPatch,string>={rating:"⭐",grindSetting:"🔧",doseIn:"⚖️",doseOut:"☕",beanType:"🫘",balanceTaste:"👅",notes:"📝"};
const NAME:Record<keyof NotesPatch,string>={rating:"Rating",grindSetting:"Grind",doseIn:"Dose in",doseOut:"Yield",beanType:"Bean",balanceTaste:"Balance",notes:"Notes"};

export function summaryLine(p: ShotPayload): string {
  const s=p.shot;
  return `⏱ ${s.duration.toFixed(1)} s  ·  ⚖️ ${s.weight.toFixed(1)} g  ·  🌡️ ${s.temperature.toFixed(1)} °C  ·  ⏫ ${s.pressure.toFixed(1)} bar  ·  💧 ${s.flow.toFixed(1)} ml/s`;
}
export function cardTitle(p: ShotPayload, done: boolean): string {
  return clipUnits(`${done ? "✅" : "☕"} Shot #${p.shot.id}  ·  ${p.shot.profile || "Unknown profile"}`,256);
}
function stars(n:number):string { return "★".repeat(n)+"☆".repeat(5-n); }
function recordedValue(field:keyof NotesPatch,value:unknown):string {
  if (field === "rating") return `${stars(Number(value))}  ${value}/5`;
  return clipUnits(previousLabel(field,value),1000);
}
/** "⭐ 4/5 · 🔧 3.5" — compact line of what has been recorded so far. */
export function recordedSoFar(saved: NotesPatch): string {
  const parts:string[]=[];
  for (const field of KEYS) {
    const value=saved[field]; if (value === undefined) continue;
    if (field === "notes") { parts.push(`${ICON.notes} ${clipUnits(String(value),60)}`); continue; }
    parts.push(`${ICON[field]} ${previousLabel(field,value)}`);
  }
  return parts.join("  ·  ");
}

/** The single in-progress card: summary, the current step, and what is recorded so far. */
export function stepEmbed(w: Workflow, p: ShotPayload): Embed {
  const field=STEPS[w.step]!;
  const previous=w.lastValues[field];
  const lines:string[]=[];
  if (previous !== undefined) {
    lines.push(field === "rating" ? `Your last shot was rated *${previousLabel(field,previous)}*.` : `Your last shot was *${previousLabel(field,previous)}*.`);
  }
  lines.push(PROMPTS[field]);
  const legend:string[]=[];
  if (field === "rating") legend.push("1–5 to rate");
  if (field === "balanceTaste") legend.push("tap a taste");
  if (field !== "notes" && field !== "balanceTaste" && previous !== undefined) legend.push(`↩️ to reuse *${previousLabel(field,previous)}*`);
  legend.push("➡️ to skip");
  lines.push(`*${legend.join(" · ")}*`);

  const fields:Embed["fields"]=[{name:`Step ${w.step+1} of ${STEPS.length} — ${TITLES[field]}`,value:clipUnits(lines.join("\n"),1024)}];
  const recorded=recordedSoFar(w.saved);
  if (recorded) fields.push({name:"Recorded so far",value:clipUnits(recorded,1024)});
  return {title:cardTitle(p,false),description:summaryLine(p),color:COLOR_IN_PROGRESS,fields,footer:{text:"Tap a button or just reply · every answer is saved immediately"}};
}

/** The final card: everything recorded, laid out as fields. Skipped fields show —. */
export function resultEmbed(w: Workflow, p: ShotPayload): Embed {
  const s=w.saved;
  const inline=(field:keyof NotesPatch):Embed["fields"][number]=>({name:`${ICON[field]} ${NAME[field]}`,value:s[field] !== undefined ? recordedValue(field,s[field]) : "—",inline:true});
  const fields:Embed["fields"]=[inline("rating"),inline("grindSetting"),inline("doseIn")];
  // Yield: the answered dose out if given, else the shot's own final weight; add the ratio when both doses are known.
  const yieldValue=s.doseOut !== undefined ? Number(s.doseOut) : p.shot.weight;
  const doseIn=s.doseIn !== undefined ? Number(s.doseIn) : NaN;
  const ratio=Number.isFinite(doseIn) && doseIn > 0 && yieldValue > 0 ? `  ·  1 : ${(yieldValue/doseIn).toFixed(1)}` : "";
  fields.push({name:`${ICON.doseOut} ${NAME.doseOut}`,value:yieldValue > 0 ? `${yieldValue.toFixed(1)} g${ratio}` : "—",inline:true});
  fields.push(inline("beanType"),inline("balanceTaste"));
  fields.push({name:`${ICON.notes} ${NAME.notes}`,value:s.notes !== undefined ? clipUnits(String(s.notes),1024) : "—",inline:false});
  const answered=Object.keys(s).length;
  return {title:cardTitle(p,true),description:summaryLine(p),color:COLOR_DONE,fields,footer:{text:answered ? "Saved to shot history" : "Nothing recorded for this shot"}};
}
