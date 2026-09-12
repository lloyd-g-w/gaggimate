import { STEPS, type NotesPatch, type Step, type Workflow } from "./types.js";

export const RATING_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"] as const;
export const REUSE_EMOJI = "↩️";
export const SKIP_EMOJI = "➡️";

const KEYS = ["rating", "grindSetting", "doseIn", "doseOut", "beanType", "notes"] as const;

export function fieldsIn(patch: NotesPatch): Step[] {
  return STEPS.filter(s => patch[s] !== undefined);
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

/** Text shown for a previous value, e.g. "3/5", "18 g", "Ethiopia Guji". */
export function previousLabel(field: Step, value: unknown): string {
  const text=String(value).slice(0,120);
  if (field === "rating") return `${text}/5`;
  if (field === "doseIn") return `${text} g`;
  return text;
}

/** Button custom ids, kept short: gm:rate:<1-5>, gm:reuse, gm:skip. */
export const BUTTON_PREFIX="gm:";
export type StepAction={type:"rate";value:number}|{type:"reuse"}|{type:"skip"};
export function actionFromCustomId(customId: string): StepAction | null {
  if (!customId.startsWith(BUTTON_PREFIX)) return null;
  const rest=customId.slice(BUTTON_PREFIX.length);
  if (rest === "reuse") return {type:"reuse"};
  if (rest === "skip") return {type:"skip"};
  const m=/^rate:([1-5])$/.exec(rest);
  return m ? {type:"rate",value:Number(m[1])} : null;
}
export function actionFromEmoji(emoji: string, step: number): StepAction | null {
  const n=RATING_EMOJIS.indexOf(emoji as typeof RATING_EMOJIS[number]);
  if (n >= 0) return step === 0 ? {type:"rate",value:n+1} : null;
  if (emoji === REUSE_EMOJI || emoji === "↩") return {type:"reuse"};
  if (emoji === SKIP_EMOJI || emoji === "➡") return {type:"skip"};
  return null;
}

/**
 * Buttons for a step prompt. They travel inside the same send() as the text, so a prompt appears
 * fully interactive in one request — unlike reactions, which Discord rate-limits to ~4/s and which
 * therefore trickled in for 1.5 s+ after every prompt.
 */
export type StepButton={customId:string;label:string;primary?:boolean};
export function stepButtons(w: Workflow): StepButton[][] {
  const field=STEPS[w.step]; if (!field) return [];
  const previous=w.lastValues[field];
  const rows:StepButton[][]=[];
  if (field === "rating") rows.push([1,2,3,4,5].map(n=>({customId:`${BUTTON_PREFIX}rate:${n}`,label:String(n)})));
  const controls:StepButton[]=[];
  if (field !== "notes" && previous !== undefined) controls.push({customId:`${BUTTON_PREFIX}reuse`,label:`↩️ Reuse ${previousLabel(field,previous).slice(0,60)}`,primary:true});
  controls.push({customId:`${BUTTON_PREFIX}skip`,label:"➡️ Skip"});
  rows.push(controls);
  return rows;
}
export function savedPart(field: keyof NotesPatch, value: unknown): string {
  const label:Record<keyof NotesPatch,string>={rating:"rating",grindSetting:"grind",doseIn:"in",doseOut:"out",beanType:"bean",notes:"note"};
  const unit=field === "doseIn" || field === "doseOut" ? " g" : "";
  return `${label[field]} ${String(value).slice(0,60)}${unit}`;
}
export function stepMessage(w: Workflow): string {
  const field=STEPS[w.step]; if (!field) return "";
  const titles:Record<Step,string>={rating:"Rate this shot",grindSetting:"Grind",doseIn:"Dose in",beanType:"Bean",notes:"Note"};
  const prompts:Record<Step,string>={rating:"Tap 1–5 below or send a number from *1 to 5*.",grindSetting:"Send the grind setting for this shot, e.g. 3.5",doseIn:"Send the dose for this shot, e.g. 18",beanType:"Send the bean for this shot.",notes:"Send a note for this shot."};
  const previous=w.lastValues[field];
  let out=`-# Shot #${w.shotId} · step ${w.step+1}/${STEPS.length}\n# ${titles[field]}\n\n`;
  if (previous !== undefined) {
    out += field === "rating" ? `Your last shot was rated *${previousLabel(field,previous)}*.\n\n`
      : `Your last shot was *${previousLabel(field,previous)}*.\n\n`;
  }
  out += prompts[field]+"\n\n";
  const legend:string[]=[];
  if (field === "rating") legend.push("1–5 to rate");
  if (field !== "notes" && previous !== undefined) legend.push(`↩️ to reuse *${previousLabel(field,previous)}*`);
  legend.push("➡️ to skip");
  out += "-# " + legend.join(" · ");
  return out.slice(0,2000);
}
