import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentAppPresets, loadAgentAppPreset } from "../src/domain/agent-app-presets.js";
import { AgentAppRuntimeAdapter, seatAdapter, withAgentAppResolver, withAgentApps } from "../src/adapters/agent-app-runtime-adapter.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
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
import { agentAppPaneActivity, classifyPaneActivity } from "../src/domain/session-transport.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
    ["a missing file", {}, "missing", `no community harness preset named "synth" is installed`],
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

  it.each([
    ["&&", "node app.mjs && echo started"],
    ["|", "node app.mjs | tee app.log"],
    [";", "cd /srv/app; node app.mjs"],
    ["a redirection (< or >)", "node app.mjs > app.log"],
    ["$(…) (command substitution)", "node $(which app).mjs"],
    // The shell reads \" as a literal quote, so the && here would run.
    ["a backslash escape", 'echo \\" && echo injected \\"'],
    ["a backslash escape", 'node app.mjs --label "say \\"hi\\""'],
    ["! (history expansion)", "node app.mjs --last !!"],
    ["! (history expansion)", 'node app.mjs --label "hi!"'],
  ])("keeps shell syntax (%s) out of the launch line typed into the pane's shell", (shown, command) => {
    const found = loadAgentAppPreset("synth", presets({ "synth.yaml": GOOD.replace("command: synth-app --serve", `command: ${command}`) }));
    expect(found).toMatchObject({ ok: false, kind: "incompatible" });
    expect(!found.ok && found.message).toContain(`command must be a single program and its arguments; shell syntax such as ${shown} isn't supported: put it in a script and name the script`);
  });

  it("accepts a program whose arguments are quoted, operators inside single quotes included", () => {
    const command = `node "/srv/my apps/app.mjs" --label 'a|b && c!' --name "two words" --path 'C:\\apps\\x'`;
    const found = loadAgentAppPreset("synth", presets({ "synth.yaml": GOOD.replace("command: synth-app --serve", `command: ${command}`) }));
    expect(found).toMatchObject({ ok: true, preset: { command } });
  });

  it("reserves every built-in runtime name", () => {
    for (const name of ["claude-code", "codex", "pi", "omp", "terminal", "stub"]) {
      const dir = presets({ [`${name}.yaml`]: GOOD.replace("name: synth", `name: ${name}`) });
      expect(loadAgentAppPreset(name, dir)).toMatchObject({ ok: false, kind: "incompatible",
        message: `"${name}" is a built-in runtime; a community harness preset can't use that name` });
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

  it("types the command through the seat's launch environment, as a real daemon does", async () => {
    const { tmux } = adapter(presets({ "synth.yaml": GOOD }));
    const command = vi.fn(async (_session: string, cmd: string, target?: { runtime?: string }) => `/usr/bin/env OPENRIG_RUNTIME=${target?.runtime} ${cmd}`);
    const app = new AgentAppRuntimeAdapter("synth", { tmux, seatLaunchEnvironment: { command }, presetsDir: () => presets({ "synth.yaml": GOOD }) });
    expect(await app.launchHarness(binding, { name: "w@r" })).toEqual({ ok: true });
    expect(command).toHaveBeenCalledWith("w@r", "synth-app --serve", { runtime: "synth" });
    expect(tmux.sendShellCommand).toHaveBeenCalledWith("w@r", "/usr/bin/env OPENRIG_RUNTIME=synth synth-app --serve", undefined, { stageIfLong: true, execInScript: true });
  });

  it("refuses resume and fork without starting anything", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": GOOD }));
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: "t" }))
      .toEqual({ ok: false, error: `Resume is unsupported: community harness "synth" is launch-only. No session was started.` });
    expect(await app.launchHarness(binding, { name: "w@r", forkSource: { kind: "native_id", value: "p" } }))
      .toMatchObject({ ok: false, error: expect.stringContaining(`Fork is unsupported: community harness "synth" is launch-only.`) });
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
      warnings: [`Community harness "synth" places no resources; 1 not placed: skill-a`] });
  });
});

describe("relaunching a seat", () => {
  const builtIn = (runtime: string) => ({ runtime }) as RuntimeAdapter;
  const tmux = {} as Pick<TmuxAdapter, "hasSession" | "getPaneCommand" | "sendShellCommand">;
  function map(dir: string) {
    return withAgentAppResolver({ codex: builtIn("codex"), terminal: builtIn("terminal") } as Record<string, RuntimeAdapter>, { tmux, presetsDir: () => dir });
  }

  it("keeps the map's keys the built-ins, and returns them as they are", () => {
    const m = map(presets({ "synth.yaml": GOOD }));
    expect(Object.keys(m)).toEqual(["codex", "terminal"]);
    expect(seatAdapter(m, "codex", null)).toBe(m["codex"]);
    expect(m["synth"]).toBeUndefined();
  });

  it("resolves an agent app only for a seat launched for it", () => {
    const m = map(presets({ "synth.yaml": GOOD }));
    expect(seatAdapter(m, "synth", "synth")).toBeInstanceOf(AgentAppRuntimeAdapter);
    // A free-text runtime that only matches a preset's name gets no adapter, as before the preset existed.
    expect(seatAdapter(m, "synth", null)).toBeUndefined();
    expect(seatAdapter(m, "synth", "other-app")).toBeUndefined();
  });

  it("gives an agent app's seat no adapter once its preset is gone", () => {
    expect(seatAdapter(map(presets({})), "synth", "synth")).toBeUndefined();
  });
});

