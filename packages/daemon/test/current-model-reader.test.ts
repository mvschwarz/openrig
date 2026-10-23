import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { CurrentModelReader } from "../src/domain/model-divergence/current-model-reader.js";
import { parseSqliteUtcMs } from "../src/domain/sqlite-time.js";
import * as recordReaders from "../src/domain/model-divergence/effective-model-readers.js";
import { readClaudeModelObservation, readCodexModelObservation } from "../src/domain/model-divergence/effective-model-readers.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(runtime = "claude-code") {
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "observed-model-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const rigs = new RigRepository(db), sessions = new SessionRegistry(db), identities = new SeatIdentityStore(db);
  const rig = rigs.createRig("studio");
  const node = rigs.addNode(rig.id, "editor", { runtime, model: "configured-model", cwd: dir });
  const session = sessions.registerSession(node.id, "editor@studio"); sessions.updateStatus(session.id, "running");
  sessions.updateBinding(node.id, { tmuxSession: "editor@studio", tmuxPane: "%1" });
  const tenure = sessions.currentOccupantTenure(node.id)!;
  const boot = parseSqliteUtcMs(tenure.bootAt), stamp = new Date(boot + 2_000).toISOString();
  const id = "11111111-1111-4111-8111-111111111111";
  const path = join(dir, `${id}.jsonl`);
  const claudeRecord = (timestamp: string | undefined = stamp, model = "response-model") => JSON.stringify({ timestamp, type: "assistant", message: { role: "assistant", model, content: "PRIVATE_MARKER_NOT_A_MODEL" } }) + "\n";
  writeFileSync(path, runtime === "pi" ? [
    { type: "session", version: 3, id: "pi-session", timestamp: new Date(boot).toISOString(), cwd: dir },
    { type: "message", id: "own-message", timestamp: stamp, message: { role: "assistant", provider: "example", model: "response-model", stopReason: "stop", content: [] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n" : claudeRecord());
  identities.upsert({ nodeId: node.id, verdict: "verified", evidenceSource: "pane_process", reason: null,
    evidence: { registeredPane: "%1", observedPid: 10, observedCommand: "claude", matchedLayer: 1 }, sessionName: "editor@studio", observedAt: stamp });
  const processRows = [{ pid: 10, ppid: 1, command: "-sh", startedAt: new Date(boot).toISOString() },
    { pid: 20, ppid: 10, command: runtime === "pi" ? `node ${dir}/pi-runner.mjs --session-name editor@studio --state-root ${dir} --cwd ${dir} --launch-id launch` : `${runtime === "codex" ? "codex" : "claude"} --session-id ${id}`, startedAt: new Date(boot).toISOString() }];
  const list = vi.fn(async () => processRows);
  const census = new ProcessCensus({ list, now: () => boot + 5_000 });
  const getPanePid = vi.fn(async (): Promise<number | null> => 10);
  const thread = vi.fn(async () => id);
  const readAllPaneProcesses = vi.fn(async (): Promise<Map<string, { pid: number; command: string | null }> | null> => new Map([["%1", { pid: 10, command: "claude" }]]));
  const reader = new CurrentModelReader({ sessions, identities,
    context: { readSidecar: () => ({ ok: true, data: { session_id: id, session_name: "editor@studio", transcript_path: path, sampled_at: stamp, occupant_generation: tenure.generationUuid } }) } as never,
    codexRollout: () => path, piRunner: () => ({ state: { ready: true, launchId: "launch", sessionFile: path }, sessionsDir: dir, entryPath: `${dir}/pi-runner.mjs`, stateRoot: dir }),
    readAllPaneProcesses, census, now: () => boot + 60_000, native: { getPanePid, listProcesses: () => census.list(), readThreadIdByPid: thread },
  });
  const input = { nodeId: node.id, canonicalSessionName: "editor@studio", runtime, sessionStatus: "running" };
  return { db, dir, rigs, rig, node, sessions, identities, session, tenure, boot, stamp, path, id, claudeRecord, reader, input, list, getPanePid, thread, processRows, readAllPaneProcesses };
}

it("reports assistant-response evidence separately from the pin, with native time and no record contents", async () => {
  const f = fixture(); const result = await f.reader.observe(f.input);
  expect(result).toEqual({ status: "observed", model: "response-model", source: "claude-assistant-response", observedAt: f.stamp, generation: f.tenure.generationUuid, reason: null });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_MARKER"); expect(JSON.stringify(result)).not.toContain(f.dir);
  expect(f.rigs.getRig(f.rig.id)!.nodes[0]?.model).toBe("configured-model");
});

it("does not need a configured pin or comparator to observe a model", async () => {
  const f = fixture(); f.db.prepare("UPDATE nodes SET model=NULL WHERE id=?").run(f.node.id);
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "observed", model: "response-model" });
});

it.each(["turn_context", "world_state"])("labels Codex %s as recorded configuration, not response evidence", async (kind) => {
  const f = fixture("codex");
  writeFileSync(f.path, JSON.stringify({ timestamp: f.stamp, type: kind, payload: kind === "turn_context" ? { model: "recorded-model" } : { state: { collaboration_mode: { model: "recorded-model" } } } }) + "\n");
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "observed", model: "recorded-model", source: kind === "turn_context" ? "codex-turn-context" : "codex-world-state", observedAt: f.stamp });
  expect(f.thread).toHaveBeenCalledWith(20, f.processRows[1]!.startedAt);
});

