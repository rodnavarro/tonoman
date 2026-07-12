import { defineConfig } from "vitest/config";

// Live integration tests only (`npm run test:live`). Real containers, real tokens,
// run on demand. Long timeouts — real turns are slow. Single-file (no parallelism) so
// concurrent live turns don't race the shared target container.
export default defineConfig({
  test: {
    include: ["src/live/**/*.live.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
