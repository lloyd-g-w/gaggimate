export const STEPS = ["rating", "grindSetting", "doseIn", "beanType", "balanceTaste", "notes"] as const;
export type Step = (typeof STEPS)[number];
export const TASTES = ["sour", "balanced", "bitter"] as const;
export type Taste = (typeof TASTES)[number];
export type NotesPatch = Partial<{
  rating: number;
  grindSetting: string;
  // Doses travel as strings: the display's notes files use strings, and its patch merge only
  // recomputes ratio/index volume for string doses.
  doseIn: number | string;
  doseOut: number | string;
  beanType: string;
  balanceTaste: Taste;
  notes: string;
}>;
export type ShotPayload = {
  deviceId: string;
  shot: {
    id: number;
    profile: string;
    duration: number;
    weight: number;
    temperature: number;
    pressure: number;
    flow: number;
  };
  previous: NotesPatch;
};
export type Workflow = {
  id: number;
  deviceId: string;
  shotId: number;
  userId: string;
  channelId: string | null;
  step: number;
  answeredMask: number;
  currentMessageId: string | null;
  lastValues: NotesPatch;
  /** Everything recorded for this shot so far (wire form), rendered on every card and the result. */
  saved: NotesPatch;
  status: "queued" | "active" | "done" | "superseded";
};
