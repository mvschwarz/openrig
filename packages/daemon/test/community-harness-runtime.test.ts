import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listCommunityHarnessPresets, loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { CommunityHarnessRuntimeAdapter, seatAdapter, withCommunityHarnessResolver, withCommunityHarnesses } from "../src/adapters/community-harness-runtime-adapter.js";
import { migrate } from "../src/db/migrate.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import {
  COMMUNITY_HARNESS_RUNG_INVENTORY,
  CLAUDE_ACTIVITY_RUNG_INVENTORY,
  CODEX_ACTIVITY_RUNG_INVENTORY,
  OMP_ACTIVITY_RUNG_INVENTORY,
  PI_ACTIVITY_RUNG_INVENTORY,
  TMUX_GENERIC_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { createFullTestDb, migrationsForFullTestDb } from "./helpers/test-app.js";
import { communityHarnessPaneActivity, classifyPaneActivity } from "../src/domain/session-transport.js";
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
  const dir = mkdtempSync(join(tmpdir(), "community-harnesses-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const GOOD = "format: 1\nname: synth\ncommand: synth-harness --serve\nmaintainer: Example Maintainer\nlimits: [resume unsupported]\n";

it("loads a maintainer's declaration that startup needs assistance, and rejects a mistyped declaration", () => {
  const dir = presets({ "synth.yaml": GOOD + "startup_assisted: true\n" });
  expect(loadCommunityHarnessPreset("synth", dir)).toMatchObject({ ok: true, preset: { startupAssisted: true } });
  writeFileSync(join(dir, "synth.yaml"), GOOD + "startup_assisted: sometimes\n");
  expect(loadCommunityHarnessPreset("synth", dir)).toMatchObject({ ok: false,
    message: expect.stringContaining("startup_assisted must be true or false") });
});

it.each([true, false])("loads first_input=%s independently from other declarations", value => {
  const dir = presets({ "synth.yaml": GOOD + `first_input: ${value}\n` });
  expect(loadCommunityHarnessPreset("synth", dir)).toMatchObject({ ok: true, preset: { firstInput: value } });
  writeFileSync(join(dir, "synth.yaml"), GOOD + "first_input: yes\n");
  expect(loadCommunityHarnessPreset("synth", dir)).toMatchObject({ ok: false, message: expect.stringContaining("first_input must be true or false") });
});

describe("community harness presets", () => {
  it("loads a preset with the fields this format reads", () => {
    const dir = presets({ "synth.yaml": GOOD });
    expect(loadCommunityHarnessPreset("synth", dir)).toEqual({ ok: true, preset: {
      name: "synth", command: "synth-harness --serve", maintainer: "Example Maintainer", limits: ["resume unsupported"], launchResult: false, namesConversation: false, resume: false, startupAssisted: false, firstInput: false, path: join(dir, "synth.yaml") } });
  });

  it.each([
    ["a missing file", {}, "missing", `no community harness preset named "synth" is installed`],
    ["another format", { "synth.yaml": GOOD.replace("format: 1", "format: 2") }, "incompatible", "it declares format 2; this OpenRig reads format 1"],
    ["a field this format doesn't read", { "synth.yaml": `${GOOD}session: --resume {token}\n` }, "incompatible", "unknown field session"],
    ["a name that isn't the file's", { "synth.yaml": GOOD.replace("name: synth", "name: other") }, "incompatible", `its name is "other", not "synth"`],
    ["no command", { "synth.yaml": GOOD.replace("command: synth-harness --serve\n", "") }, "incompatible", "command must be a non-empty string"],
    ["YAML that doesn't parse", { "synth.yaml": "format: [1" }, "incompatible", "it isn't valid YAML"],
  ])("says why it can't use %s", (_label, files, kind, text) => {
    const found = loadCommunityHarnessPreset("synth", presets(files as Record<string, string>));
    expect(found).toMatchObject({ ok: false, kind });
    expect(!found.ok && found.message).toContain(text);
  });

  it("calls a preset file with a name it can't take incompatible, and never looks outside the directory", () => {
    const dir = presets({ "My_App.yaml": GOOD.replace("name: synth", "name: My_App") });
    expect(loadCommunityHarnessPreset("My_App", dir)).toMatchObject({ ok: false, kind: "incompatible",
      message: expect.stringContaining("its name must be lowercase letters, digits and hyphens") });
    expect(listCommunityHarnessPresets(dir)).toEqual([expect.objectContaining({ ok: false, kind: "incompatible" })]);
    // A file one level up, in a directory this test owns, is never reached by "../outside".
    const parent = presets({ "outside.yaml": GOOD.replace("name: synth", "name: outside") });
    const inner = join(parent, "community-harnesses");
    mkdirSync(inner);
    expect(loadCommunityHarnessPreset("../outside", inner)).toMatchObject({ ok: false, kind: "missing" });
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
    const found = loadCommunityHarnessPreset("synth", presets({ "synth.yaml": GOOD.replace("command: synth-harness --serve", `command: ${command}`) }));
    expect(found).toMatchObject({ ok: false, kind: "incompatible" });
    expect(!found.ok && found.message).toContain(`command must be a single program and its arguments; shell syntax such as ${shown} isn't supported: put it in a script and name the script`);
  });

  it("accepts a program whose arguments are quoted, operators inside single quotes included", () => {
    const command = `node "/srv/my apps/app.mjs" --label 'a|b && c!' --name "two words" --path 'C:\\apps\\x'`;
    const found = loadCommunityHarnessPreset("synth", presets({ "synth.yaml": GOOD.replace("command: synth-harness --serve", `command: ${command}`) }));
    expect(found).toMatchObject({ ok: true, preset: { command } });
  });

  it("reserves every built-in runtime name", () => {
    for (const name of ["claude-code", "codex", "pi", "omp", "terminal", "stub"]) {
      const dir = presets({ [`${name}.yaml`]: GOOD.replace("name: synth", `name: ${name}`) });
      expect(loadCommunityHarnessPreset(name, dir)).toMatchObject({ ok: false, kind: "incompatible",
        message: `"${name}" is a built-in runtime; a community harness preset can't use that name` });
    }
  });

  it("lists every preset file, usable or not", () => {
    const dir = presets({ "synth.yaml": GOOD, "codex.yaml": GOOD.replace("name: synth", "name: codex"), "notes.txt": "x" });
    expect(listCommunityHarnessPresets(dir).map(found => found.ok)).toEqual([false, true]);
  });
});

describe("the community harness adapter", () => {
  function adapter(dir: string) {
    const tmux = {
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "node"),
      sendShellCommand: vi.fn(async (_session: string, _command: string, beforeInput?: () => void) => { beforeInput?.(); return { ok: true as const }; }),
    };
    return { tmux, app: new CommunityHarnessRuntimeAdapter("synth", { tmux, presetsDir: () => dir }) };
  }
  const binding = { tmuxSession: "w@r" } as NodeBinding;

  it("types the preset's command into the seat's pane", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": GOOD }));
    expect(await app.launchHarness(binding, { name: "w@r" })).toEqual({ ok: true });
    expect(tmux.sendShellCommand).toHaveBeenCalledWith("w@r", "synth-harness --serve", undefined, { stageIfLong: true, execInScript: true });
  });

  it("types the command through the seat's launch environment, as a real daemon does", async () => {
    const { tmux } = adapter(presets({ "synth.yaml": GOOD }));
    const command = vi.fn(async (_session: string, cmd: string, target?: { runtime?: string }) => `/usr/bin/env OPENRIG_RUNTIME=${target?.runtime} ${cmd}`);
    const app = new CommunityHarnessRuntimeAdapter("synth", { tmux, seatLaunchEnvironment: { command }, presetsDir: () => presets({ "synth.yaml": GOOD }) });
    expect(await app.launchHarness(binding, { name: "w@r" })).toEqual({ ok: true });
    expect(command).toHaveBeenCalledWith("w@r", "synth-harness --serve", { runtime: "synth" });
    expect(tmux.sendShellCommand).toHaveBeenCalledWith("w@r", "/usr/bin/env OPENRIG_RUNTIME=synth synth-harness --serve", undefined, { stageIfLong: true, execInScript: true });
  });

  it("gives each launch a private first-input file, including separate session folders", async () => {
    const dir = presets({ "synth.yaml": GOOD + "names_conversation: true\nresume: true\nfirst_input: true\n" });
    const { tmux } = adapter(dir);
    const app = new CommunityHarnessRuntimeAdapter("synth", { tmux, presetsDir: () => dir,
      launchResultRoot: () => join(dir, "state", "launch-results") });
    const text = "a first turn\n'quoted' $literal\n";
    const paths: string[] = [];
    for (const session of ["seat/a@rig", "seat_a@rig", "seat/a@rig"]) {
      const result = await app.launchHarness({ ...binding, tmuxSession: session }, { name: session, firstInputText: text });
      expect(result.ok).toBe(true);
      expect(result.firstInput?.submission).toBe("unconfirmed");
      const file = result.firstInput!.path;
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(realpathSync(file)).toBe(join(realpathSync(dir), "state", "first-input", encodeURIComponent(session), basename(file)));
      paths.push(file);
    }
    expect(new Set(paths).size).toBe(3);
    expect(paths[0]!.split("/").slice(0, -1)).not.toEqual(paths[1]!.split("/").slice(0, -1));
    tmux.sendShellCommand.mockClear();
    const resumed = await app.launchHarness(binding, { name: "w@r", resumeToken: "saved", resumeType: "community:synth" });
    expect(resumed.firstInput).toBeUndefined();
    expect(tmux.sendShellCommand.mock.calls[0]![1]).toContain("-u OPENRIG_FIRST_INPUT");
  });

  it("reports no passed input when launch staging fails before terminal input", async () => {
    const dir = presets({ "synth.yaml": GOOD.replace("synth-harness --serve", "/bin/true " + "x".repeat(600))
      + "names_conversation: true\nfirst_input: true\n" });
    const exec = vi.fn(async () => "");
    const tmux = new TmuxAdapter(exec, { tmpName: () => "/fixture/stage.txt", bufferName: () => "fixture",
      writeFile: async () => { throw Object.assign(new Error("fixture write denied"), { code: "EACCES" }); }, unlink: async () => {} });
    const app = new CommunityHarnessRuntimeAdapter("synth", { tmux, presetsDir: () => dir,
      launchResultRoot: () => join(dir, "state", "launch-results") });
    const result = await app.launchHarness(binding, { name: "w@r", firstInputText: "first turn" });
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(result.firstInput).toBeUndefined();
  });

  it("does not put a first input through a linked session folder", async () => {
    const dir = presets({ "synth.yaml": GOOD + "first_input: true\n" });
    const outside = presets({ "keep": "unchanged" });
    const root = join(dir, "state", "first-input");
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, "w%40r"));
    const { tmux } = adapter(dir);
    const app = new CommunityHarnessRuntimeAdapter("synth", { tmux, presetsDir: () => dir,
      launchResultRoot: () => join(dir, "state", "launch-results") });
    expect(await app.launchHarness(binding, { name: "w@r", firstInputText: "first turn" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("first-input folder points outside") });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("unchanged");
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
    expect(await app.checkReady(binding)).toMatchObject({ ready: false, code: "harness_not_running" });
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
    return withCommunityHarnessResolver({ codex: builtIn("codex"), terminal: builtIn("terminal") } as Record<string, RuntimeAdapter>, { tmux, presetsDir: () => dir });
  }

  it("keeps the map's keys the built-ins, and returns them as they are", () => {
    const m = map(presets({ "synth.yaml": GOOD }));
    expect(Object.keys(m)).toEqual(["codex", "terminal"]);
    expect(seatAdapter(m, "codex", null)).toBe(m["codex"]);
    expect(m["synth"]).toBeUndefined();
  });

  it("resolves a community harness only for a seat launched for it", () => {
    const m = map(presets({ "synth.yaml": GOOD }));
    expect(seatAdapter(m, "synth", "synth")).toBeInstanceOf(CommunityHarnessRuntimeAdapter);
    // A free-text runtime that only matches a preset's name gets no adapter, as before the preset existed.
    expect(seatAdapter(m, "synth", null)).toBeUndefined();
    expect(seatAdapter(m, "synth", "other-app")).toBeUndefined();
  });

  it("gives a community harness's seat no adapter once its preset is gone", () => {
    expect(seatAdapter(map(presets({})), "synth", "synth")).toBeUndefined();
  });
});

