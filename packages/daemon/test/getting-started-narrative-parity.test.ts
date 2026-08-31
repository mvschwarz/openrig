// V0.3.1 slice 21 onboarding-conveyor.
//
// Parity test: the getting-started narrative content lives in TWO
// places because cli + daemon don't cross-import today:
//   - packages/daemon/src/domain/workspace/getting-started-narrative.ts (canonical)
//   - packages/cli/src/commands/config-init-workspace.ts (mirror)
//
// This test reads the daemon canonical AND extracts the CLI mirror
// content via the scaffold's emitted file list, then asserts the two
// produce byte-identical SPEC / timeline / PROGRESS content for the
// two getting-started slices. If either drifts, this test fails.

import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { GETTING_STARTED_NARRATIVE } from "../src/domain/workspace/getting-started-narrative.js";
import { workspaceScaffoldFiles as cliScaffold } from "../../cli/src/commands/config-init-workspace.js";
import {
  workspaceScaffoldDirs as daemonScaffoldDirs,
  workspaceScaffoldFiles as daemonScaffold,
} from "../src/domain/workspace/default-workspace-scaffold.js";
import {
  workspaceScaffoldDirs as cliScaffoldDirs,
} from "../../cli/src/commands/config-init-workspace.js";

function findContent(
  files: Array<{ relPath: string; content: string }>,
  relPath: string,
): string | undefined {
  return files.find((f) => f.relPath === relPath)?.content;
}

describe("getting-started narrative parity — slice 21", () => {
  it("CLI and daemon emit byte-identical parseable default work manifests", () => {
    const manifests = [
      ["project.yaml", "openrig.project/v0alpha1", "project"],
      ["missions/getting-started/mission.yaml", "openrig.mission/v0alpha1", "mission"],
      ["missions/getting-started/slices/first-conveyor-run/slice.yaml", "openrig.slice/v0alpha1", "slice"],
      ["missions/getting-started/slices/inspect-project-evidence/slice.yaml", "openrig.slice/v0alpha1", "slice"],
    ] as const;
    const cliFiles = cliScaffold();
    const daemonFiles = daemonScaffold();
    for (const [relPath, schema, kind] of manifests) {
      const cliContent = findContent(cliFiles, relPath);
      const daemonContent = findContent(daemonFiles, relPath);
      expect(cliContent, `CLI scaffold missing ${relPath}`).toBeDefined();
      expect(daemonContent, `daemon scaffold missing ${relPath}`).toBeDefined();
      expect(daemonContent).toBe(cliContent);
      expect(parseYaml(daemonContent!)).toMatchObject({ schema, kind });
    }
  });

  it("CLI and daemon emit a byte-identical project-root SPEC.md", () => {
    const cliContent = findContent(cliScaffold(), "SPEC.md");
    const daemonContent = findContent(daemonScaffold(), "SPEC.md");
    expect(cliContent, "CLI scaffold missing project-root SPEC.md").toBeDefined();
    expect(daemonContent, "daemon scaffold missing project-root SPEC.md").toBeDefined();
    expect(daemonContent).toBe(cliContent);
    expect(daemonContent).toContain("intent:");
  });

  for (const sliceId of ["first-conveyor-run", "inspect-project-evidence"] as const) {
    describe(`slice ${sliceId}`, () => {
      it("daemon scaffold emits SPEC.md with the canonical narrative body", () => {
        const files = daemonScaffold();
        const readme = findContent(files, `missions/getting-started/slices/${sliceId}/SPEC.md`);
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

      it("CLI scaffold emits IDENTICAL SPEC.md / timeline.md / PROGRESS.md (parity)", () => {
        const cliFiles = cliScaffold();
        const daemonFiles = daemonScaffold();
        for (const file of ["SPEC.md", "timeline.md", "PROGRESS.md"]) {
          const rel = `missions/getting-started/slices/${sliceId}/${file}`;
          const cliContent = findContent(cliFiles, rel);
          const daemonContent = findContent(daemonFiles, rel);
          expect(cliContent, `CLI scaffold missing ${rel}`).toBeDefined();
          expect(daemonContent, `daemon scaffold missing ${rel}`).toBeDefined();
          expect(cliContent).toBe(daemonContent);
        }
      });

      it("CLI and daemon emit byte-identical root PROOF.md plus sibling proof/ dir", () => {
        const relProof = `missions/getting-started/slices/${sliceId}/PROOF.md`;
        const relProofDir = `missions/getting-started/slices/${sliceId}/proof`;
        const cliFiles = cliScaffold();
        const daemonFiles = daemonScaffold();
        const cliDirs = cliScaffoldDirs();
        const daemonDirs = daemonScaffoldDirs();

        const cliProof = findContent(cliFiles, relProof);
        const daemonProof = findContent(daemonFiles, relProof);
        expect(cliProof, `CLI scaffold missing ${relProof}`).toBeDefined();
        expect(daemonProof, `daemon scaffold missing ${relProof}`).toBeDefined();
        expect(daemonProof).toBe(cliProof);
        // broad-suite-residue atom 3: the WHO/WHEN sentence carries BOTH context
        // paths as separate code spans and never the internal staging path
        expect(daemonProof).toContain("`docs/reference/sdlc-conventions.md` in the repo");
        expect(daemonProof).toContain("`$OPENRIG_HOME/reference/sdlc-conventions.md` on an installed package");
        expect(daemonProof).not.toContain("daemon/docs/reference/");
        expect(cliDirs).toContain(relProofDir);
        expect(daemonDirs).toContain(relProofDir);
      });
    });
  }

  it("getting-started narrative defines both slices (audit)", () => {
    expect(Object.keys(GETTING_STARTED_NARRATIVE).sort()).toEqual([
      "first-conveyor-run",
      "inspect-project-evidence",
    ]);
  });

  // CLI and daemon both emit current NOTES.md for each getting-started
  // mission. Body content must stay byte-identical across the CLI and
  // daemon-owned scaffold implementations.
  it("CLI and daemon emit byte-identical missions/getting-started/NOTES.md", () => {
    const cliFiles = cliScaffold();
    const daemonFiles = daemonScaffold();
    const rel = "missions/getting-started/NOTES.md";
    const cliContent = findContent(cliFiles, rel);
    const daemonContent = findContent(daemonFiles, rel);
    expect(cliContent, `CLI scaffold missing ${rel}`).toBeDefined();
    expect(daemonContent, `daemon scaffold missing ${rel}`).toBeDefined();
    expect(cliContent).toBe(daemonContent);
  });

  it("CLI and daemon omit retired MISSION_BRIEF.md", () => {
    const cliFiles = cliScaffold();
    const daemonFiles = daemonScaffold();
    const rel = "missions/getting-started/MISSION_BRIEF.md";
    const cliContent = findContent(cliFiles, rel);
    const daemonContent = findContent(daemonFiles, rel);
    expect(cliContent).toBeUndefined();
    expect(daemonContent).toBeUndefined();
  });
});
