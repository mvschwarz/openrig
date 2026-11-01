import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { lstartToMinTs } from "../src/domain/codex-thread-id.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { createFullTestDb } from "./helpers/test-app.js";

const PARENT = "01970000-0000-7000-8000-000000000001";
const CHILD = "01970000-0000-7000-8000-000000000002";
const STARTED = "Sat Jan  1 12:00:00 2000";
const ROLE = "Review this project's changes as the independent builder.";

describe("late Codex fork identity", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let events: EventBus;
  let repo: RigRepository;
  let tmux: TmuxAdapter;
  let adapter: CodexRuntimeAdapter;
  let orch: StartupOrchestrator;
  let input: StartupInput;
  let processRows: NativeProcessRow[];
  let threadId: string | undefined;
  let reads: number;
  let availableAfter: number;
  let readinessSeconds: number;
  let duringRead: (() => void) | undefined;
  let identityReads: Array<[number, string | undefined]>;
  let pidOnlyRecord: boolean;

  beforeEach(() => {
    db = createFullTestDb();
    registry = new SessionRegistry(db);
    events = new EventBus(db);
    repo = new RigRepository(db);
    const rig = repo.createRig("fork-recovery");
    const node = repo.addNode(rig.id, "builder", { runtime: "codex", cwd: "/fixture/project" });
    const session = registry.registerSession(node.id, "builder@fork-recovery");
    registry.updateStatus(session.id, "running");
    const binding = registry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%317" });
    threadId = undefined;
    reads = 0;
    availableAfter = 0;
    readinessSeconds = 30;
    duringRead = undefined;
    identityReads = [];
    pidOnlyRecord = false;
    processRows = [
      { pid: 900, ppid: 1, pgid: 900, tpgid: 901, executableName: "sh", startedAt: STARTED, command: "sh" },
      { pid: 901, ppid: 900, pgid: 901, tpgid: 901, executableName: "codex", startedAt: STARTED,
        command: `codex fork ${PARENT}`, argv: ["codex", "fork", PARENT] },
    ];
    tmux = {
      hasSession: vi.fn(async () => true),
      listPanes: vi.fn(async () => [{ id: "%317" }]),
      getPanePid: vi.fn(async () => 900),
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› "),
      sendShellCommand: vi.fn(async () => ({ ok: true })),
      sendText: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapter;
    adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: { readFile: () => ROLE, exists: file => file.endsWith("role.md"), writeFile: () => {}, mkdirp: () => {}, listFiles: () => [] },
      listProcesses: async () => processRows,
      readThreadIdByPid: (pid, identity) => {
        identityReads.push([pid, identity]);
        duringRead?.();
        // A reused PID: an older record matches the PID alone, never this process's start time.
        if (pidOnlyRecord) return identity === undefined ? threadId : undefined;
        return ++reads > availableAfter ? threadId : undefined;
      },
      readinessSettings: { resolveOne: () => ({ value: readinessSeconds }) } as unknown as Pick<SettingsStore, "resolveOne">,
      sleep: async () => {},
    });
    orch = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux, sleep: async () => {} });
    input = {
      rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { ...binding, cwd: node.cwd! }, adapter,
      plan: { runtime: "codex", cwd: node.cwd!, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: [], isRestore: false, forkSource: { kind: "native_id", value: PARENT },
    };
  });

  afterEach(() => { db.close(); });

  function lifecycle() {
    // Construct again to exercise recovery from persisted state, not adapter memory.
    return new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: registry, eventBus: events,
      tmuxAdapter: tmux, startupOrchestrator: orch, runtimeAdapters: { codex: adapter } });
  }

  it("delivers the role when the child ID arrives after the old 20-attempt bound", async () => {
    threadId = CHILD;
    availableAfter = 21;
    expect(await orch.startNode(input)).toMatchObject({ ok: true, continuityOutcome: "forked" });
    expect(tmux.sendText).toHaveBeenCalledWith(input.binding.tmuxSession, ROLE);
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(true);
  });

  it("retains the role after capture times out and continues the same child only once", async () => {
    const first = await orch.startNode(input);
    expect(first).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(first.ok ? "" : first.errors.join(" ")).toContain("rig seat continue");
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", PARENT)).toBe(false);
    threadId = CHILD;
    orch = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux, sleep: async () => {} });
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: true, continuityOutcome: "forked" });
    expect(identityReads.at(-1)).toEqual([901, STARTED]);
    expect(tmux.sendShellCommand).toHaveBeenCalledTimes(1);
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendText).toHaveBeenCalledWith(input.binding.tmuxSession, ROLE);
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(true);
    expect(registry.getSessionsForRig(input.rigId).map(s => s.id)).toEqual([input.sessionId]);
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, code: "continuation_unavailable" });
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
  });

  it("never certifies the parent token as the new fork", async () => {
    threadId = PARENT;
    expect(await orch.startNode(input)).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", PARENT)).toBe(false);
  });

  it("ends a launch on time when an identity read answers after the readiness budget", async () => {
    readinessSeconds = 1;
    const hung = new CodexRuntimeAdapter({
      tmux,
      fsOps: { readFile: () => ROLE, exists: file => file.endsWith("role.md"), writeFile: () => {}, mkdirp: () => {}, listFiles: () => [] },
      listProcesses: async () => processRows,
      // A slow home probe: the child's id arrives only after the 1 s budget has passed.
      readThreadIdByPid: () => new Promise<string | undefined>((resolve) => setTimeout(() => resolve(CHILD), 3_000)),
      readinessSettings: { resolveOne: () => ({ value: readinessSeconds }) } as unknown as Pick<SettingsStore, "resolveOne">,
      sleep: async () => {},
    });
    const started = Date.now();
    expect(await orch.startNode({ ...input, adapter: hung })).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(tmux.sendText).not.toHaveBeenCalled();
  }, 15_000);

  it("uses the configured capture bound without sending the role after it expires", async () => {
    readinessSeconds = 2;
    threadId = CHILD;
    availableAfter = 9;
    expect(await orch.startNode(input)).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(reads).toBe(8);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each([undefined, PARENT])("keeps the role pending while the observed child ID is %s", async token => {
    await orch.startNode(input);
    threadId = token;
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(orch.canContinueStartup(input.nodeId, input.sessionId)).toBe(true);
    threadId = CHILD;
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: true });
    expect(tmux.sendShellCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["different parent", "resume", "fresh", "background", "sibling", "helper", "missing start"])("refuses an unproved fork process: %s", async shape => {
    await orch.startNode(input);
    threadId = CHILD;
    const child = processRows[1]!;
    if (shape === "different parent") { child.command = `codex fork ${CHILD}`; child.argv = ["codex", "fork", CHILD]; }
    if (shape === "resume") { child.command = `codex resume ${PARENT}`; child.argv = ["codex", "resume", PARENT]; }
    if (shape === "fresh") { child.command = "codex"; child.argv = ["codex"]; }
    if (shape === "background") child.pgid = 800;
    if (shape === "sibling") processRows.push({ ...child, pid: 902 });
    if (shape === "helper") { child.command = `helper codex fork ${PARENT}`; child.argv = ["helper", "codex", "fork", PARENT]; child.executableName = "helper"; }
    if (shape === "missing start") delete child.startedAt;
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(orch.canContinueStartup(input.nodeId, input.sessionId)).toBe(true);
  });

  it.each(["reused PID", "different parent", "background", "helper"])("refuses an unproved child at launch: %s", async shape => {
    threadId = CHILD;
    const child = processRows[1]!;
    if (shape === "reused PID") pidOnlyRecord = true;
    if (shape === "different parent") { child.command = `codex fork ${CHILD}`; child.argv = ["codex", "fork", CHILD]; }
    if (shape === "background") child.pgid = 800;
    if (shape === "helper") { child.command = `helper codex fork ${PARENT}`; child.argv = ["helper", "codex", "fork", PARENT]; child.executableName = "helper"; }
    readinessSeconds = 1;
    const result = await orch.startNode(input);
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(result.ok ? "" : result.errors.join(" ")).toContain("waiting to be sent");
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(false);
    expect(orch.canContinueStartup(input.nodeId, input.sessionId)).toBe(true);
  });

  it("accepts a single spawning launcher chain and reads the deepest process's identity", async () => {
    await orch.startNode(input);
    threadId = CHILD;
    processRows[1]!.command = `codex -c example=fork -s workspace-write fork --add-dir /fixture/queue ${PARENT}`;
    processRows[1]!.argv = ["codex", "-c", "example=fork", "-s", "workspace-write", "fork", "--add-dir", "/fixture/queue", PARENT];
    processRows.push({ ...processRows[1]!, pid: 902, ppid: 901, command: "codex", argv: ["codex"] });
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: true, continuityOutcome: "forked" });
    expect(identityReads.at(-1)).toEqual([902, STARTED]);
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
  });

  it("refuses a replacement process during the PID-owned identity read", async () => {
    await orch.startNode(input);
    threadId = CHILD;
    duringRead = () => { processRows[1]!.startedAt = "Sat Jan  1 12:01:00 2000"; };
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("refuses a changed binding before committing the observed token or sending context", async () => {
    await orch.startNode(input);
    threadId = CHILD;
    duringRead = () => { registry.updateBinding(input.nodeId, { tmuxPane: "%different" }); };
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(input.sessionId)).toEqual({ startup_status: "attention_required" });
    const event = db.prepare("SELECT payload FROM events WHERE node_id = ? ORDER BY seq DESC LIMIT 1").get(input.nodeId) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ type: "node.startup_failed", sessionId: input.sessionId });
    expect(JSON.parse(event.payload).forkContextPending).toBeUndefined();
  });

  it.each(["verified", "unavailable", "read failure"])("does not overwrite a newer occupant's pending startup (%s)", async observation => {
    await orch.startNode(input);
    threadId = observation === "unavailable" ? undefined : CHILD;
    let replacementId: string | undefined;
    duringRead = () => {
      const replacement = registry.registerSession(input.nodeId, "replacement@fork-recovery");
      replacementId = replacement.id;
      registry.updateStatus(replacement.id, "running");
      registry.updateStartupStatus(replacement.id, "attention_required");
      events.emit({ type: "node.startup_failed", rigId: input.rigId, nodeId: input.nodeId,
        sessionId: replacement.id, error: "replacement needs consent", freshContextPending: true });
      if (observation === "read failure") throw new Error("native identity read failed");
    };
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(input.sessionId)).toEqual({ startup_status: "attention_required" });
    expect(orch.canContinueStartup(input.nodeId, replacementId!)).toBe(true);
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("keeps protected conflicting metadata and leaves the role owed", async () => {
    await orch.startNode(input);
    registry.updateResumeToken(input.sessionId, "codex_id", "01970000-0000-7000-8000-000000000003", "operator");
    threadId = CHILD;
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(registry.resumeTokenMatches(input.sessionId, "codex_id", "01970000-0000-7000-8000-000000000003")).toBe(true);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(orch.canContinueStartup(input.nodeId, input.sessionId)).toBe(true);
  });

  it("does not replay an uncertain delivery after reconstructing the service", async () => {
    await orch.startNode(input);
    threadId = CHILD;
    vi.mocked(tmux.sendText).mockRejectedValue(new Error("transport interrupted during paste"));
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(orch.canContinueStartup(input.nodeId, input.sessionId)).toBe(false);
    expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, code: "continuation_unavailable" });
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
  });

  it("consumes the pending attempt before concurrent continuations can both send", async () => {
    await orch.startNode(input);
    threadId = CHILD;
    const results = await Promise.all([lifecycle().continueStartup("builder@fork-recovery"), lifecycle().continueStartup("builder@fork-recovery")]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendShellCommand).toHaveBeenCalledTimes(1);
  });
  describe("with the real Codex record reader", () => {
    const START = lstartToMinTs(STARTED)!;
    let codexHome: string;
    let logs: BetterSqlite3.Database;

    beforeEach(() => {
      codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "fork-records-"));
      logs = new BetterSqlite3(path.join(codexHome, "logs_2.sqlite"));
      logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)");
      const state = new BetterSqlite3(path.join(codexHome, "state_5.sqlite"));
      state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
      for (const id of [CHILD, "01970000-0000-7000-8000-00000000000f"]) state.prepare("INSERT INTO threads VALUES (?, 'cli', ?)").run(id, `${codexHome}/${id}.jsonl`);
      state.close();
      // No injected reader: launch and continue read these files through CodexThreadIdResolver.
      adapter = new CodexRuntimeAdapter({
        tmux, codexHome,
        fsOps: { readFile: () => ROLE, exists: file => file.endsWith("role.md"), writeFile: () => {}, mkdirp: () => {}, listFiles: () => [] },
        listProcesses: async () => processRows,
        readinessSettings: { resolveOne: () => ({ value: 1 }) } as unknown as Pick<SettingsStore, "resolveOne">,
        sleep: async () => {},
      });
      input = { ...input, adapter };
    });
    afterEach(() => { logs.close(); fs.rmSync(codexHome, { recursive: true, force: true }); });

    /** One log row for pid 901, from process instance `instance`, at `ts` (the child's start second by default). */
    const record = (thread: string, instance: string, ts = START) =>
      logs.prepare("INSERT INTO logs (ts, ts_nanos, process_uuid, thread_id) VALUES (?, 0, ?, ?)").run(ts, `pid:901:${instance}`, thread);

    it("launch accepts a child whose only record is in its start second", async () => {
      record(CHILD, "child-instance");
      expect(await orch.startNode(input)).toMatchObject({ ok: true, continuityOutcome: "forked" });
      expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(true);
      expect(tmux.sendText).toHaveBeenCalledWith(input.binding.tmuxSession, ROLE);
    });

    it("continue delivers once a child's start-second record appears after the launch timed out", async () => {
      expect(await orch.startNode(input)).toMatchObject({ ok: false, startupStatus: "attention_required" });
      record(CHILD, "child-instance");
      expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: true, continuityOutcome: "forked" });
      expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(true);
      expect(tmux.sendText).toHaveBeenCalledTimes(1);
    });

    it("still refuses a retired process's start-second record when that process logged earlier (PID reuse)", async () => {
      record("01970000-0000-7000-8000-00000000000f", "retired-instance", START - 30);
      record("01970000-0000-7000-8000-00000000000f", "retired-instance");
      expect(await orch.startNode(input)).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(await lifecycle().continueStartup("builder@fork-recovery")).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(tmux.sendText).not.toHaveBeenCalled();
      expect(registry.resumeTokenMatches(input.sessionId, "codex_id", "01970000-0000-7000-8000-00000000000f")).toBe(false);
    });

    it("picks the child over a retired process when both logged in the start second", async () => {
      record("01970000-0000-7000-8000-00000000000f", "retired-instance", START - 30);
      record("01970000-0000-7000-8000-00000000000f", "retired-instance");
      record(CHILD, "child-instance");
      expect(await orch.startNode(input)).toMatchObject({ ok: true });
      expect(registry.resumeTokenMatches(input.sessionId, "codex_id", CHILD)).toBe(true);
    });

    it("refuses when two process instances first logged in the start second", async () => {
      record(CHILD, "first-instance");
      record("01970000-0000-7000-8000-00000000000f", "second-instance");
      expect(await orch.startNode(input)).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(tmux.sendText).not.toHaveBeenCalled();
    });
  });
});
