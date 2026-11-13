import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { deriveSessionName } from "../src/domain/session-name.js";

// Load the production resolver with daemon A, then select seat B. Native/process IO is scripted;
// PID/start-time log resolution and thread/transcript lookup use real isolated SQLite databases.
const homes = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "original-codex-homes-"));
  const daemon = path.join(root, "daemon-A"); fs.mkdirSync(daemon);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = daemon;
  return { root, daemon, previous };
});
afterAll(() => {
  if (homes.previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = homes.previous;
  rmSync(homes.root, { recursive: true, force: true });
});
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
const original = "11111111-1111-4111-8111-111111111111";
const replacement = "22222222-2222-4222-8222-222222222222";
const startedAt = "Sun Sep  6 23:52:32 2026", ts = Math.floor(Date.parse(startedAt) / 1000);

function records(home: string, nativeId: string, current: boolean) {
  mkdirSync(home, { recursive: true });
  const transcript = join(home, `${nativeId}.jsonl`); writeFileSync(transcript, "{}\n");
  const logs = new Database(join(home, "logs_2.sqlite"));
  logs.exec("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)");
  logs.prepare("INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (?,0,?,?)").run(ts + (current ? 1 : -1), "pid:1235:fixture", nativeId); logs.close();
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
  state.prepare("INSERT OR REPLACE INTO threads VALUES (?,'cli',?)").run(nativeId, transcript); state.close();
  return transcript;
}
function fixture(selection: "member" | "account-switch", wrong = false) {
  const root = mkdtempSync(join(homes.root, "seat-")), seatHome = join(root, "B");
  const oldTranscript = records(homes.daemon, original, false);
  const selectedTranscript = records(seatHome, wrong ? replacement : original, true);
  const db = createFullTestDb(); cleanups.push(() => db.close());
  const store = new ContextUsageStore(db, { stateDir: root, codexHome: homes.daemon });
  const processes = () => [{ pid: 1234, ppid: 1, pgid: 1234, tpgid: 1235, executableName: "zsh", command: "zsh", startedAt },
    { pid: 1235, ppid: 1234, pgid: 1235, tpgid: 1235, executableName: "codex",
      command: `/opt/native/codex resume ${wrong ? replacement : original}`, argv: ["/opt/native/codex", "resume", wrong ? replacement : original], startedAt }];
  const setup = createTestApp(db, { listProcesses: async () => processes(), appDeps: { contextUsageStore: store, terminalBearerToken: "fixture-token" } });
  vi.spyOn(ProcessCensus.prototype, "list").mockImplementation(async () => processes());
  setup.tmuxAdapter.getPanePid = vi.fn(async () => 1234);
  setup.tmuxAdapter.getPaneCommand = vi.fn(async () => "codex");
  setup.tmuxAdapter.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: root, width: 120, height: 40, active: true }]);
  const rig = setup.rigRepo.createRig(`original-codex-${selection}`);
  const node = setup.rigRepo.addNode(rig.id, "lead", { runtime: "codex", cwd: root });
  db.prepare(selection === "member" ? "UPDATE nodes SET env_json=? WHERE id=?" : "UPDATE nodes SET account_home=? WHERE id=?")
    .run(selection === "member" ? JSON.stringify({ CODEX_HOME: seatHome }) : seatHome, node.id);
  const name = deriveSessionName(rig.name, node.logicalId);
  const source = setup.sessionRegistry.registerSession(node.id, name);
  setup.sessionRegistry.updateStatus(source.id, "running");
  setup.sessionRegistry.updateResumeToken(source.id, "codex_id", original);
  const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
  setup.sessionRegistry.updateStatus(source.id, "exited"); setup.sessionRegistry.clearBinding(node.id);
  setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: wrong ? "present" : "absent" } as never));
  if (wrong) {
    const current = setup.sessionRegistry.registerSession(node.id, name);
    setup.sessionRegistry.updateStatus(current.id, "running");
    setup.sessionRegistry.updateResumeToken(current.id, "codex_id", replacement);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    new SeatIdentityStore(db).upsert({ nodeId: node.id, sessionName: name, verdict: "verified", evidenceSource: "pane_process", reason: null,
      observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPanePid: 1234, observedPid: 1235, observedCommand: "codex", matchedLayer: 1 } });
  }
  const request = (body?: unknown) => setup.app.request(`/api/startup/${rig.id}/nodes/${node.id}/original` +
    (body ? "" : `?snapshotId=${snapshot.id}&historySessionId=${source.id}`), {
    method: body ? "POST" : "GET", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { db, setup, store, node, seatHome, selectedTranscript, oldTranscript, request, snapshot, source,
    args: (revision: string) => ({ action: "resume", snapshotId: snapshot.id, historySessionId: source.id, revision, operationId: randomUUID(),
      expectedOriginal: { nodeId: node.id, sessionName: name, runtime: "codex", nativeId: original } }) };
}

it.each(["member", "account-switch"] as const)("uses the selected %s Codex home for post-launch and already-running original proof", async selection => {
  const f = fixture(selection), paths: Array<string | null> = [];
  const lookup = f.store.readCodexTranscriptPath.bind(f.store);
  vi.spyOn(f.store, "readCodexTranscriptPath").mockImplementation((...args) => { const path = lookup(...args); paths.push(path); return path; });
  const review = await f.request(); expect(review.status).toBe(200);
  const args = f.args((await review.json()).revision);
  const native = vi.spyOn(CodexResumeAdapter.prototype, "resume").mockResolvedValue({ ok: true });
  const resumed = await f.request(args), result = await resumed.json();
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, code: "resumed" }); expect(resumed.status).toBe(200);
  expect(native).toHaveBeenCalledOnce(); expect(native.mock.calls[0]![11]).toBe(f.seatHome);
  expect(await (await f.request(args)).json()).toMatchObject({ ok: true, code: "already_running_original", nativeEffect: false });
  expect(native).toHaveBeenCalledOnce(); expect(paths).toEqual([f.selectedTranscript, f.selectedTranscript]);
  expect(paths).not.toContain(f.oldTranscript);
});

it("leaves a verified different current Codex identity in the selected home untouched", async () => {
  const f = fixture("account-switch", true);
  const review = await f.request(); expect(review.status).toBe(200);
  const launch = vi.spyOn(f.setup.restoreOrchestrator, "launchSingleNode"), kill = vi.spyOn(f.setup.tmuxAdapter, "killSession");
  const before = f.db.prepare("SELECT * FROM sessions").all();
  const response = await f.request(f.args((await review.json()).revision));
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ ok: false, partial: true, identityEvidence: { code: "expected_identity_mismatch" } });
  expect(launch).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
  expect(f.db.prepare("SELECT * FROM sessions").all()).toEqual(before);
});
