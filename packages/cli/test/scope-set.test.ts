// #3616 — `rig scope slice set` and `rig scope mission set`: a rig sets a slice's planned owners and edges and a
// mission's waves and status without its own YAML helper. Each writes only the named field with the shared writer,
// a rerun writes nothing, and the output reads back what the execution view and the status readers now serve.
// The daemon is mocked: nothing here reaches a running daemon.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import YAML from "yaml";

const daemon = vi.hoisted(() => ({
  status: { state: "stopped" } as Record<string, unknown>,
  // What a daemon without the route answers: its catch-all for an unknown /api path (server.ts), as Build's 0.7.18 does.
  reply: (p: string, _body: Record<string, unknown>): { status: number; data: unknown } => ({ status: 404, data: { error: "not_found", path: p } }),
  posted: [] as Array<{ path: string; body: Record<string, unknown> }>,
}));

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return { ...actual, getDaemonStatus: vi.fn(async () => daemon.status), getDaemonUrl: vi.fn(() => "http://localhost:7433") };
});

vi.mock("../src/client.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/client.js");
  return {
    ...actual,
    DaemonClient: class {
      async post(p: string, body: Record<string, unknown>) {
        daemon.posted.push({ path: p, body });
        return daemon.reply(p, body);
      }
    },
  };
});

const { scopeCommand } = await import("../src/commands/scope.js");
const { readMissionReadiness } = await import("../../daemon/src/domain/proof/judgments.js");

let root: string;
let missionsRoot: string;
const mission = () => path.join(missionsRoot, "release-1.0.0");
const sliceFile = (dir: string) => path.join(mission(), "slices", dir, "slice.yaml");
const missionFile = () => path.join(mission(), "mission.yaml");

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

const MISSION = `# The reporter's mission
schema: openrig.mission/v0alpha1
kind: mission
metadata:
  name: release-1.0.0
  status: planned # stays planned until the build starts
composition:
  slices:
    - { ref: slices/01-build/slice.yaml, order: 10, active: true }
    - { ref: slices/02-review/slice.yaml, order: 20, active: true }
arrangement:
  waves:
    - id: w2
      lanes:
        ui: [ OPR.1.0.0.1 ]
`;