it.each(["stale-record", "missing-record", "missing-time", "future-time", "synthetic-only", "malformed-model"])("returns explicit UNKNOWN for %s without a configured fallback", async (kind) => {
  const f = fixture();
  writeFileSync(f.path, kind === "missing-record" ? "{}\n" : kind === "missing-time" ? f.claudeRecord().replace(`"timestamp":"${f.stamp}",`, "")
    : f.claudeRecord(kind === "stale-record" ? new Date(f.boot - 1_000).toISOString() : kind === "future-time" ? new Date(f.boot + 120_000).toISOString() : f.stamp,
      kind === "synthetic-only" ? "<synthetic>" : kind === "malformed-model" ? "PRIVATE_MARKER not an id" : "response-model"));
  const result = await f.reader.observe(f.input);
  expect(result.status).toBe("unknown"); expect(result.model).toBeNull(); expect(result.reason).toBeTruthy();
});

it("rejects a verified Claude identity from the predecessor tenure", async () => {
  const f = fixture(); const identity = f.identities.getForNode(f.node.id)!;
  f.identities.upsert({ ...identity, observedAt: new Date(f.boot - 1_000).toISOString() });
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "unknown", reason: "record-identity-missing-or-ambiguous" });
});

it("rejects an occupant that changes while its record is being selected", async () => {
  const f = fixture(); f.getPanePid.mockImplementationOnce(async () => { f.sessions.mintOccupantTenure(f.node.id, "fresh"); return 10; });
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "unknown", reason: "occupant-changed-during-read" });
});

it("uses one process census for a pass and never scans a stopped/unsupported seat", async () => {
  const f = fixture(); const list = f.reader.processCensus.cycleLister();
  await f.reader.observe(f.input, list); await f.reader.observe(f.input, list); expect(f.list).toHaveBeenCalledTimes(1);
  f.list.mockClear();
  expect(await f.reader.observe({ ...f.input, sessionStatus: "stopped" })).toMatchObject({ status: "unknown", reason: "seat-not-running" });
  expect(await f.reader.observe({ ...f.input, runtime: "stub" })).toMatchObject({ status: "unknown", reason: "unsupported-runtime" });
  expect(f.list).not.toHaveBeenCalled();
});

it("never uses an identity-less Codex lookup for reporting", async () => {
  const f = fixture("codex"); delete (f.processRows[1] as { startedAt?: string }).startedAt;
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "unknown", reason: "record-identity-missing-or-ambiguous" });
  expect(f.thread).not.toHaveBeenCalled();
});

it("keeps the monitor's model-only result and metadata readers consistent", async () => {
  const f = fixture();
  expect(readClaudeModelObservation(f.path)?.model).toBe("response-model");
  expect(await f.reader.readEffectiveModel({ ...f.input, sessionName: "editor@studio", generation: f.tenure.generationUuid, rigId: f.rig.id, rigName: "studio", pinnedModel: "configured-model" })).toEqual({ ok: true, model: "response-model" });
  expect(readCodexModelObservation(f.path)).toBeNull();
});

