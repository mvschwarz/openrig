import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { CurrentModelReader } from "../src/domain/model-divergence/current-model-reader.js";
import { parseSqliteUtcMs } from "../src/domain/sqlite-time.js";
import { readClaudeModelObservation, readCodexModelObservation } from "../src/domain/model-divergence/effective-model-readers.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(runtime = "claude-code") {
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const dir = mkdtempSync(join(tmpdir(), "observed-model-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
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
  const getPanePid = vi.fn(async () => 10);
  const thread = vi.fn(async () => id);
  const reader = new CurrentModelReader({ sessions, identities,
    context: { readSidecar: () => ({ ok: true, data: { session_id: id, session_name: "editor@studio", transcript_path: path, sampled_at: stamp, occupant_generation: tenure.generationUuid } }) } as never,
    codexRollout: () => path, piRunner: () => ({ state: { ready: true, launchId: "launch", sessionFile: path }, sessionsDir: dir, entryPath: `${dir}/pi-runner.mjs`, stateRoot: dir }),
    census, now: () => boot + 60_000, native: { getPanePid, listProcesses: () => census.list(), readThreadIdByPid: thread },
  });
  const input = { nodeId: node.id, canonicalSessionName: "editor@studio", runtime, sessionStatus: "running" };
  return { db, dir, rigs, rig, node, sessions, identities, session, tenure, boot, stamp, path, claudeRecord, reader, input, list, getPanePid, thread, processRows };
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
