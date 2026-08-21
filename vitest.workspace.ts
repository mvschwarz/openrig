// B15 — root-invocation hermeticity. The per-package vitest configs carry the hermetic-env setup
// (D12: scrub connection env, fixture-scoped OPENRIG_HOME, fetch guard), but a bare `npx vitest run
// packages/cli/test/x.test.ts` from the REPO ROOT found no config and ran UNGUARDED — inside a seat
// that meant the suites escaped their mocks to the live daemon and produced 13 false failures that
// cost a QA cycle and a dispatched work item (B15). This workspace file makes the root invocation
// resolve each package's own config, so the guarantee genuinely "lives where it cannot be skipped".
export default ["packages/*/vitest.config.ts"];
