import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    // Every suite shares ONE fee wallet on ONE persistent chain. Concurrent
    // dust spends from the same wallet make the node reject with error 196
    // (PLAN-01 §"Carried test discipline"), so files run one at a time.
    fileParallelism: false,
    sequence: { concurrent: false },
    // Proving is 25-40s per call and the first proof after a stack boot also
    // waits on the public-param warmup.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    reporters: ["verbose"],
  },
});
