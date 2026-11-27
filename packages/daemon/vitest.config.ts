import { configDefaults, defineConfig } from "vitest/config";

// These tests measure real HTTP/beat latency and launch several real processes. Running them beside the rest of the
// suite can spend their fixed budgets on another file's CPU work. Keep every assertion and the scaled clock unchanged;
// give each file its own ordered group (even VITEST_MAX_WORKERS cannot overlap them). Other files keep their worker count.
const timingFiles = ["test/ps-summary-stall-red.test.ts", "test/runner-conformance-beat.test.ts"];

export default defineConfig({
  test: {
    setupFiles: ["../../test/hermetic-env.setup.ts"],
    projects: [
      { extends: true, test: { name: "parallel", include: ["test/**/*.test.ts"], exclude: [...configDefaults.exclude, ...timingFiles], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "timing-ps", include: [timingFiles[0]], sequence: { groupOrder: 1 } } },
      { extends: true, test: { name: "timing-beat", include: [timingFiles[1]], sequence: { groupOrder: 2 } } },
    ],
    // P6/D12-residue: many daemon suites spawn REAL child processes (stub-runner-*,
    // precompact-hook, bridge, restore-from-jsonl — 20+ files). Under fold-gate
    // contention (parallel files + fleet load) a single node spawn can take 5-10s,
    // exceeding vitest's 5s default and flaking on TIMEOUT (not on any assertion).
    // A generous ceiling makes these deterministic; fast tests still finish in ms,
    // so the only cost is a slower surfacing of a genuine hang.
    testTimeout: 20000,
    hookTimeout: 20000,
    // The macOS CI job (CI=true on darwin) also records its CPU, Vitest worker settings and the files its workers held
    // at once. Observation only: the reporters before it are the ones Vitest 4.1.12 picks when none are configured.
    ...(process.env.CI === "true" && process.platform === "darwin"
      ? { reporters: ["default", ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []), "./test/ci-worker-observer.ts"] }
      : {}),
  },
});