describe("the agent app selection recorded on a session", () => {
  it("is read back only for the session it was recorded on", () => {
    const db = createFullTestDb(); dbs.push(db);
    const registry = new SessionRegistry(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'work.worker', 'synth', '/tmp')").run();
    const launched = registry.registerSession("n1", "work-worker@r");
    registry.recordAgentAppSelection(launched.id, "synth");
    const claimed = registry.registerClaimedSession("n1", "work-worker@r");
    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions.find(s => s.id === launched.id)?.agentApp).toBe("synth");
    expect(sessions.find(s => s.id === claimed.id)).not.toHaveProperty("agentApp");
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
    // Only a seat launched for the app gets its inventory; a free-text runtime keeps the generic floor, as before.
    expect(runtimeRungInventory("synth", "synth")).toBe(AGENT_APP_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth")).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth", "other-app")).toBe(TMUX_GENERIC_RUNG_INVENTORY);
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

describe("the pane reader for an agent app", () => {
  it("turns an idle-looking screen into unknown for an agent app, and keeps work, attention and built-ins as they were", () => {
    const idle = classifyPaneActivity("some output\n❯ ");
    expect(idle.state).toBe("agent_idle");
    expect(agentAppPaneActivity(idle, "synth")).toEqual({ state: "unknown", reason: "agent_app_no_idle_signal", evidence: idle.evidence });
    for (const agentApp of [null, undefined, ""]) expect(agentAppPaneActivity(idle, agentApp)).toBe(idle);
    const prompt = classifyPaneActivity("Do you want to proceed? (y/n)");
    expect(prompt.state).toBe("attention");
    expect(agentAppPaneActivity(prompt, "synth")).toBe(prompt);
    const busy = classifyPaneActivity("⠋ Working (esc to interrupt)");
    expect(agentAppPaneActivity(busy, "synth")).toBe(busy);
  });
});

describe("activity after the seat's occupant is replaced under the same session name", () => {
  it("follows the new occupant's own selection: a free-text occupant's quiet screen reads idle, as on main", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-app-swap-"));
    dirs.push(scratch);
    const socket = join(scratch, "tmux.sock");
    const tmux = async (...args: string[]) => (await promisify(execFile)("tmux", ["-S", socket, ...args])).stdout;
    const db = new Database(join(scratch, "state.db"));
    dbs.push(db);
    db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, runtime TEXT);
      CREATE TABLE sessions(id INTEGER, node_id TEXT, session_name TEXT, status TEXT, agent_app TEXT);
      CREATE TABLE bindings(node_id TEXT, attachment_type TEXT);`);
    try {
      const adapter = new TmuxAdapter(async () => { throw new Error("unexpected shell path"); }, undefined, async argv => tmux(...argv.slice(1)));
      // A reader clock ten seconds ahead makes the real window timestamps quiet without sleeping.
      const svc = new SeatActivityService({ tmux: adapter, defaultWindowSeconds: 3, now: () => new Date(Date.now() + 10_000) });
      db.prepare("INSERT INTO nodes VALUES ('n1', 'synth')").run();
      db.prepare("INSERT INTO sessions VALUES (1, 'n1', 'work-worker@r', 'running', 'synth')").run();
      await tmux("new-session", "-d", "-s", "work-worker@r", "sleep 60");
      await svc.pollAllRunningTmuxSeats(db);
      expect(svc.getSeatState("n1")).toMatchObject({ activity: "unknown", decidedBy: null });
      // The same seat and session name, now a free-text self-attach with no recorded selection; no sweep saw it absent.
      db.prepare("INSERT INTO sessions VALUES (2, 'n1', 'work-worker@r', 'running', NULL)").run();
      await svc.pollAllRunningTmuxSeats(db);
      await svc.pollAllRunningTmuxSeats(db);
      expect(svc.getSeatState("n1")).toMatchObject({ activity: "idle-at-prompt", decidedBy: "window-sampling" });
    } finally {
      await tmux("kill-server").catch(() => {});
    }
  });
});

describe("identity for an agent app", () => {
  function reconcile(runtime: string, command: string, agentApp: string | null = null) {
    const db = createFullTestDb(); dbs.push(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'work.worker', ?, '/tmp')").run(runtime);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, agent_app) VALUES ('s1', 'n1', 'w@r', 'running', 'ready', ?)").run(agentApp);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b1', 'n1', 'tmux', 'w@r', '%1')").run();
    const tmux = { listSessions: vi.fn(async () => [{ name: "w@r" }] as never), getPanePid: vi.fn(async () => 10), getPaneCommand: vi.fn(async () => command) };
    return { rec: new SeatIdentityReconciler({ db, tmux, now: () => new Date("2026-10-17T12:00:00Z") }), verdict: () => new SeatIdentityStore(db).getForNode("n1") };
  }

  it.each(["node", "bash"])("is unconfirmed, not verified, with %s in the pane", async (command) => {
    const r = reconcile("synth", command, "synth");
    await r.rec.reconcileAll();
    expect(r.verdict()).toMatchObject({ verdict: "unconfirmed", reason: "process_identity_unconfirmed", evidence: { matchedLayer: null } });
  });

  it.each([["pi", "node"], ["omp", "node"], ["terminal", "bash"], ["synth", "node"]])("stays verified for %s without a recorded app selection, as before", async (runtime, command) => {
    const r = reconcile(runtime, command);
    await r.rec.reconcileAll();
    expect(r.verdict()).toMatchObject({ verdict: "verified", reason: null });
  });
});
