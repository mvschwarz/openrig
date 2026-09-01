import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  let savedWorkspaceRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openrig-context-work-install-"));
    catalogRoot = join(root, "catalog");
    alphaRoot = join(root, "alpha-root");
    betaRoot = join(root, "unrelated-beta-tree");
    mkdirSync(catalogRoot, { recursive: true });
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
`);
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "SPEC.md"), "# Alpha mission\n");
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "mission.yaml"), `schema: openrig.mission/v0alpha1
kind: mission
composition:
  mission_markdown:
    spec: SPEC.md
`);
    writeFileSync(join(alphaRoot, "missions", "alpha-active", "slices", "01-live-work", "SPEC.md"), "# Alpha slice\n");
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
    savedWorkspaceRoot = process.env["OPENRIG_WORKSPACE_ROOT"];
    process.env["OPENRIG_WORKSPACE_ROOT"] = catalogRoot;
  });

  afterEach(() => {
    if (savedWorkspaceRoot === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
    else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspaceRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("selects two declared project roots independently and replaces the operative frame", async () => {
    const alpha = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "alpha", "--mission", "alpha-active", "--slice", "01-live-work", "--json",
      ]);
    });
    expect(alpha.exitCode).toBeUndefined();
    const alphaPlan = JSON.parse(alpha.logs.join("")) as {
      position: { projectId: string; projectRoot: string; mission: string; slice: string; frontier: string };
      pieces: Array<{ altitude: string; address: string; path: string; exists: boolean }>;
    };
    expect(alphaPlan.position).toMatchObject({
      projectId: "alpha",
      projectRoot: alphaRoot,
      mission: "alpha-active",
      slice: "01-live-work",
      frontier: "slice",
    });
    expect(alphaPlan.pieces.map(({ altitude, address, exists }) => ({ altitude, address, exists }))).toEqual([
      { altitude: "project", address: "project:SPEC.md", exists: true },
      { altitude: "mission", address: "mission:SPEC.md", exists: true },
      { altitude: "slice", address: "mission:slices/01-live-work/SPEC.md", exists: true },
    ]);
    expect(alphaPlan.pieces.every((piece) => piece.path.startsWith(alphaRoot))).toBe(true);

    const beta = await captureLogs(async () => {
      await makeCommand().parseAsync([
        "node", "rig", "context", "work-install",
        "--project", "beta", "--mission", "beta-scaffold", "--json",
      ]);
    });
    expect(beta.exitCode).toBeUndefined();
    const betaPlan = JSON.parse(beta.logs.join("")) as {
      position: { projectId: string; projectRoot: string; mission: string; slice: null; frontier: string };
      pieces: Array<{ address: string; path: string }>;
    };
    expect(betaPlan.position).toMatchObject({
      projectId: "beta",
      projectRoot: betaRoot,
      mission: "beta-scaffold",
      slice: null,
      frontier: "mission",
    });
    expect(JSON.stringify(betaPlan)).not.toContain(alphaRoot);
    expect(betaPlan.pieces.every((piece) => piece.path.startsWith(betaRoot))).toBe(true);
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
