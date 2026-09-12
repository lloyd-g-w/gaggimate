import { z } from "zod";

const boolish = z
  .enum(["0", "1", "true", "false", ""])
  .default("0")
  .transform(value => value === "1" || value === "true");

const envSchema = z.object({
  // In dry-run mode no Discord login happens, so these may be omitted.
  DISCORD_BOT_TOKEN: z.string().default(""),
  DISCORD_USER_IDS: z.string().default(""),
  GAGGIBOT_SHARED_TOKEN: z.string().min(32),
  GAGGIBOT_DRY_RUN: boolish,
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
  const dryRun = parsed.GAGGIBOT_DRY_RUN;
  const token = parsed.DISCORD_BOT_TOKEN || (dryRun ? "dry-run-token" : "");
  const rawUsers = parsed.DISCORD_USER_IDS || (dryRun ? "100000000000000000" : "");
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required");
  if (token.length < 20 && !dryRun) throw new Error("DISCORD_BOT_TOKEN must be at least 20 characters");
  const userIds = [...new Set(rawUsers.split(",").map(x => x.trim()).filter(Boolean))];
  if (!userIds.length) throw new Error("DISCORD_USER_IDS is required");
  if (!userIds.every(x => /^\d{15,22}$/.test(x))) throw new Error("DISCORD_USER_IDS contains an invalid ID");
  return { ...parsed, DISCORD_BOT_TOKEN: token, userIds, dryRun };
}
