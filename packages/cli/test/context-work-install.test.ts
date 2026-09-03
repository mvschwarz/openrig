import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errLogs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander.exitOverride */ }
    const exitCode = process.exitCode;
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function makeCommand(): Command {
  const command = new Command();
  command.exitOverride();
  command.addCommand(contextCommand());
  return command;
}

describe("rig context work-install", () => {
  let root: string;
  let catalogRoot: string;
  let alphaRoot: string;
  let betaRoot: string;
  let skillsRoot: string;
  let workingRoot: string;
  let savedWorkspaceRoot: string | undefined;
  let savedCatalogPath: string | undefined;
  let savedSkillsRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openrig-context-work-install-"));
    catalogRoot = join(root, "catalog");
    alphaRoot = join(root, "alpha-root");
    betaRoot = join(root, "unrelated-beta-tree");
    skillsRoot = join(root, "managed-skills");
    workingRoot = join(root, "agent-working-directory");
    mkdirSync(catalogRoot, { recursive: true });
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(workingRoot, { recursive: true });
    mkdirSync(join(alphaRoot, "missions", "alpha-active", "slices", "01-live-work"), { recursive: true });
    mkdirSync(join(betaRoot, "missions", "beta-scaffold"), { recursive: true });
    catalogRoot = realpathSync(catalogRoot);
    alphaRoot = realpathSync(alphaRoot);
    betaRoot = realpathSync(betaRoot);
    writeFileSync(join(catalogRoot, "workspace.yaml"), `schema: openrig.workspace/v0alpha1
projects:
  - id: alpha
    root: ${relative(catalogRoot, alphaRoot)}
  - id: beta
    root: ${relative(catalogRoot, betaRoot)}
`);
    writeFileSync(join(alphaRoot, "SPEC.md"), "# Alpha project\n");
    writeFileSync(join(alphaRoot, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
id: alpha
install:
  intent: SPEC.md
  skills: [project-skill]
`);
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "SPEC.md"), "# Alpha mission\n");
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "PROGRESS.md"), "# Alpha mission progress\n\n- [x] Story 2 complete\n- [ ] Release acceptance pending\n");
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "mission.yaml"), `schema: openrig.mission/v0alpha1
kind: mission
composition:
  mission_markdown:
    spec: SPEC.md
`);
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "slices", "01-live-work", "SPEC.md"), `---
id: OPR.0.5.8.13
---
# Alpha slice
`);
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "slices", "01-live-work", "PROGRESS.md"), "# Alpha slice progress\n\n- [x] Story 3 complete\n- [ ] Public publish pending\n");
    writeFileSync(join(betaRoot, "SPEC.md"), "# Beta project\n");
    writeFileSync(join(betaRoot, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
id: beta
install:
  intent: SPEC.md
`);
    writeFileSync(join(betaRoot, "missions", "beta-scaffold", "SPEC.md"), "# Beta mission\n");
    writeFileSync(join(betaRoot, "missions", "beta-scaffold", "mission.yaml"), `schema: openrig.mission/v0alpha1
kind: mission
composition:
  mission_markdown:
    spec: SPEC.md
`);
    writeFileSync(join(skillsRoot, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: [system-skill]\n");
    for (const id of ["system-skill", "topology-skill", "project-skill"]) {
      mkdirSync(join(skillsRoot, id));
      writeFileSync(join(skillsRoot, id, "SKILL.md"), `---\nname: ${id}\ndescription: Use when testing ${id}.\n---\n\n# ${id}\n`);
    }
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
    execFileSync("git", ["-C", root, "add", "managed-skills"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "catalog fixture"]);

    execFileSync("git", ["-C", alphaRoot, "init", "-q"]);
    execFileSync("git", ["-C", alphaRoot, "config", "user.email", "test@openrig.invalid"]);
    execFileSync("git", ["-C", alphaRoot, "config", "user.name", "OpenRig Test"]);
    execFileSync("git", ["-C", alphaRoot, "add", "."]);
    execFileSync("git", ["-C", alphaRoot, "commit", "-qm", "project fixture"]);
    writeFileSync(join(workingRoot, "README.md"), "# Agent working directory\n");
    execFileSync("git", ["-C", workingRoot, "init", "-q"]);
    execFileSync("git", ["-C", workingRoot, "config", "user.email", "test@openrig.invalid"]);
    execFileSync("git", ["-C", workingRoot, "config", "user.name", "OpenRig Test"]);
    execFileSync("git", ["-C", workingRoot, "add", "README.md"]);
    execFileSync("git", ["-C", workingRoot, "commit", "-qm", "working directory fixture"]);
    savedWorkspaceRoot = process.env["OPENRIG_WORKSPACE_ROOT"];
    savedCatalogPath = process.env["OPENRIG_WORKSPACE_CATALOG_PATH"];
    savedSkillsRoot = process.env["OPENRIG_SKILLS_ROOT"];
    process.env["OPENRIG_WORKSPACE_ROOT"] = catalogRoot;
    delete process.env["OPENRIG_WORKSPACE_CATALOG_PATH"];
    process.env["OPENRIG_SKILLS_ROOT"] = skillsRoot;
  });

  afterEach(() => {
    if (savedWorkspaceRoot === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
    else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspaceRoot;
    if (savedCatalogPath === undefined) delete process.env["OPENRIG_WORKSPACE_CATALOG_PATH"];
    else process.env["OPENRIG_WORKSPACE_CATALOG_PATH"] = savedCatalogPath;
    if (savedSkillsRoot === undefined) delete process.env["OPENRIG_SKILLS_ROOT"];
    else process.env["OPENRIG_SKILLS_ROOT"] = savedSkillsRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("honors the configured project catalog path", async () => {
    const separateWorkspace = join(root, "workspace-without-catalog");
    mkdirSync(separateWorkspace);
    process.env["OPENRIG_WORKSPACE_ROOT"] = separateWorkspace;
    process.env["OPENRIG_WORKSPACE_CATALOG_PATH"] = join(catalogRoot, "workspace.yaml");

    const result = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install", "--project", "alpha", "--json",
      ]);
    });

    expect(result.exitCode).toBeUndefined();
    const plan = JSON.parse(result.logs.join("")) as { position: { projectId: string; projectRoot: string } };
    expect(plan.position).toMatchObject({ projectId: "alpha", projectRoot: alphaRoot });
  });

  it("selects two declared roots and returns stable intent with current progress", async () => {
    const alpha = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "alpha", "--mission", "alpha-active", "--slice", "01-live-work", "--json",
      ]);
    });
    expect(alpha.exitCode).toBeUndefined();
    const alphaPlan = JSON.parse(alpha.logs.join("")) as {
      position: { projectId: string; projectRoot: string; mission: string; slice: string; frontier: string };
      pieces: Array<{ altitude: string; address: string; path: string; exists: boolean; source: string }>;
      skills: string[];
    };
    expect(alphaPlan.position).toMatchObject({
      projectId: "alpha",
      projectRoot: alphaRoot,
      mission: "alpha-active",
      slice: "01-live-work",
      frontier: "slice",
    });
    expect(alphaPlan.skills).toEqual(["project-skill"]);
    expect(alphaPlan.pieces.map(({ altitude, address, exists, source }) => ({ altitude, address, exists, source }))).toEqual([
      { altitude: "project", address: "project:SPEC.md", exists: true, source: "manifest" },
      { altitude: "mission", address: "mission:SPEC.md", exists: true, source: "manifest" },
      { altitude: "mission", address: "mission:PROGRESS.md", exists: true, source: "default" },
      { altitude: "slice", address: "mission:slices/01-live-work/SPEC.md", exists: true, source: "explicit" },
      { altitude: "slice", address: "mission:slices/01-live-work/PROGRESS.md", exists: true, source: "default" },
    ]);
    expect(alphaPlan.pieces.every((piece) => piece.path.startsWith(alphaRoot))).toBe(true);
    expect(alphaPlan.pieces.filter((piece) => piece.address.endsWith("PROGRESS.md")).map((piece) => readFileSync(piece.path, "utf8"))).toEqual([
      "# Alpha mission progress\n\n- [x] Story 2 complete\n- [ ] Release acceptance pending\n",
      "# Alpha slice progress\n\n- [x] Story 3 complete\n- [ ] Public publish pending\n",
    ]);

    const beta = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "beta", "--mission", "beta-scaffold", "--json",
      ]);
    });
    expect(beta.exitCode).toBeUndefined();
    const betaPlan = JSON.parse(beta.logs.join("")) as {
      position: { projectId: string; projectRoot: string; mission: string; slice: null; frontier: string };
      pieces: Array<{ altitude: string; address: string; path: string; exists: boolean; source: string }>;
    };
    expect(betaPlan.position).toMatchObject({
      projectId: "beta",
      projectRoot: betaRoot,
      mission: "beta-scaffold",
      slice: null,
      frontier: "mission",
    });
    expect(JSON.stringify(betaPlan)).not.toContain(alphaRoot);
    expect(betaPlan.pieces.map(({ altitude, address, exists, source }) => ({ altitude, address, exists, source }))).toEqual([
      { altitude: "project", address: "project:SPEC.md", exists: true, source: "manifest" },
      { altitude: "mission", address: "mission:SPEC.md", exists: true, source: "manifest" },
      { altitude: "mission", address: "mission:PROGRESS.md", exists: false, source: "default" },
    ]);
    expect(betaPlan.pieces.every((piece) => piece.path.startsWith(betaRoot))).toBe(true);
  });

  it("delivers project context and reconciles the composed skill loadout in one operation without dirtying product Git", async () => {
    const run = () => captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "alpha", "--runtime", "codex", "--cwd", workingRoot,
        "--topology", "topology-skill", "--apply-skills", "--json",
      ]);
    });

    const first = await run();
    expect(first.exitCode).toBeUndefined();
    const installed = JSON.parse(first.logs.join("")) as {
      pieces: Array<{ address: string; exists: boolean }>;
      skillLoadout: { entries: Array<{ id: string; selectedBy: string[] }> };
      skillProjection: { ok: boolean; applied: boolean; receipts: Array<{ id: string; status: string }> };
    };
    expect(installed.pieces).toEqual(expect.arrayContaining([expect.objectContaining({ address: "project:SPEC.md", exists: true })]));
    expect(installed.skillLoadout.entries.map((entry) => [entry.id, entry.selectedBy])).toEqual([
      ["project-skill", ["project"]],
      ["system-skill", ["system"]],
      ["topology-skill", ["topology"]],
    ]);
    expect(installed.skillProjection).toMatchObject({ ok: true, applied: true });
    expect(installed.skillProjection.receipts.every((receipt) => receipt.status === "current")).toBe(true);
    expect(readFileSync(join(workingRoot, ".agents", "skills", "project-skill", "SKILL.md"), "utf8"))
      .toBe(readFileSync(join(skillsRoot, "project-skill", "SKILL.md"), "utf8"));
    expect(execFileSync("git", ["-C", alphaRoot, "status", "--short"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", workingRoot, "status", "--short"], { encoding: "utf8" })).toBe("");

    const second = await run();
    expect(second.exitCode).toBeUndefined();
    expect(JSON.parse(second.logs.join("")).skillProjection).toMatchObject({ ok: true, applied: false });
    expect(execFileSync("git", ["-C", alphaRoot, "status", "--short"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", workingRoot, "status", "--short"], { encoding: "utf8" })).toBe("");
  });

  it("refuses work-install before projecting when a foreign ignore covers only skill entrypoints", async () => {
    mkdirSync(join(skillsRoot, "project-skill", "scripts"), { recursive: true });
    writeFileSync(join(skillsRoot, "project-skill", "scripts", "helper.txt"), "managed helper\n");
    execFileSync("git", ["-C", root, "add", "managed-skills/project-skill/scripts/helper.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "multi-file skill fixture"]);
    const ignorePath = join(workingRoot, ".agents", "skills", ".gitignore");
    mkdirSync(join(ignorePath, ".."), { recursive: true });
    writeFileSync(ignorePath, "/*/SKILL.md\n");
    execFileSync("git", ["-C", workingRoot, "add", ".agents/skills/.gitignore"]);
    execFileSync("git", ["-C", workingRoot, "commit", "-qm", "foreign partial skill ignore"]);

    const run = () => captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "alpha", "--runtime", "codex", "--cwd", workingRoot,
        "--topology", "topology-skill", "--apply-skills", "--json",
      ]);
    });
    const result = await run();
    const repeated = await run();
    const output = JSON.parse(result.logs.join("")) as {
      skillProjection: { ok: boolean; applied: boolean; errors: Array<{ code: string }> };
    };
    const repeatedOutput = JSON.parse(repeated.logs.join("")) as typeof output;

    expect(result.exitCode).toBe(1);
    expect(output.skillProjection).toMatchObject({
      ok: false,
      applied: false,
      errors: [{ code: "git_exclusion_failed" }],
    });
    expect(repeated.exitCode).toBe(1);
    expect(repeatedOutput.skillProjection).toMatchObject({
      ok: false,
      applied: false,
      errors: [{ code: "git_exclusion_failed" }],
    });
    expect(readFileSync(ignorePath, "utf8")).toBe("/*/SKILL.md\n");
    expect(execFileSync("git", ["-C", workingRoot, "status", "--short", "--untracked-files=all"], { encoding: "utf8" })).toBe("");
    expect(() => readFileSync(join(workingRoot, ".agents", "skills", "project-skill", "SKILL.md"), "utf8")).toThrow();
    expect(() => readFileSync(join(workingRoot, ".openrig", "skill-loadouts", "codex.json"), "utf8")).toThrow();
  });

  it("delivers extant pieces byte-for-byte in plan order and marks absent pieces", async () => {
    const args = [
      "node", "rig", "context", "work-install",
      "--project", "alpha", "--mission", "alpha-active", "--slice", "01-live-work", "--json",
    ];
    const planOnly = await captureLogs(async () => {
      await makeCommand().parseAsync(args);
    });
    const delivered = await captureLogs(async () => {
      await makeCommand().parseAsync([...args, "--deliver"]);
    });

    expect(delivered.exitCode).toBeUndefined();
    const delivery = JSON.parse(delivered.logs.join("")) as {
      pieces: Array<{ altitude: string; address: string; path: string; exists: boolean; content?: string }>;
    };
    expect(delivery.pieces.map(({ path, content }) => ({ path, content }))).toEqual(
      delivery.pieces.map(({ path }) => ({ path, content: readFileSync(path, "utf8") })),
    );
    const planShape = {
      ...delivery,
      pieces: delivery.pieces.map(({ content: _content, ...piece }) => piece),
    };
    expect(JSON.stringify(planShape, null, 2)).toBe(planOnly.logs.join(""));

    const missing = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "beta", "--mission", "beta-scaffold", "--deliver", "--json",
      ]);
    });
    const missingDelivery = JSON.parse(missing.logs.join("")) as {
      pieces: Array<{ altitude: string; address: string; path: string; exists: boolean; content?: string }>;
    };
    expect(missingDelivery.pieces.map((piece) => ({
      address: piece.address,
      exists: piece.exists,
      hasContent: Object.hasOwn(piece, "content"),
    }))).toEqual([
      { address: "project:SPEC.md", exists: true, hasContent: true },
      { address: "mission:SPEC.md", exists: true, hasContent: true },
      { address: "mission:PROGRESS.md", exists: false, hasContent: false },
    ]);

    const planHuman = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "beta", "--mission", "beta-scaffold",
      ]);
    });
    expect(planHuman.logs).toEqual([
      `project beta: ${betaRoot}`,
      `project project:SPEC.md [manifest] ${join(betaRoot, "SPEC.md")}`,
      `mission mission:SPEC.md [manifest] ${join(betaRoot, "missions", "beta-scaffold", "SPEC.md")}`,
      `mission mission:PROGRESS.md [default] (absent: ${join(betaRoot, "missions", "beta-scaffold", "PROGRESS.md")})`,
      "skills  (none selected by project)",
    ]);

    const human = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "beta", "--mission", "beta-scaffold", "--deliver",
      ]);
    });
    expect(human.logs.filter((line) => line.startsWith("=== "))).toEqual([
      "=== project project:SPEC.md ===",
      "=== mission mission:SPEC.md ===",
      `=== mission:PROGRESS.md (absent: ${join(betaRoot, "missions", "beta-scaffold", "PROGRESS.md")}) ===`,
    ]);
  });

  it("resolves an explicit slice by directory name or unique dotted id and refuses missing or ambiguous matches", async () => {
    const run = (slice: string) => captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "alpha", "--mission", "alpha-active", "--slice", slice, "--json",
      ]);
    });

    for (const selector of ["01-live-work", "OPR.0.5.8.13"]) {
      const result = await run(selector);
      expect(result.exitCode).toBeUndefined();
      const body = JSON.parse(result.logs.join("")) as {
        position: { slice: string; sliceRoot: string; frontier: string };
        pieces: Array<{ address: string }>;
      };
      expect(body.position).toMatchObject({
        slice: "01-live-work",
        sliceRoot: join(alphaRoot, "missions", "alpha-active", "slices", "01-live-work"),
        frontier: "slice",
      });
      expect(body.pieces.slice(-2).map((piece) => piece.address)).toEqual([
        "mission:slices/01-live-work/SPEC.md",
        "mission:slices/01-live-work/PROGRESS.md",
      ]);
    }

    const missing = await run("OPR.0.5.8.99");
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.logs.join(""))).toMatchObject({
      ok: false,
      error: { code: "slice_not_found", candidates: ["01-live-work"] },
    });

    const duplicateRoot = join(alphaRoot, "missions", "alpha-active", "slices", "02-duplicate-id");
    mkdirSync(duplicateRoot, { recursive: true });
    writeFileSync(join(duplicateRoot, "SPEC.md"), `---
id: OPR.0.5.8.13
---
# Duplicate slice id
`);
    const ambiguous = await run("OPR.0.5.8.13");
    expect(ambiguous.exitCode).toBe(1);
    expect(JSON.parse(ambiguous.logs.join(""))).toMatchObject({
      ok: false,
      error: {
        code: "slice_identity_ambiguous",
        candidates: ["01-live-work", "02-duplicate-id"],
      },
    });
  });

  it("refuses a selected project id that names two catalog roots", async () => {
    for (const projectRoot of [alphaRoot, betaRoot]) {
      writeFileSync(join(projectRoot, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
id: duplicate
`);
    }
    writeFileSync(join(catalogRoot, "workspace.yaml"), `schema: openrig.workspace/v0alpha1
projects:
  - id: duplicate
    root: ${relative(catalogRoot, alphaRoot)}
  - id: duplicate
    root: ${relative(catalogRoot, betaRoot)}
`);

    const result = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install", "--project", "duplicate", "--json",
      ]);
    });
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.logs.join("")) as {
      ok: boolean;
      error: { code: string };
      position?: { projectRoot?: string };
    };
    expect(body).toMatchObject({ ok: false, error: { code: "project_identity_ambiguous" } });
    expect(body.position?.projectRoot).toBeUndefined();
  });
});
