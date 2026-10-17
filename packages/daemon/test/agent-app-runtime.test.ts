import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { listAgentAppPresets, loadAgentAppPreset } from "../src/domain/agent-app-presets.js";
import { AgentAppRuntimeAdapter, withAgentApps } from "../src/adapters/agent-app-runtime-adapter.js";
import {
  AGENT_APP_RUNG_INVENTORY,
  CLAUDE_ACTIVITY_RUNG_INVENTORY,
  CODEX_ACTIVITY_RUNG_INVENTORY,
  TMUX_GENERIC_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.close();
});

function presets(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-apps-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const GOOD = "format: 1\nname: synth\ncommand: synth-app --serve\nmaintainer: Example Maintainer\nlimits: [resume unsupported]\n";

describe("agent app presets", () => {
  it("loads a preset with the fields this format reads", () => {
    const dir = presets({ "synth.yaml": GOOD });
    expect(loadAgentAppPreset("synth", dir)).toEqual({ ok: true, preset: {
      name: "synth", command: "synth-app --serve", maintainer: "Example Maintainer", limits: ["resume unsupported"], path: join(dir, "synth.yaml") } });
  });

  it.each([
    ["a missing file", {}, "missing", `no agent app preset named "synth" is installed`],
    ["another format", { "synth.yaml": GOOD.replace("format: 1", "format: 2") }, "incompatible", "it declares format 2; this OpenRig reads format 1"],
    ["a field this format doesn't read", { "synth.yaml": `${GOOD}resume: --resume {token}\n` }, "incompatible", "unknown field resume"],
    ["a name that isn't the file's", { "synth.yaml": GOOD.replace("name: synth", "name: other") }, "incompatible", `its name is "other", not "synth"`],
    ["no command", { "synth.yaml": GOOD.replace("command: synth-app --serve\n", "") }, "incompatible", "command must be a non-empty string"],
    ["YAML that doesn't parse", { "synth.yaml": "format: [1" }, "incompatible", "it isn't valid YAML"],
  ])("says why it can't use %s", (_label, files, kind, text) => {
    const found = loadAgentAppPreset("synth", presets(files as Record<string, string>));
    expect(found).toMatchObject({ ok: false, kind });
    expect(!found.ok && found.message).toContain(text);
  });

  it("calls a preset file with a name it can't take incompatible, and never looks outside the directory", () => {
    const dir = presets({ "My_App.yaml": GOOD.replace("name: synth", "name: My_App") });
    expect(loadAgentAppPreset("My_App", dir)).toMatchObject({ ok: false, kind: "incompatible",
      message: expect.stringContaining("its name must be lowercase letters, digits and hyphens") });
    expect(listAgentAppPresets(dir)).toEqual([expect.objectContaining({ ok: false, kind: "incompatible" })]);
    // A file one level up, in a directory this test owns, is never reached by "../outside".
    const parent = presets({ "outside.yaml": GOOD.replace("name: synth", "name: outside") });
    const inner = join(parent, "agent-apps");
    mkdirSync(inner);
    expect(loadAgentAppPreset("../outside", inner)).toMatchObject({ ok: false, kind: "missing" });
  });

  it("reserves every built-in runtime name", () => {
    for (const name of ["claude-code", "codex", "pi", "omp", "terminal", "stub"]) {
      const dir = presets({ [`${name}.yaml`]: GOOD.replace("name: synth", `name: ${name}`) });
      expect(loadAgentAppPreset(name, dir)).toMatchObject({ ok: false, kind: "incompatible",
        message: `"${name}" is a built-in runtime; an agent app preset can't use that name` });
    }
  });

  it("lists every preset file, usable or not", () => {
    const dir = presets({ "synth.yaml": GOOD, "codex.yaml": GOOD.replace("name: synth", "name: codex"), "notes.txt": "x" });
    expect(listAgentAppPresets(dir).map(found => found.ok)).toEqual([false, true]);
  });
});

describe("the agent app adapter", () => {
  function adapter(dir: string) {
    const tmux = {
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "node"),
      sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    };
    return { tmux, app: new AgentAppRuntimeAdapter("synth", { tmux, presetsDir: () => dir }) };
  }
  const binding = { tmuxSession: "w@r" } as NodeBinding;

  it("types the preset's command into the seat's pane", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": GOOD }));
    expect(await app.launchHarness(binding, { name: "w@r" })).toEqual({ ok: true });
    expect(tmux.sendShellCommand).toHaveBeenCalledWith("w@r", "synth-app --serve", undefined, { stageIfLong: true, execInScript: true });
  });

  it("refuses resume and fork without starting anything", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": GOOD }));
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: "t" }))
      .toEqual({ ok: false, error: `Resume is unsupported: agent app "synth" is launch-only. No session was started.` });
    expect(await app.launchHarness(binding, { name: "w@r", forkSource: { kind: "native_id", value: "p" } }))
      .toMatchObject({ ok: false, error: expect.stringContaining(`Fork is unsupported: agent app "synth" is launch-only.`) });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("is ready while the pane runs something other than a shell", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": GOOD }));
    expect(await app.checkReady(binding)).toEqual({ ready: true });
    tmux.getPaneCommand.mockResolvedValue("bash");
    expect(await app.checkReady(binding)).toMatchObject({ ready: false, code: "app_not_running" });
  });

  it("places nothing and says so", async () => {
    const { app } = adapter(presets({ "synth.yaml": GOOD }));
    const plan = { entries: [{ effectiveId: "skill-a" }] } as never;
    expect(await app.project(plan, binding)).toEqual({ projected: [], skipped: ["skill-a"], failed: [],
      warnings: [`Agent app "synth" places no resources; 1 not placed: skill-a`] });
  });
});

