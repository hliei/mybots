import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ["mybots-source", "node"],
      externalConditions: ["mybots-source", "node"],
    },
  },
  test: {
    maxWorkers: 1,
    env: { NODE_OPTIONS: "--conditions=mybots-source" },
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/live/**", "tests/infrastructure/**"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