it("serves the same observation through the actual inventory route with configured fields preserved", async () => {
  const f = fixture(); const { app } = createTestApp(f.db, { appDeps: { currentModelReader: f.reader } });
  const response = await app.request(`/api/rigs/${f.rig.id}/nodes`);
  expect(response.status).toBe(200);
  const [node] = await response.json();
  expect(node.model).toBe("configured-model");
  expect(node.modelObservation).toMatchObject({ model: "response-model", source: "claude-assistant-response", observedAt: f.stamp });
  expect(node).toHaveProperty("hostSelfId");
});

it("reports Pi response evidence without consulting its pin or models comparator", async () => {
  const f = fixture("pi");
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "observed", model: "example/response-model", source: "pi-assistant-response", observedAt: f.stamp });
});


it("selects the current Pi runner and its session file for the effort report, and refuses another occupant's session", async () => {
  const f = fixture("pi");
  expect(await f.reader.currentPiRecord(f.node.id, "editor@studio")).toMatchObject({
    ok: true, path: f.path, launchId: "launch", pid: 20, startedAt: f.processRows[1]!.startedAt, command: f.processRows[1]!.command,
  });
  vi.spyOn(f.sessions, "currentOccupantGenerationForSession").mockReturnValue("replacement");
  expect(await f.reader.currentPiRecord(f.node.id, "editor@studio")).toMatchObject({ ok: false });
});

it("the Pi effort record carries the runner's newest own turn when the occupant is unchanged", async () => {
  const f = fixture("pi");
  const record = await f.reader.currentPiRecord(f.node.id, "editor@studio");
  expect(record).toMatchObject({ ok: true, pid: 20, observation: { ok: true, model: "example/response-model", observedAt: f.stamp } });
  expect(f.getPanePid).toHaveBeenLastCalledWith("%1");
});

it("the Pi effort record is refused when a handover lands during the pending process lookup", async () => {
  const f = fixture("pi");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const rows = f.processRows;
  f.list.mockImplementationOnce(async () => { await pending; return rows; });
  const read = f.reader.currentPiRecord(f.node.id, "editor@studio");
  await vi.waitFor(() => expect(f.list).toHaveBeenCalled());
  f.sessions.mintOccupantTenure(f.node.id, "replacement");
  release();
  expect(await read).toEqual({ ok: false, reason: "the occupant changed during the read" });
});

it.each(["generation", "binding"])("the Pi effort record is refused on a same-PID %s change at the final pane lookup", async (kind) => {
  const f = fixture("pi");
  const calls = f.getPanePid.mock.calls;
  f.getPanePid.mockImplementation(async () => {
    if (calls.length === 3) {
      if (kind === "generation") f.sessions.mintOccupantTenure(f.node.id, "replacement");
      else f.sessions.updateBinding(f.node.id, { tmuxSession: "editor@studio", tmuxPane: "%2" });
    }
    return 10;
  });
  expect(await f.reader.currentPiRecord(f.node.id, "editor@studio")).toEqual({ ok: false, reason: "the occupant changed during the read" });
  expect(f.getPanePid).toHaveBeenCalledTimes(3);
});

it.each(["generation", "binding", "name-generation"])("r2: rejects %s turnover on the final PID await even with the same PID", async (kind) => {
  const f = fixture();
  f.getPanePid.mockImplementation(async () => {
    if (f.getPanePid.mock.calls.length === 3) {
      if (kind === "generation") f.sessions.mintOccupantTenure(f.node.id, "replacement");
      else if (kind === "binding") f.sessions.updateBinding(f.node.id, { tmuxSession: "editor@studio", tmuxPane: "%2" });
      else vi.spyOn(f.sessions, "currentOccupantGenerationForSession").mockReturnValue("replacement");
    }
    return 10;
  });
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "unknown", reason: "occupant-changed-during-read" });
});

it.each(["claude-code", "codex", "pi"])("r2: caches an unchanged %s native fact and invalidates append and replacement", async runtime => {
  const f = fixture(runtime);
  if (runtime === "codex") writeFileSync(f.path, JSON.stringify({ timestamp: f.stamp, type: "turn_context", payload: { model: "first-model" } }) + "\n");
  const read = vi.spyOn(recordReaders, runtime === "codex" ? "readCodexModelObservation" : runtime === "pi" ? "readPiModelObservation" : "readClaudeModelObservation");
  expect((await f.reader.observe(f.input)).status).toBe("observed");
  expect((await f.reader.observe(f.input)).status).toBe("observed");
  expect(read).toHaveBeenCalledTimes(1);
  appendFileSync(f.path, "\n");
  await f.reader.observe(f.input); expect(read).toHaveBeenCalledTimes(2);
  const copy = f.path + ".replacement";
  writeFileSync(copy, (await import("node:fs")).readFileSync(f.path)); renameSync(copy, f.path);
  await f.reader.observe(f.input); expect(read).toHaveBeenCalledTimes(3);
});

