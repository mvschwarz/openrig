// B15 — root-invocation hermeticity (r1-reviewed shape: test.projects, NOT the deprecated
// workspace file). The per-package vitest configs carry the hermetic-env setup (D12: scrub
// connection env, fixture-scoped OPENRIG_HOME, fetch guard), but a bare
// `npx vitest run packages/cli/test/x.test.ts` from the REPO ROOT found no config and ran
// UNGUARDED — inside a seat that meant the suites escaped their mocks to the live daemon and
// produced 13 false failures that cost a QA cycle and a dispatched work item (B15). This root
// config makes the root invocation resolve each package's own config, so the guarantee genuinely
// "lives where it cannot be skipped" — and on a carrier vitest will keep reading past v4 (the
// workspace-file variant was deprecated and would have silently reopened the hole at the upgrade).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },
});
