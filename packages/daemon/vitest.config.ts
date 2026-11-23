import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../test/hermetic-env.setup.ts"],
    include: ["test/**/*.test.ts"],
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