it("r2: checks the final-await occupant even on a cached record", async () => {
  const f = fixture(); await f.reader.observe(f.input); f.getPanePid.mockClear();
  f.getPanePid.mockImplementation(async () => {
    if (f.getPanePid.mock.calls.length === 3) f.sessions.mintOccupantTenure(f.node.id, "replacement");
    return 10;
  });
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "unknown", reason: "occupant-changed-during-read" });
});

it("r2: batches inventory pane reads and shares one census without per-seat tmux calls", async () => {
  const f = fixture();
  const result = await f.reader.observeInventory([f.input, f.input, f.input]);
  expect(result.map(r => r.status)).toEqual(["observed", "observed", "observed"]);
  expect(f.readAllPaneProcesses).toHaveBeenCalledTimes(2);
  expect(f.getPanePid).not.toHaveBeenCalled(); expect(f.list).toHaveBeenCalledTimes(1);
  await f.reader.observeInventory([{ ...f.input, sessionStatus: "stopped" }, { ...f.input, runtime: "stub" }]);
  expect(f.readAllPaneProcesses).toHaveBeenCalledTimes(2);
});

it("r2: uses the bulk path on repeated actual inventory requests and skips unchanged transcript reads", async () => {
  const f = fixture(); const read = vi.spyOn(recordReaders, "readClaudeModelObservation");
  const { app } = createTestApp(f.db, { appDeps: { currentModelReader: f.reader } });
  for (let n = 0; n < 2; n++) {
    const response = await app.request(`/api/rigs/${f.rig.id}/nodes`);
    expect(response.status).toBe(200); expect((await response.json())[0].modelObservation.status).toBe("observed");
  }
  expect(read).toHaveBeenCalledTimes(1); expect(f.getPanePid).not.toHaveBeenCalled();
  expect(f.readAllPaneProcesses).toHaveBeenCalledTimes(4);
});

it("r2: finishes the entire inventory selection before the final bulk PID and ledger check", async () => {
  const f = fixture();
  f.readAllPaneProcesses.mockImplementation(async () => {
    if (f.readAllPaneProcesses.mock.calls.length === 2) f.sessions.mintOccupantTenure(f.node.id, "replacement");
    return new Map([["%1", { pid: 10, command: "claude" }]]);
  });
  const results = await f.reader.observeInventory([f.input, f.input]);
  expect(results.every(r => r.reason === "occupant-changed-during-read")).toBe(true);
});


it.each(["throws", "null"])("r3: reports unavailable rather than turnover when the final direct read %s", async kind => {
  const f = fixture();
  f.getPanePid.mockImplementation(async () => {
    if (f.getPanePid.mock.calls.length === 3) {
      if (kind === "throws") throw new Error("final pane lookup failed");
      return null;
    }
    return 10;
  });
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "unknown", model: null,
    reason: kind === "throws" ? "native-read-unavailable" : "pane-unavailable" });
  expect(f.getPanePid).toHaveBeenCalledTimes(3);
});

it.each(["throws", "null", "missing-pane"])("r3: reports unavailable rather than turnover when the final bulk read is %s", async kind => {
  const f = fixture();
  f.readAllPaneProcesses.mockImplementation(async () => {
    if (f.readAllPaneProcesses.mock.calls.length === 2) {
      if (kind === "throws") throw new Error("final bulk lookup failed");
      return kind === "null" ? null : new Map();
    }
    return new Map([["%1", { pid: 10, command: "claude" }]]);
  });
  expect(await f.reader.observeInventory([f.input])).toMatchObject([{ status: "unknown", model: null,
    reason: kind === "missing-pane" ? "pane-unavailable" : "native-read-unavailable" }]);
  expect(f.readAllPaneProcesses).toHaveBeenCalledTimes(2);
  expect(f.getPanePid).not.toHaveBeenCalled();
});

