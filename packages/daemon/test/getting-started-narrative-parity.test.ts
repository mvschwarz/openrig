import { describe, expect, it } from "vitest";
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
});
