import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  workspaceScaffoldDirs as cliScaffoldDirs,
  workspaceScaffoldFiles as cliScaffoldFiles,
} from "../../cli/src/commands/config-init-workspace.js";
import {
  workspaceScaffoldDirs as daemonScaffoldDirs,
  workspaceScaffoldFiles as daemonScaffoldFiles,
} from "../src/domain/workspace/default-workspace-scaffold.js";

describe("canonical project-workspace scaffold parity", () => {
  it("keeps the CLI and daemon layouts byte-identical", () => {
    expect(daemonScaffoldDirs()).toEqual(["missions", "exhaust"]);
    expect(cliScaffoldDirs()).toEqual(daemonScaffoldDirs());
    expect(cliScaffoldFiles()).toEqual(daemonScaffoldFiles());
    expect(daemonScaffoldFiles().map((file) => file.relPath)).toEqual([
      "SPEC.md",
      "project.yaml",
      "workspace.yaml",
      ".gitignore",
    ]);
  });

  it("emits valid project and catalog manifests without instance-owned sources", () => {
    const files = new Map(daemonScaffoldFiles().map((file) => [file.relPath, file.content]));
    expect(parseYaml(files.get("project.yaml")!)).toMatchObject({
      schema: "openrig.project/v0alpha1",
      kind: "project",
      install: { intent: "SPEC.md", context: [], skills: [] },
      missions: { root: "missions" },
    });
    expect(parseYaml(files.get("workspace.yaml")!)).toEqual({
      schema: "openrig.workspace/v0alpha1",
      projects: [{ id: "default", root: "." }],
    });
    expect(files.get("SPEC.md")).toContain("intent:");
    expect(files.get(".gitignore")).toContain("/exhaust/");
    expect(files.get(".gitignore")).toContain("/.openrig/");

    const emitted = [...daemonScaffoldDirs(), ...files.keys()];
    for (const retired of [
      "README.md",
      "STEERING.md",
      "artifacts",
      "evidence",
      "field-notes",
      "dogfood-evidence",
      "progress",
      "skills",
      "context",
      "state",
    ]) {
      expect(emitted).not.toContain(retired);
    }
  });

  it("keeps shipped init-workspace guidance aligned with the additive six-entry scaffold", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const cliReference = readFileSync(join(repoRoot, "docs/as-built/cli-reference.md"), "utf-8");
    const skill = readFileSync(
      join(repoRoot, "packages/daemon/assets/plugins/openrig-core/skills/openrig-user/SKILL.md"),
      "utf-8",
    );
    const cliLine = cliReference.split("\n").find((line) => line.startsWith("- `init-workspace` "));
    const skillStart = skill.indexOf("### Instantiate the canonical workspace scaffold");
    const skillEnd = skill.indexOf("### Redirect the workspace root", skillStart);
    const skillSection = skill.slice(skillStart, skillEnd);
    const scratchStart = skill.indexOf("### Build a workspace from scratch");
    const scratchEnd = skill.indexOf("### Create a workflow inside an existing workspace", scratchStart);
    const scratchSection = skill.slice(scratchStart, scratchEnd);

    expect(cliLine).toBeDefined();
    expect(skillStart).toBeGreaterThanOrEqual(0);
    expect(skillEnd).toBeGreaterThan(skillStart);
    expect(scratchStart).toBeGreaterThanOrEqual(0);
    expect(scratchEnd).toBeGreaterThan(scratchStart);
    for (const entry of ["missions/", "exhaust/", "SPEC.md", "project.yaml", "workspace.yaml", ".gitignore"]) {
      expect(cliLine).toContain(entry);
      expect(skillSection).toContain(entry);
    }
    for (const retired of ["artifacts/", "evidence/", "progress/", "field-notes/", "specs/", "dogfood-evidence/", "getting-started", "README.md", "STEERING.md"]) {
      expect(cliLine).not.toContain(retired);
      expect(skillSection).not.toContain(retired);
    }
    for (const surface of [cliLine!, skillSection]) {
      expect(surface).toContain("additive");
      expect(surface).toContain("deprecated");
      expect(surface).toContain("preserves existing files");
      expect(surface).not.toMatch(/--force[^.\n]*overwrites?/i);
    }
    expect(scratchSection).toContain("missing canonical entries");
    expect(scratchSection).toContain("complete six-entry scaffold is a no-op");
    expect(scratchSection).not.toContain("populated subdirs is a no-op");
  });
});
