import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runInitWorkspace,
  workspaceScaffoldFiles,
} from "../src/commands/config-init-workspace.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env["OPENRIG_NOTES_TEMPLATE_PATH"];
  delete process.env["OPENRIG_MISSION_NOTES_TEMPLATE_PATH"];
});

describe("project-workspace initialization does not seed mission content", () => {
  it("emits no mission NOTES.md or built-in mission", () => {
    const paths = workspaceScaffoldFiles().map((file) => file.relPath);
    expect(paths.some((path) => path.endsWith("NOTES.md"))).toBe(false);
    expect(paths.some((path) => path.startsWith("missions/"))).toBe(false);
  });

  it("does not consult mission-note overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-project-only-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    process.env["OPENRIG_NOTES_TEMPLATE_PATH"] = join(root, "missing-current.md");
    process.env["OPENRIG_MISSION_NOTES_TEMPLATE_PATH"] = join(root, "missing-legacy.md");

    expect(() => runInitWorkspace({ root: workspace, configPath: join(root, "config.json") })).not.toThrow();
    expect(existsSync(join(workspace, "SPEC.md"))).toBe(true);
    expect(existsSync(join(workspace, "missions"))).toBe(true);
  });
});