describe("the community harness selection recorded on a session", () => {
  it("keeps schema 114 applied once and maps its existing selection through the renamed field", () => {
    const db = createFullTestDb(); dbs.push(db);
    const migration = migrationsForFullTestDb.find(item => item.name.startsWith("114_"))!;
    expect(migration).toBeDefined();
    const ledgerBefore = db.prepare("SELECT name, applied_at FROM schema_migrations WHERE name = ?").get(migration.name);
    expect(ledgerBefore).toBeDefined();
    const registry = new SessionRegistry(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'work.worker', 'synth', '/tmp')").run();
    const session = registry.registerSession("n1", "work-worker@r");
    registry.recordCommunityHarnessSelection(session.id, "synth");
    const before = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id);
    // Calling migrate on a database that has 114 must skip it, not repeat its ALTER or rewrite data.
    migrate(db, migrationsForFullTestDb);
    expect(db.prepare("SELECT name, applied_at FROM schema_migrations WHERE name = ?").get(migration.name)).toEqual(ledgerBefore);
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toEqual(before);
    expect(registry.getSessionsForRig("rig-1")[0]).toHaveProperty("communityHarness", "synth");
    expect(Object.keys(registry.getSessionsForRig("rig-1")[0]!)).not.toContain(["agent", "App"].join(""));
  });

  it("is read back only for the session it was recorded on", () => {
    const db = createFullTestDb(); dbs.push(db);
    const registry = new SessionRegistry(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'work.worker', 'synth', '/tmp')").run();
    const launched = registry.registerSession("n1", "work-worker@r");
    registry.recordCommunityHarnessSelection(launched.id, "synth");
    const claimed = registry.registerClaimedSession("n1", "work-worker@r");
    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions.find(s => s.id === launched.id)?.communityHarness).toBe("synth");
    expect(sessions.find(s => s.id === claimed.id)).not.toHaveProperty("communityHarness");
  });
});

