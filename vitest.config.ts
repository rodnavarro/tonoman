import { defineConfig, configDefaults } from "vitest/config";

// Default test run (`npm test`) — the FREE contract suite. Live integration tests
// (`*.live.test.ts`, real containers + real tokens) are excluded here and run only via
// `npm run test:live` (vitest.live.config.ts), so `npm test` and CI never spend tokens.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