it.each([false, true])("r3: retains observed PID-turnover reporting with a warmed fact %s", async warm => {
  const f = fixture();
  if (warm) await f.reader.observe(f.input);
  f.getPanePid.mockClear();
  f.getPanePid.mockImplementation(async () => f.getPanePid.mock.calls.length === 3 ? 11 : 10);
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "unknown", model: null, reason: "occupant-changed-during-read" });
  expect(f.getPanePid).toHaveBeenCalledTimes(3);
});


// Compose the real reconciler/store/record reader: a hand-seeded pane-PID verdict hides this bug.
async function wrapperFixture() {
  const f = fixture();
  f.db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run(f.id, f.session.id);
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 20, executableName: "sh", command: "sh", startedAt: f.stamp },
    { pid: 20, ppid: 10, pgid: 20, tpgid: 20, executableName: "claude", command: `claude --resume ${f.id}`, startedAt: f.stamp },
  ];
  f.list.mockImplementation(async () => rows);
  const reconciler = new SeatIdentityReconciler({ db: f.db, now: () => new Date(f.stamp), listProcesses: f.list,
    tmux: { listSessions: async () => [{ name: "editor@studio" }], getPanePid: f.getPanePid,
      getPaneCommand: async () => "sh" } as never });
  await reconciler.reconcileAll();
  expect(f.identities.getForNode(f.node.id)).toMatchObject({ verdict: "verified", evidence: { observedPid: 20 } });
  const seat = { nodeId: f.node.id, sessionName: "editor@studio", runtime: "claude-code", generation: f.tenure.generationUuid,
    rigId: f.rig.id, rigName: "studio", pinnedModel: "configured-model" };
  return { ...f, rows, reconciler, seat };
}

it("reads the response model through a persisted wrapper-root/Claude-child verdict", async () => {
  const f = await wrapperFixture();
  expect(await f.reader.readEffectiveModel(f.seat)).toEqual({ ok: true, model: "response-model" });
  expect(await f.reader.observe(f.input)).toMatchObject({ status: "observed", model: "response-model" });
});

it("the wrapper join ignores a newer retained predecessor record and process outside its pane", async () => {
  const f = await wrapperFixture();
  const priorId = "22222222-2222-4222-8222-222222222222", priorPath = join(f.dir, `${priorId}.jsonl`);
  writeFileSync(priorPath, f.claudeRecord(new Date(f.boot + 3_000).toISOString(), "predecessor-model"));
  f.rows.push({ pid: 30, ppid: 1, pgid: 30, tpgid: 40, executableName: "sh", command: "sh", startedAt: f.stamp },
    { pid: 40, ppid: 30, pgid: 40, tpgid: 40, executableName: "claude", command: `claude --resume ${priorId}`, startedAt: f.stamp });
  const { resolveIdentityVerifiedClaudeRecord } = await import("../src/domain/model-divergence/current-generation-record.js");
  expect(await resolveIdentityVerifiedClaudeRecord({ sessionName: f.seat.sessionName, generation: f.seat.generation,
    occupantBootAt: f.tenure.bootAt, binding: { tmuxSession: f.seat.sessionName, tmuxPane: "%1" },
    identity: f.identities.getForNode(f.node.id), sidecar: { session_name: f.seat.sessionName, session_id: priorId,
      transcript_path: priorPath, sampled_at: f.stamp, occupant_generation: "retained-generation" } },
  { getPanePid: f.getPanePid, listProcesses: f.list }, () => true)).toMatchObject({ ok: true, id: f.id, path: f.path,
    source: "verified-pane-argument" });
});

it.each(["child-replaced", "child-moved", "pane-replaced", "binding-changed", "old-verdict"])(
  "does not read a wrapper record after %s", async kind => {
    const f = await wrapperFixture();
    if (kind === "child-replaced") f.rows[1]!.pid = 21;
    if (kind === "child-moved") f.rows[1]!.ppid = 99;
    if (kind === "pane-replaced") {
      f.getPanePid.mockResolvedValue(99);
      f.rows[0]!.pid = 99; f.rows[1]!.ppid = 99;
    }
    if (kind === "binding-changed") f.sessions.updateBinding(f.node.id, { tmuxSession: "editor@studio", tmuxPane: "%2" });
    if (kind === "old-verdict") f.identities.upsert({ ...f.identities.getForNode(f.node.id)!, observedAt: new Date(f.boot - 1_000).toISOString() });
    expect((await f.reader.readEffectiveModel(f.seat)).ok).toBe(false);
  },
);