describe("the runtime adapter map with community harnesses", () => {
  const builtIn = (runtime: string) => ({ runtime }) as RuntimeAdapter;
  const builtIns = () => ({ "claude-code": builtIn("claude-code"), codex: builtIn("codex"), pi: builtIn("pi"), omp: builtIn("omp"), stub: builtIn("stub"), terminal: builtIn("terminal") });
  const tmux = {} as Pick<TmuxAdapter, "hasSession" | "getPaneCommand" | "sendShellCommand">;

  it("returns each built-in adapter as it is, even when a preset file takes its name", () => {
    const original = builtIns();
    const dir = presets({ "codex.yaml": GOOD.replace("name: synth", "name: codex"), "synth.yaml": GOOD });
    const map = withCommunityHarnesses(original, { tmux, presetsDir: () => dir });
    for (const [name, adapter] of Object.entries(original)) expect(map[name as keyof typeof original]).toBe(adapter);
    expect(Object.keys(map)).toEqual(Object.keys(original));
  });

  it("resolves an installed app, and nothing for one that isn't installed", () => {
    const dir = presets({ "synth.yaml": GOOD });
    const map: Record<string, RuntimeAdapter> = withCommunityHarnesses(builtIns(), { tmux, presetsDir: () => dir });
    expect(map["synth"]).toBeInstanceOf(CommunityHarnessRuntimeAdapter);
    expect(map["synth"]!.runtime).toBe("synth");
    expect("synth" in map).toBe(true);
    expect(map["no-such-app"]).toBeUndefined();
    expect("no-such-app" in map).toBe(false);
  });
});