const SLICE = `schema: openrig.slice/v0alpha1
kind: slice
composition:
  mission: ../../mission.yaml # relative on purpose
execution:
  gates: [ external:design-review ]
`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-set-"));
  missionsRoot = path.join(root, "missions");
  write(path.join(mission(), "SPEC.md"), "---\nid: OPR.1.0.0\n---\n# Release 1.0.0\n");
  write(missionFile(), MISSION);
  for (const [dir, id] of [["01-build", "OPR.1.0.0.1"], ["02-review", "OPR.1.0.0.2"]] as const) {
    write(path.join(mission(), "slices", dir, "SPEC.md"), `---\nid: ${id}\n---\n# ${dir}\n`);
    write(sliceFile(dir), SLICE);
  }
  daemon.status = { state: "stopped" };
  daemon.reply = (p) => ({ status: 404, data: { error: "not_found", path: p } });
  daemon.posted = [];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [], stderr: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout), origErr = process.stderr.write.bind(process.stderr), origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", "--workspace", root, ...args]);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (!message.startsWith("__EXIT__")) stderr.push(`${message}\n`);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("rig scope slice set", () => {
  it("sets planned owners, reads them back from the execution view, and a rerun writes nothing", async () => {
    const args = ["slice", "set", "01-build", "--mission", "release-1.0.0", "--owner", "build=dev-impl@lab", "review=dev-review@lab"];
    const first = await run(args);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(`slice.yaml written: ${sliceFile("01-build")}`);
    expect(first.stdout).toContain("Planned owners, as the execution view reads them: build → dev-impl@lab, review → dev-review@lab");
    expect(first.stdout).toContain("no queue row is assigned");
    const written = fs.readFileSync(sliceFile("01-build"), "utf8");
    expect(written).toContain("mission: ../../mission.yaml # relative on purpose");
    expect(YAML.parse(written).execution).toEqual({ gates: ["external:design-review"] });
    const again = await run(args);
    expect(again.stdout).toContain("slice.yaml unchanged");
    expect(fs.readFileSync(sliceFile("01-build"), "utf8")).toBe(written);
  });

  it("clears only an owner, and names a component that had none", async () => {
    await run(["slice", "set", "01-build", "--mission", "release-1.0.0", "--owner", "build=dev-impl@lab"]);
    const result = await run(["slice", "set", "01-build", "--mission", "release-1.0.0", "--clear-owner", "build", "absent"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No planned owner to clear for component absent.");
    expect(result.stdout).toContain("Planned owners, as the execution view reads them: none");
    expect(YAML.parse(fs.readFileSync(sliceFile("01-build"), "utf8")).sdlc.components).toEqual([{ id: "build" }]);
  });

  it("writes build-order edges on an existing slice with #3618's checks, and proof readiness reads them", async () => {
    const result = await run(["slice", "set", "02-review", "--mission", "release-1.0.0", "--execution-depends-on", "OPR.1.0.0.1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Build-order edges (execution.depends_on): OPR.1.0.0.1");
    expect(readMissionReadiness(mission()).slices.find((s) => s.scope === "02-review")).toMatchObject({ dependsOn: ["OPR.1.0.0.1"], dependsOnBasis: "slice.yaml" });
    const before = fs.readFileSync(sliceFile("02-review"), "utf8");
    for (const [bad, fact] of [["OPR.1.0.0.2", "cannot depend on itself"], ["OPR.9.9.9.1", "is not a sibling slice dot-ID under OPR.1.0.0"]]) {
      const refused = await run(["slice", "set", "02-review", "--mission", "release-1.0.0", "--execution-depends-on", bad]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(fact);
      expect(refused.stderr).toContain("Nothing was written.");
    }
    expect(fs.readFileSync(sliceFile("02-review"), "utf8")).toBe(before);
    const cleared = await run(["slice", "set", "02-review", "--mission", "release-1.0.0", "--clear-execution-depends-on"]);
    expect(cleared.stdout).toContain("Build-order edges (execution.depends_on): not recorded");
    expect(fs.readFileSync(sliceFile("02-review"), "utf8")).toBe(SLICE);
  });

  it("writes an edge that closes a cycle, and says proof readiness can't read the edges now", async () => {
    await run(["slice", "set", "02-review", "--mission", "release-1.0.0", "--execution-depends-on", "OPR.1.0.0.1"]);
    const result = await run(["slice", "set", "01-build", "--mission", "release-1.0.0", "--execution-depends-on", "OPR.1.0.0.2"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("slice.yaml written");
    expect(result.stdout).toMatch(/Proof readiness can't read this mission's edges now: Cycle involving 0[12]-/);
  });

  it("names an --owner that isn't <component>=<member>@<rig>, and writes nothing", async () => {
    const result = await run(["slice", "set", "01-build", "--mission", "release-1.0.0", "--owner", "dev-impl@lab"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--owner "dev-impl@lab" is not <component>=<member>@<rig>.');
    expect(fs.readFileSync(sliceFile("01-build"), "utf8")).toBe(SLICE);
  });

  it("says when the execution view doesn't read the slice it set", async () => {
    write(missionFile(), MISSION.replace("slices/02-review/slice.yaml, order: 20, active: true", "slices/02-review/slice.yaml, order: 20, active: false"));
    const result = await run(["slice", "set", "02-review", "--mission", "release-1.0.0", "--owner", "build=dev-impl@lab"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The execution view doesn't read this slice.yaml: the slice isn't an active member of mission release-1.0.0's composition.");
  });
});

describe("rig scope mission set --wave", () => {
  it("sets a wave, reads back where the view places each slice, and names an id that matches no slice", async () => {
    const result = await run(["mission", "set", "release-1.0.0", "--wave", "w1", "--slices", "OPR.1.0.0.1, OPR.1.0.0.2,OPR.1.0.0.9"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`mission.yaml written: ${missionFile()}`);
    expect(result.stdout).toContain("Wave w1, as the execution view reads it: OPR.1.0.0.1, OPR.1.0.0.2");
    expect(result.stdout).toContain("OPR.1.0.0.9 matches no active slice's dot-ID in this mission, so the view places nothing for it.");
    expect(result.stdout).toContain("not dispatch: no queue row is created");
    const written = fs.readFileSync(missionFile(), "utf8");
    expect(written).toContain("status: planned # stays planned until the build starts");
    expect(YAML.parse(written).arrangement.waves).toEqual([
      { id: "w2", lanes: { ui: ["OPR.1.0.0.1"] } }, { id: "w1", slices: ["OPR.1.0.0.1", "OPR.1.0.0.2", "OPR.1.0.0.9"] },
    ]);
    expect((await run(["mission", "set", "release-1.0.0", "--wave", "w1", "--slices", "OPR.1.0.0.1,OPR.1.0.0.2,OPR.1.0.0.9"])).stdout)
      .toContain("mission.yaml unchanged");
  });

  it("changes nothing on a lane-shaped wave without --lane, and sets the named lane with it", async () => {
    const refused = await run(["mission", "set", "release-1.0.0", "--wave", "w2", "--slices", "OPR.1.0.0.2"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("Wave w2 is lane-shaped (lanes: ui), and a slices list beside them would hide them.");
    expect(refused.stderr).toContain("Name the lane with --lane <name>.");
    expect(fs.readFileSync(missionFile(), "utf8")).toBe(MISSION);
    const laned = await run(["mission", "set", "release-1.0.0", "--wave", "w2", "--lane", "api", "--slices", "OPR.1.0.0.2"]);
    expect(laned.exitCode).toBe(0);
    expect(laned.stdout).toContain("Wave w2, as the execution view reads it: OPR.1.0.0.1, OPR.1.0.0.2");
    expect(YAML.parse(fs.readFileSync(missionFile(), "utf8")).arrangement.waves[0]).toEqual({ id: "w2", lanes: { ui: ["OPR.1.0.0.1"], api: ["OPR.1.0.0.2"] } });
  });

  it("names a slice whose own execution.wave the view reads first", async () => {
    write(sliceFile("02-review"), `${SLICE.trimEnd()}\n  wave: w9\n`);
    const result = await run(["mission", "set", "release-1.0.0", "--wave", "w1", "--slices", "OPR.1.0.0.2"]);
    expect(result.stdout).toContain("OPR.1.0.0.2 names wave w9 in its own slice.yaml execution.wave, which the view reads first.");
    expect(result.stdout).toContain("Wave w1, as the execution view reads it: no slices");
  });

  it("needs --slices with --wave", async () => {
    const result = await run(["mission", "set", "release-1.0.0", "--wave", "w1"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--wave and --slices go together");
  });
});

describe("rig scope mission set --status", () => {
  it("goes through the daemon with the mission folder it resolved, and shows what the daemon's readers serve", async () => {
    daemon.status = { state: "running", healthy: true, pid: 1234, port: 7433 };
    daemon.reply = () => ({ status: 200, data: { missionId: "release-1.0.0", outcome: "written", served: { status: "active", countsTowardReadiness: true } } });
    const result = await run(["mission", "set", "release-1.0.0", "--status", "active"]);
    expect(result.exitCode).toBe(0);
    expect(daemon.posted).toEqual([{ path: "/api/missions/release-1.0.0/status", body: { status: "active", missionPath: mission() } }]);
    expect(result.stdout).toContain("Status written.");
    expect(result.stdout).toContain("Status, as the readers now serve it: active. It counts toward project readiness.");
    expect(result.stdout).toContain("A status is a label: readiness is judged separately.");
    // The daemon wrote it (here, a mock that wrote nothing): the command didn't also write the file itself.
    expect(fs.readFileSync(missionFile(), "utf8")).toBe(MISSION);
  });

  it("is written here, with the same writer, when no daemon answers", async () => {
    const result = await run(["mission", "set", "release-1.0.0", "--status", "release-candidate"]);
    expect(result.exitCode).toBe(0);
    expect(daemon.posted).toEqual([]);
    expect(result.stdout).toContain("Status written (written here: no daemon answered;");
    expect(result.stdout).toContain("Status, as the readers now serve it: release-candidate. It counts toward project readiness.");
    expect(fs.readFileSync(missionFile(), "utf8")).toBe(MISSION.replace("status: planned", "status: release-candidate"));
    expect((await run(["mission", "set", "release-1.0.0", "--status", "release-candidate"])).stdout).toContain("Status unchanged");
  });

  it("is written here when the running daemon predates the status route", async () => {
    daemon.status = { state: "running", healthy: true, pid: 1234, port: 7433 };
    const result = await run(["mission", "set", "release-1.0.0", "--status", "paused"]);
    expect(result.exitCode).toBe(0);
    expect(daemon.posted).toHaveLength(1);
    expect(result.stdout).toContain("written here: the running daemon has no status route; it predates this command");
    expect(result.stdout).toContain("It doesn't count toward project readiness (only active and release-candidate do).");
    expect(YAML.parse(fs.readFileSync(missionFile(), "utf8")).metadata.status).toBe("paused");
  });

  it("reports the status route's own not-found, and doesn't write it here instead", async () => {
    daemon.status = { state: "running", healthy: true, pid: 1234, port: 7433 };
    daemon.reply = () => ({ status: 404, data: { error: "mission_not_found", missionId: "release-1.0.0", missionPath: mission() } });
    const result = await run(["mission", "set", "release-1.0.0", "--status", "active"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The daemon didn't write the status (mission_not_found)");
    expect(fs.readFileSync(missionFile(), "utf8")).toBe(MISSION);
  });

  it("reports a daemon that couldn't write it, and doesn't write it here instead", async () => {
    daemon.status = { state: "running", healthy: true, pid: 1234, port: 7433 };
    daemon.reply = () => ({ status: 500, data: { error: "mission_status_write_failed", message: "mission.yaml: it can't be parsed" } });
    const result = await run(["mission", "set", "release-1.0.0", "--status", "active"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The daemon didn't write the status (mission_status_write_failed): mission.yaml: it can't be parsed.");
    expect(fs.readFileSync(missionFile(), "utf8")).toBe(MISSION);
  });
});
