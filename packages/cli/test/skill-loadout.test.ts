import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillCommand } from "../src/commands/skill.js";

describe("rig skill loadout", () => {
  let root: string;
  let catalog: string;
  let project: string;
  let previousRoot: string | undefined;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openrig-skill-loadout-cli-"));
    catalog = join(root, "skills");
    project = join(root, "project");
    mkdirSync(catalog);
    mkdirSync(project);
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
    writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: [system-skill]\n");
    for (const id of ["system-skill", "topology-skill", "project-skill"]) {
      mkdirSync(join(catalog, id));
      writeFileSync(join(catalog, id, "SKILL.md"), `---\nname: ${id}\ndescription: Use when testing ${id}.\n---\n\n# ${id}\n`);
    }
    writeFileSync(join(project, "project.yaml"), "install:\n  skills: [project-skill]\n");
    execFileSync("git", ["-C", root, "add", "skills"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "catalog"]);
    previousRoot = process.env["OPENRIG_SKILLS_ROOT"];
    process.env["OPENRIG_SKILLS_ROOT"] = catalog;
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.map(String).join(" ")); });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousRoot === undefined) delete process.env["OPENRIG_SKILLS_ROOT"];
    else process.env["OPENRIG_SKILLS_ROOT"] = previousRoot;
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("inspects and applies one deterministic three-selector loadout", async () => {
    const run = async (apply: boolean) => {
      logs.length = 0;
      const cmd = skillCommand();
      await cmd.parseAsync([
        "node", "rig", "loadout", "--runtime", "codex", "--cwd", project,
        "--topology", "topology-skill", "--json", ...(apply ? ["--apply"] : []),
      ]);
      return JSON.parse(logs.join("")) as {
        ok: boolean;
        loadout: { entries: Array<{ id: string; selectedBy: string[] }> };
        projection: { ok: boolean; applied: boolean; receipts: Array<{ status: string }> };
      };
    };

    const inspected = await run(false);
    expect(inspected.loadout.entries.map((entry) => [entry.id, entry.selectedBy])).toEqual([
      ["project-skill", ["project"]],
      ["system-skill", ["system"]],
      ["topology-skill", ["topology"]],
    ]);
    expect(inspected.projection).toMatchObject({ ok: true, applied: false });
    expect(inspected.projection.receipts.every((receipt) => receipt.status === "missing")).toBe(true);

    const applied = await run(true);
    expect(applied.projection).toMatchObject({ ok: true, applied: true });
    expect(applied.projection.receipts.every((receipt) => receipt.status === "current")).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("warns about a skill with uncommitted content, projects the rest, and exits 1 only when something selected it", async () => {
    writeFileSync(join(catalog, "topology-skill", "draft.md"), "uncommitted work\n");
    const run = async (...topology: string[]) => {
      errors.length = 0;
      process.exitCode = undefined;
      await skillCommand().parseAsync(["node", "rig", "loadout", "--runtime", "codex", "--cwd", project, ...topology, "--apply"]);
    };

    await run();
    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([expect.stringMatching(/^Warning: catalog_skill_skipped: 'topology-skill' has uncommitted content at /)]);

    await run("--topology", "topology-skill");
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([expect.stringMatching(
      /^Warning: selected_skill_skipped: 'topology-skill' \(selected by topology\) has uncommitted content at .*; a copy already projected is kept as it was/,
    )]);
    expect(existsSync(join(project, ".agents", "skills", "system-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "topology-skill"))).toBe(false);
  });

  it("rejects an incompatible runtime before touching the target", async () => {
    const cmd = skillCommand();
    await cmd.parseAsync(["node", "rig", "loadout", "--runtime", "terminal", "--cwd", project]);
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["invalid_runtime: --runtime must be claude-code or codex"]);
  });
});
