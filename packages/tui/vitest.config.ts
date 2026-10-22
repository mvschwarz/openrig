import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../test/hermetic-env.setup.ts"],
    // The tui's Unix socket tests fit a socket path into a fixed byte budget under the outer TMPDIR (macOS's
    // default is already ~49 bytes), so they keep it as it is. The tui leaves nothing in it but Node's own cache;
    // the fixture homes are still removed.
    env: { OPENRIG_TEST_KEEP_TMPDIR: "1" },
    include: ["test/**/*.test.ts"],
  },
});
