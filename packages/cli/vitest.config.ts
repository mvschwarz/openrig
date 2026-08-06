import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // P11 base-health (createProgram-wired flap): a handful of tests build the FULL CLI
    // command tree via createProgram() and drive it through parseAsync — legitimately ~2s
    // of work under tsx (the "mounts both commands" wiring tests re-create the program per
    // parse because Commander consumes parseAsync). Under whole-suite load that flapped the
    // 5000ms default -> non-deterministic timeouts misread as regressions. Match the daemon
    // precedent (P6-2, 20000) so real-work tests get honest headroom; the companion fix
    // static-imports src/index.js in the wiring files so the on-demand COMPILE no longer
    // lands under the per-test timeout. Neither masks a product defect (the cost is tsx
    // dev-compile + tree-build, not shipped-CLI latency).
    testTimeout: 20000,
    hookTimeout: 20000,
    // D12 base-health: scrub the seat's live-daemon connection env before every
    // test module so the whole-suite fold gate is hermetic (see
    // test/hermetic-env.setup.ts); production env behavior is untouched.
    setupFiles: ["./test/hermetic-env.setup.ts"],
  },
});
