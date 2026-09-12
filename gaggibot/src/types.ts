export const STEPS = ["rating", "grindSetting", "doseIn", "beanType", "notes"] as const;
export type Step = (typeof STEPS)[number];
export type NotesPatch = Partial<{
  rating: number;
  grindSetting: string;
  doseIn: number;
  doseOut: number;
  beanType: string;
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
  savedParts: string[];
  status: "queued" | "active" | "done" | "superseded";
};
