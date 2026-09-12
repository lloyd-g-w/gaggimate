import { STEPS, type NotesPatch, type Step, type Workflow } from "./types.js";

export const RATING_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"] as const;
export const REUSE_EMOJI = "↩️";
export const SKIP_EMOJI = "➡️";

export function fieldsIn(patch: NotesPatch): Step[] {
  return STEPS.filter(s => patch[s] !== undefined);
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
  return `${label[field]} ${String(value).slice(0,60)}`;
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
