import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // D12 base-health: scrub the seat's live-daemon connection env before every
    // test module so the whole-suite fold gate is hermetic (see
    // test/hermetic-env.setup.ts); production env behavior is untouched.
    setupFiles: ["./test/hermetic-env.setup.ts"],
  },
});
