// V0.3.1 slice 21 onboarding-conveyor.
//
// Parity test: the getting-started narrative content lives in TWO
// places because cli + daemon don't cross-import today:
//   - packages/daemon/src/domain/workspace/getting-started-narrative.ts (canonical)
//   - packages/cli/src/commands/config-init-workspace.ts (mirror)
//
// This test reads the daemon canonical AND extracts the CLI mirror
// content via the scaffold's emitted file list, then asserts the two
// produce byte-identical README / timeline / PROGRESS content for the
// two getting-started slices. If either drifts, this test fails.

import { describe, it, expect } from "vitest";
import { GETTING_STARTED_NARRATIVE } from "../src/domain/workspace/getting-started-narrative.js";
import { workspaceScaffoldFiles as cliScaffold } from "../../cli/src/commands/config-init-workspace.js";
import { workspaceScaffoldFiles as daemonScaffold } from "../src/domain/workspace/default-workspace-scaffold.js";

function findContent(
  files: Array<{ relPath: string; content: string }>,
  relPath: string,
): string | undefined {
  return files.find((f) => f.relPath === relPath)?.content;
}

describe("getting-started narrative parity — slice 21", () => {
  for (const sliceId of ["first-conveyor-run", "inspect-project-evidence"] as const) {
    describe(`slice ${sliceId}`, () => {
      it("daemon scaffold emits README.md with the canonical narrative body", () => {
        const files = daemonScaffold();
        const readme = findContent(files, `missions/getting-started/slices/${sliceId}/README.md`);
        expect(readme).toBeDefined();
        expect(readme).toContain(GETTING_STARTED_NARRATIVE[sliceId]!.readme);
      });

      it("daemon scaffold emits timeline.md with the canonical narrative body", () => {
        const files = daemonScaffold();
        const timeline = findContent(files, `missions/getting-started/slices/${sliceId}/timeline.md`);
        expect(timeline).toBeDefined();
        expect(timeline).toBe(GETTING_STARTED_NARRATIVE[sliceId]!.timeline);
      });

      it("daemon scaffold emits PROGRESS.md with the canonical narrative body", () => {
        const files = daemonScaffold();
        const progress = findContent(files, `missions/getting-started/slices/${sliceId}/PROGRESS.md`);
        expect(progress).toBeDefined();
        expect(progress).toBe(GETTING_STARTED_NARRATIVE[sliceId]!.progress);
      });

      it("CLI scaffold emits IDENTICAL README.md / timeline.md / PROGRESS.md (parity)", () => {
        const cliFiles = cliScaffold();
        const daemonFiles = daemonScaffold();
        for (const file of ["README.md", "timeline.md", "PROGRESS.md"]) {
          const rel = `missions/getting-started/slices/${sliceId}/${file}`;
          const cliContent = findContent(cliFiles, rel);
          const daemonContent = findContent(daemonFiles, rel);
          expect(cliContent, `CLI scaffold missing ${rel}`).toBeDefined();
          expect(daemonContent, `daemon scaffold missing ${rel}`).toBeDefined();
          expect(cliContent).toBe(daemonContent);
        }
      });
    });
  }

  it("getting-started narrative defines both slices (audit)", () => {
    expect(Object.keys(GETTING_STARTED_NARRATIVE).sort()).toEqual([
      "first-conveyor-run",
      "inspect-project-evidence",
    ]);
  });
});
