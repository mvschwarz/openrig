import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../test/hermetic-env.setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
