import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ["mybots-source", "node"],
      externalConditions: ["mybots-source", "node"],
    },
  },
  test: {
    env: { NODE_OPTIONS: "--conditions=mybots-source" },
    environment: "node",
    globals: false,
    include: ["tests/infrastructure/**/*.test.ts"],
    testTimeout: 240000,
    hookTimeout: 240000,
    fileParallelism: false,
  },
});