describe("the runtime adapter map with agent apps", () => {
  const builtIn = (runtime: string) => ({ runtime }) as RuntimeAdapter;
  const builtIns = () => ({ "claude-code": builtIn("claude-code"), codex: builtIn("codex"), pi: builtIn("pi"), omp: builtIn("omp"), stub: builtIn("stub"), terminal: builtIn("terminal") });
  const tmux = {} as Pick<TmuxAdapter, "hasSession" | "getPaneCommand" | "sendShellCommand">;

  it("returns each built-in adapter as it is, even when a preset file takes its name", () => {
    const original = builtIns();
    const dir = presets({ "codex.yaml": GOOD.replace("name: synth", "name: codex"), "synth.yaml": GOOD });
    const map = withAgentApps(original, { tmux, presetsDir: () => dir });
    for (const [name, adapter] of Object.entries(original)) expect(map[name as keyof typeof original]).toBe(adapter);
    expect(Object.keys(map)).toEqual(Object.keys(original));
  });

  it("resolves an installed app, and nothing for one that isn't installed", () => {
    const dir = presets({ "synth.yaml": GOOD });
    const map: Record<string, RuntimeAdapter> = withAgentApps(builtIns(), { tmux, presetsDir: () => dir });
    expect(map["synth"]).toBeInstanceOf(AgentAppRuntimeAdapter);
    expect(map["synth"]!.runtime).toBe("synth");
    expect("synth" in map).toBe(true);
    expect(map["no-such-app"]).toBeUndefined();
    expect("no-such-app" in map).toBe(false);
  });
});

describe("activity for an agent app", () => {
  it("gives built-ins the inventories they had, and agent apps their own", () => {
    expect(runtimeRungInventory("claude-code")).toBe(CLAUDE_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("codex")).toBe(CODEX_ACTIVITY_RUNG_INVENTORY);
    for (const runtime of ["pi", "omp", "terminal", "stub", null]) expect(runtimeRungInventory(runtime)).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth")).toBe(AGENT_APP_RUNG_INVENTORY);
  });

  function seat(inventory: typeof AGENT_APP_RUNG_INVENTORY) {
    const svc = new SeatActivityService({ tmux: {} as never, defaultWindowSeconds: 3 });
    svc.declareRungInventory({ seatNodeId: "n1", sessionName: "w@r" }, inventory);
    let seq = 0;
    const sample = (activity: "working" | "idle-at-prompt") => svc.reportEvidence({ seatNodeId: "n1", sessionName: "w@r",
      rung: "window-sampling", sourceId: "tmux:window-activity", seq: ++seq, observedAt: new Date().toISOString(), activity });
    return { svc, sample, state: () => svc.getSeatState("n1")! };
  }

  it("reads a quiet screen as unknown and a changing one as working, decided by window sampling", () => {
    const s = seat(AGENT_APP_RUNG_INVENTORY);
    expect(s.state()).toMatchObject({ activity: "unknown", decidedBy: null });
    s.sample("idle-at-prompt");
    expect(s.state()).toMatchObject({ activity: "unknown", decidedBy: null, needsInputEvidence: null });
    s.sample("working");
    expect(s.state()).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
    s.sample("idle-at-prompt");
    expect(s.state()).toMatchObject({ activity: "unknown", decidedBy: null });
  });

  it("still reads a quiet screen as idle for the generic floor built-ins use", () => {
    const s = seat(TMUX_GENERIC_RUNG_INVENTORY);
    s.sample("idle-at-prompt");
    expect(s.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "window-sampling" });
  });
});

describe("identity for an agent app", () => {
  function reconcile(runtime: string, command: string) {
    const db = createFullTestDb(); dbs.push(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'work.worker', ?, '/tmp')").run(runtime);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('s1', 'n1', 'w@r', 'running', 'ready')").run();
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b1', 'n1', 'tmux', 'w@r', '%1')").run();
    const tmux = { listSessions: vi.fn(async () => [{ name: "w@r" }] as never), getPanePid: vi.fn(async () => 10), getPaneCommand: vi.fn(async () => command) };
    return { rec: new SeatIdentityReconciler({ db, tmux, now: () => new Date("2026-10-17T12:00:00Z") }), verdict: () => new SeatIdentityStore(db).getForNode("n1") };
  }

  it.each(["node", "bash"])("is unconfirmed, not verified, with %s in the pane", async (command) => {
    const r = reconcile("synth", command);
    await r.rec.reconcileAll();
    expect(r.verdict()).toMatchObject({ verdict: "unconfirmed", reason: "process_identity_unconfirmed", evidence: { matchedLayer: null } });
  });

  it.each([["pi", "node"], ["omp", "node"], ["terminal", "bash"]])("stays verified for %s, as before", async (runtime, command) => {
    const r = reconcile(runtime, command);
    await r.rec.reconcileAll();
    expect(r.verdict()).toMatchObject({ verdict: "verified", reason: null });
  });
});
