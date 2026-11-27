import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { withCommunityHarnessResolver } from "../src/adapters/community-harness-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { seatRecordedCommunityHarness } from "../src/domain/session-registry.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

// #4047: a restore launch that couldn't tell a community seat's harness left a bare shell and a newer session row with no
// harness selection. That row hid the selection the seat's earlier session records, so every `rig seat launch --fresh`
// was refused `runtime_adapter_missing`, and nothing could recover the seat. The fresh launch reads the selection from the
// newest session that records one.
describe("#4047: rig seat launch --fresh for a community seat whose newest session lost its harness selection", () => {
  const SEAT = "agy-critic@stuck";
  let home: string;
  let previousHome: string | undefined;
  let db: Database.Database;
  let alive: Set<string>;
  let sendShellCommand: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "community-fresh-"));
    previousHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    const presets = join(home, "community-harnesses");
    mkdirSync(presets);
    // Launch-only, with the first turn passed at launch: the reporter's preset shape.
    writeFileSync(join(presets, "synth.yaml"), "format: 1\nname: synth\ncommand: synth-launch\nmaintainer: Example\nlimits: []\nstartup_assisted: false\nfirst_input: true\n");
    alive = new Set();
    sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const tmux = {
      createSession: vi.fn(async (name: string) => { alive.add(name); return { ok: true }; }),
      killSession: vi.fn(async (name: string) => { alive.delete(name); return { ok: true }; }),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      probeSession: vi.fn(async (name: string) => ({ state: alive.has(name) ? "present" : "absent" })),
      listSessions: vi.fn(async () => [...alive].map(name => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => alive.has(name) ? [{ id: "%1", index: 0, cwd: home, width: 80, height: 24, active: true }] : []),
      getPanePid: vi.fn(async () => 1234),
      getPaneCommand: vi.fn(async () => "node"),
      sendText: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
      setSessionOption: vi.fn(async () => ({ ok: true })),
      startServer: vi.fn(async () => ({ ok: true })),
      capturePaneContent: vi.fn(async () => "synthetic harness"),
      sendShellCommand,
    } as unknown as TmuxAdapter;
    db = createFullTestDb();
    // The relaunch map as startup builds it: the built-ins, plus the hidden resolver for an installed preset.
    const adapters = withCommunityHarnessResolver({} as Record<string, RuntimeAdapter>, { tmux, presetsDir: () => presets });
    app = createTestApp(db, { tmux, adapters });
  });

  afterEach(() => {
    db.close();
    if (previousHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** A seat launched for `synth`, then left by a restore launch whose provisional session recorded no harness. */
  function seedStuckSeat(form: "bare shell" | "detached", opts: { everLaunchedForHarness?: boolean } = {}) {
    const rig = app.rigRepo.createRig("stuck");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES ('p1', ?, 'Agy')").run(rig.id);
    const node = app.rigRepo.addNode(rig.id, "agy.critic", { runtime: "synth", podId: "p1", cwd: home });
    // The seat's saved startup context: its identity turn, which a `first_input` preset takes at launch.
    const identity = { type: "send_text", builtin: "session_identity", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true,
      value: [SEAT, "OpenRig session identity:", "- rig: stuck", "- pod: agy", "- member: critic", "- logical_id: agy.critic", `- session: ${SEAT}`].join("\n") };
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', ?, 'synth')")
      .run(node.id, JSON.stringify([identity]));
    const launched = app.sessionRegistry.registerSession(node.id, SEAT);
    if (opts.everLaunchedForHarness !== false) app.sessionRegistry.recordCommunityHarnessSelection(launched.id, "synth");
    app.sessionRegistry.updateStatus(launched.id, "superseded");
    const provisional = app.sessionRegistry.registerSession(node.id, SEAT);
    if (form === "bare shell") {
      app.sessionRegistry.updateStatus(provisional.id, "running");
      app.sessionRegistry.updateStartupStatus(provisional.id, "attention_required");
      app.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%1" });
      alive.add(SEAT);
    } else {
      app.sessionRegistry.updateStatus(provisional.id, "detached");
    }
    return { node, provisional };
  }

  async function post(path: string, body: unknown) {
    const response = await app.app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }

  it.each(["bare shell", "detached"] as const)("plans a launchable fresh start with its harness (%s)", async form => {
    seedStuckSeat(form);
    const plan = await post(`/api/seat/launch-plan/${encodeURIComponent(SEAT)}`, { fresh: true, stop: form === "bare shell" });
    expect(plan.data["code"], JSON.stringify(plan.data)).toBeUndefined();
    expect(plan.data).toMatchObject({ ok: true, launchable: true });
  });

  it.each(["bare shell", "detached"] as const)("recovers the seat: the harness starts with its first input, and the new session records it (%s)", async form => {
    const { node, provisional } = seedStuckSeat(form);
    const result = await post(`/api/seat/launch/${encodeURIComponent(SEAT)}`,
      { fresh: true, stop: form === "bare shell", reason: "recover a seat a restore left without its harness" });
    expect(result.data["code"], JSON.stringify(result.data)).toBeUndefined();
    expect(result.data).toMatchObject({ ok: true });
    expect(sendShellCommand).toHaveBeenCalledTimes(1);
    const command = sendShellCommand.mock.calls[0]![1] as string;
    expect(command).toContain("synth-launch");
    const firstInput = /OPENRIG_FIRST_INPUT='([^']+)'/.exec(command)?.[1];
    expect(firstInput, command).toBeDefined();
    expect(readFileSync(firstInput!, "utf8")).toContain(`- session: ${SEAT}`);
    const newest = db.prepare("SELECT id, agent_app FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(node.id) as { id: string; agent_app: string | null };
    expect(newest.id).not.toBe(provisional.id);
    expect(newest.agent_app).toBe("synth");
  });

  it("still gives a seat that was never launched for the preset no adapter, as before", async () => {
    // A free-text runtime that only matches an installed preset's name: no session ever recorded the harness.
    seedStuckSeat("detached", { everLaunchedForHarness: false });
    const plan = await post(`/api/seat/launch-plan/${encodeURIComponent(SEAT)}`, { fresh: true });
    expect(plan.data).toMatchObject({ ok: false, code: "runtime_adapter_missing" });
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("takes the newest recorded selection as it is: a newer selection for another app isn't passed over for an older match", async () => {
    const { provisional } = seedStuckSeat("detached");
    app.sessionRegistry.recordCommunityHarnessSelection(provisional.id, "other-app");
    const plan = await post(`/api/seat/launch-plan/${encodeURIComponent(SEAT)}`, { fresh: true });
    expect(plan.data).toMatchObject({ ok: false, code: "runtime_adapter_missing" });
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("leaves a healthy sibling seat as it was", async () => {
    const { node } = seedStuckSeat("bare shell");
    const sibling = app.rigRepo.addNode(node.rigId, "dev.keep", { runtime: "terminal", podId: "p1", cwd: home });
    const siblingSession = app.sessionRegistry.registerSession(sibling.id, "dev-keep@stuck");
    app.sessionRegistry.updateStatus(siblingSession.id, "running");
    app.sessionRegistry.updateBinding(sibling.id, { attachmentType: "tmux", tmuxSession: "dev-keep@stuck", tmuxPane: "%9" });
    alive.add("dev-keep@stuck");
    const before = db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(sibling.id);
    const result = await post(`/api/seat/launch/${encodeURIComponent(SEAT)}`, { fresh: true, stop: true, reason: "recover the stuck seat only" });
    expect(result.data["code"], JSON.stringify(result.data)).toBeUndefined();
    expect(db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(sibling.id)).toEqual(before);
    expect(alive.has("dev-keep@stuck")).toBe(true);
  });
});

describe("seatRecordedCommunityHarness", () => {
  it("reads the newest recorded selection, past newer rows without one, and null when no row records one", () => {
    const db = createFullTestDb();
    try {
      const app = createTestApp(db);
      const rig = app.rigRepo.createRig("lookup");
      const node = app.rigRepo.addNode(rig.id, "dev.worker", { runtime: "synth" });
      expect(seatRecordedCommunityHarness(db, node.id)).toBeNull();
      const first = app.sessionRegistry.registerSession(node.id, "dev-worker@lookup");
      expect(seatRecordedCommunityHarness(db, node.id)).toBeNull();
      app.sessionRegistry.recordCommunityHarnessSelection(first.id, "synth");
      app.sessionRegistry.registerSession(node.id, "dev-worker@lookup");
      expect(seatRecordedCommunityHarness(db, node.id)).toBe("synth");
      const third = app.sessionRegistry.registerSession(node.id, "dev-worker@lookup");
      app.sessionRegistry.recordCommunityHarnessSelection(third.id, "other-app");
      expect(seatRecordedCommunityHarness(db, node.id)).toBe("other-app");
    } finally { db.close(); }
  });

  it("reads null on a schema without the selection column", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
      legacy.prepare("INSERT INTO sessions (id, node_id) VALUES ('s1', 'n1')").run();
      expect(seatRecordedCommunityHarness(legacy, "n1")).toBeNull();
    } finally { legacy.close(); }
  });
});
