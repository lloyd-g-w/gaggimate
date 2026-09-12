import { z } from "zod";

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(20),
  DISCORD_USER_IDS: z.string().min(1),
  GAGGIBOT_SHARED_TOKEN: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().default("/data"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AI_URL: z.string().url().optional().or(z.literal("")),
  AI_API_KEY: z.string().optional().default(""),
  AI_MODEL: z.string().min(1).default("gpt-4o-mini")
});

export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const userIds = [...new Set(parsed.DISCORD_USER_IDS.split(",").map(x => x.trim()).filter(Boolean))];
  if (!userIds.every(x => /^\d{15,22}$/.test(x))) throw new Error("DISCORD_USER_IDS contains an invalid ID");
  return { ...parsed, userIds };
}
