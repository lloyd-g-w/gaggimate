import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    maxWorkers: 1,
    // Only run sources: without this, compiled copies in dist/ were collected as well, which
    // silently doubled the reported test count.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"]
  }
});
