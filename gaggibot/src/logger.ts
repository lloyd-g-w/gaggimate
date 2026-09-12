const ranks = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof ranks;
export function logger(min: Level) {
  const write = (level: Level, message: string, fields: Record<string, unknown> = {}) => {
    if (ranks[level] < ranks[min]) return;
    // Callers must never pass tokens/keys; structured fields make accidental body logging avoidable.
    process[level === "debug" ? "stdout" : "stderr"].write(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }) + "\n");
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => write("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => write("error", m, f)
  };
}
