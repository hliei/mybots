import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/live/**"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
