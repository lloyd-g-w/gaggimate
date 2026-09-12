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
  const value=w.lastValues[field]; if (value === undefined || field === "notes") return null;
  return { [field]: value } as NotesPatch;
}
export function savedPart(field: keyof NotesPatch, value: unknown): string {
  const label:Record<keyof NotesPatch,string>={rating:"rating",grindSetting:"grind",doseIn:"in",doseOut:"out",beanType:"bean",notes:"note"};
  const unit=field === "doseIn" || field === "doseOut" ? " g" : "";
  return `${label[field]} ${String(value).slice(0,60)}${unit}`;
}
export function stepMessage(w: Workflow): string {
  const field=STEPS[w.step]; if (!field) return "";
  const titles:Record<Step,string>={rating:"Rate this shot",grindSetting:"Grind",doseIn:"Dose in",beanType:"Bean",notes:"Note"};
  const prompts:Record<Step,string>={rating:"React 1️⃣–5️⃣ below or send a number from 1 to 5.",grindSetting:"Send the grind setting for this shot, e.g. 3.5",doseIn:"Send the dose for this shot, e.g. 18",beanType:"Send the bean for this shot.",notes:"Send a note for this shot."};
  const previous=w.lastValues[field];
  let out=`-# Shot #${w.shotId} · step ${w.step+1}/${STEPS.length}\n# ${titles[field]}\n\n`;
  if (previous !== undefined) out += field === "rating" ? `Your last shot was **${previous}/5**.\n\n` : `Your last shot was *${String(previous).slice(0,120)}${field === "doseIn" ? " g" : ""}*.\n\n`;
  out += prompts[field]+"\n\n";
  if (field === "rating") out += "-# React 1️⃣–5️⃣ to rate · ➡️ to skip";
  else if (field !== "notes" && previous !== undefined) out += `-# React ↩️ to reuse *${String(previous).slice(0,120)}* · ➡️ to skip`;
  else out += "-# React ➡️ to skip";
  return out.slice(0,2000);
}