describe("activity for a community harness", () => {
  it("gives built-ins the inventories they had, and community harnesses their own", () => {
    expect(runtimeRungInventory("claude-code")).toBe(CLAUDE_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("codex")).toBe(CODEX_ACTIVITY_RUNG_INVENTORY);
    for (const runtime of ["terminal", "stub", null]) expect(runtimeRungInventory(runtime)).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    expect(runtimeRungInventory("pi")).toBe(PI_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("omp")).toBe(OMP_ACTIVITY_RUNG_INVENTORY);
    // Only a seat launched for the app gets its inventory; a free-text runtime keeps the generic floor, as before.
    expect(runtimeRungInventory("synth", "synth")).toBe(COMMUNITY_HARNESS_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth")).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth", "other-app")).toBe(TMUX_GENERIC_RUNG_INVENTORY);
  });

  function seat(inventory: typeof COMMUNITY_HARNESS_RUNG_INVENTORY) {
    const svc = new SeatActivityService({ tmux: {} as never, defaultWindowSeconds: 3 });
    svc.declareRungInventory({ seatNodeId: "n1", sessionName: "w@r" }, inventory);
    let seq = 0;
    const sample = (activity: "working" | "idle-at-prompt") => svc.reportEvidence({ seatNodeId: "n1", sessionName: "w@r",
      rung: "window-sampling", sourceId: "tmux:window-activity", seq: ++seq, observedAt: new Date().toISOString(), activity });
    return { svc, sample, state: () => svc.getSeatState("n1")! };
  }

  it("reads a quiet screen as unknown and a changing one as working, decided by window sampling", () => {
    const s = seat(COMMUNITY_HARNESS_RUNG_INVENTORY);
    expect(s.state()).toMatchObject({ activity: "unknown", decidedBy: null });
    s.sample("idle-at-prompt");
    expect(s.state()).toMatchObject({ activity: "unknown", decidedBy: null, needsInputEvidence: null });
    s.sample("working");
    expect(s.state()).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
    s.sample("idle-at-prompt");
    expect(s.state()).toMatchObject({ activity: "unknown", decidedBy: null });
  });

  it("reads a quiet omp screen as unknown, never idle, and a changing one as working (#1680)", () => {
    const s = seat(runtimeRungInventory("omp"));
    s.sample("idle-at-prompt");
    expect(s.state()).toMatchObject({ activity: "unknown", decidedBy: null });
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

describe("the pane reader for a community harness", () => {
  it("turns an idle-looking screen into unknown for a community harness, and keeps work, attention and built-ins as they were", () => {
    const idle = classifyPaneActivity("some output\n❯ ");
    expect(idle.state).toBe("agent_idle");
    expect(communityHarnessPaneActivity(idle, "synth")).toEqual({ state: "unknown", reason: "community_harness_no_idle_signal", evidence: idle.evidence });
    for (const communityHarness of [null, undefined, ""]) expect(communityHarnessPaneActivity(idle, communityHarness)).toBe(idle);
    const prompt = classifyPaneActivity("Do you want to proceed? (y/n)");
    expect(prompt.state).toBe("attention");
    expect(communityHarnessPaneActivity(prompt, "synth")).toBe(prompt);
    const busy = classifyPaneActivity("⠋ Working (esc to interrupt)");
    expect(communityHarnessPaneActivity(busy, "synth")).toBe(busy);
  });
});

describe("activity after the seat's occupant is replaced under the same session name", () => {
  it("follows the new occupant's own selection: a free-text occupant's quiet screen reads idle, as on main", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "community-harness-swap-"));
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

describe("identity for a community harness", () => {
  function reconcile(runtime: string, command: string, communityHarness: string | null = null) {
    const db = createFullTestDb(); dbs.push(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'work.worker', ?, '/tmp')").run(runtime);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, agent_app) VALUES ('s1', 'n1', 'w@r', 'running', 'ready', ?)").run(communityHarness);
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
