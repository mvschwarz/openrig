import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { CodexThreadIdResolver } from "../src/domain/codex-thread-id.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { transportRoutes } from "../src/routes/transport.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(runtime: "claude-code" | "codex" = "claude-code", guarded = false) {
  const root = mkdtempSync(join(tmpdir(), "expected-conversation-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const repo = new RigRepository(db), rig = repo.createRig("expected"), node = repo.addNode(rig.id, "team.worker", { runtime });
  const registry = new SessionRegistry(db), sessionName = "team-worker@expected";
  const session = registry.registerSession(node.id, sessionName); registry.updateStatus(session.id, "running");
  registry.updateResumeToken(session.id, runtime === "codex" ? "codex_id" : "claude_id", A);
  registry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%1" });
  new SeatIdentityStore(db).upsert({ nodeId: node.id, verdict: "verified", evidenceSource: "pane_process", reason: null,
    evidence: { registeredPane: "%1", observedPid: 20, observedPanePid: 10, observedCommand: runtime, matchedLayer: 1 }, sessionName, observedAt: new Date().toISOString() });
  let pasted = false, staged = "", composer = "";
  const frame = () => ({ screen: ["Ready", "────────────────────", `❯ ${composer}`, "────────────────────", "? for shortcuts", ""].join("\n"), cursor: { x: 2 + composer.length, y: 2, width: 240, height: 60 }, inMode: false });
  let current = A, afterLoad: (() => void) | undefined, beforeKeys: (() => void) | undefined;
  const commands: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    commands.push(command); if (command.includes("load-buffer")) afterLoad?.(); if (command.includes("paste-buffer")) { pasted = true; composer = staged; } if (command.includes("send-keys") && command.includes("Enter")) composer = ""; return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => join(root, "paste"), bufferName: () => "expected-test" });
  vi.spyOn(tmux, "getPanePid").mockImplementation(async () => { if (pasted) beforeKeys?.(); return 10; });
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue(runtime === "codex" ? "codex" : "claude");
  vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1", index: 0, cwd: root, width: 120, height: 40, active: true }]);
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" } as never);
  vi.spyOn(tmux, "isPaneInMode").mockResolvedValue(false);
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => guarded ? frame().screen : "❯ ");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => frame());
  const guard = guarded ? new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)) : undefined;
  if (guard) tmux.deliveryGuard = guard;
  const rows = () => [{ pid: 10, ppid: 1, command: "zsh" }, { pid: 20, ppid: 10,
    command: runtime === "codex" ? `codex resume ${current}` : `claude --session-id ${current}`, startedAt: "Thu Oct 29 00:00:00 2026" }];
  vi.spyOn(ProcessCensus.prototype, "list").mockImplementation(async () => rows());
  vi.spyOn(CodexThreadIdResolver.prototype, "resolve").mockImplementation(async () => current);
  const store = new ContextUsageStore(db, { stateDir: root, codexHomeDir: root });
  const records = new Map([[A, join(root, "a.jsonl")], [B, join(root, "b.jsonl")]]);
  for (const [id, file] of records) writeFileSync(file, runtime === "codex"
    ? JSON.stringify({ type: "session_meta", payload: { id } }) + "\n" + JSON.stringify({ output: id }) + "\n"
    : JSON.stringify({ type: "user", sessionId: id, message: { content: id } }) + "\n");
  vi.spyOn(store, "readSidecar").mockImplementation(() => ({ ok: true, data: { session_id: current, session_name: sessionName,
    occupant_generation: registry.currentOccupantTenure(node.id)!.generationUuid, sampled_at: new Date().toISOString(), transcript_path: records.get(current), context_window: { used_percentage: 10 } } }));
  vi.spyOn(store, "readCodexTranscriptPath").mockImplementation(id => records.get(id) ?? null);
  const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: tmux, contextUsageStore: store, listProcesses: async () => rows(), sleep: async () => {} } as never);
  const app = new Hono(); app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: tmux, contextUsageStore: store, sessionTransport: transport })) c.set(key as never, value as never);
    await next();
  }); app.route("/api/sessions", sessionAdminRoutes); app.route("/api/transport", transportRoutes());
  const expected = { nodeId: node.id, sessionName, runtime, nativeId: A };
  const readUrl = () => `/api/sessions/${sessionName}/generation-record-expected?` + new URLSearchParams({ expectedNodeId: node.id, expectedRuntime: runtime, expectedNativeId: A, sinceBytes: "0" });
  return { root, db, registry, node, tmux, guard, transport, app, expected, commands, store, records, readUrl, processes: rows,
    replace: () => { current = B; }, onLoad: (fn: () => void) => { afterLoad = fn; }, beforeKeys: (fn: () => void) => { beforeKeys = fn; } };
}

// Observe only the record fd, without counting unrelated module-loader reads.
function recordReads(file: string, fail = false) {
  const target = fs.statSync(file), original = fs.readSync;
  let calls = 0, bytes = 0;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
    const stat = fs.fstatSync(args[0] as number);
    if (stat.dev === target.dev && stat.ino === target.ino) {
      calls++; bytes += typeof args[3] === "number" ? args[3] : 0;
      if (fail) throw Object.assign(new Error("record disappeared"), { code: "ENOENT" });
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readSync);
  // The handler dynamically imports node:fs's named exports, which are distinct from its default object.
  syncBuiltinESMExports();
  return { get calls() { return calls; }, get bytes() { return bytes; }, reset() { calls = 0; bytes = 0; } };
}

it.each(["claude-code", "codex"] as const)("conditional record reads return the original %s identity and bytes together", async runtime => {
  const f = fixture(runtime), response = await f.app.request(f.readUrl()), body = await response.json();
  expect(response.status).toBe(200); expect(body.checkedIdentity).toEqual(f.expected); expect(body.suffix).toContain(A); expect(body.suffix).not.toContain(B);
});
it.each(["claude-code", "codex"] as const)("conditional %s read refuses A->B after the roster selection", async runtime => {
  const f = fixture(runtime); f.replace(); const response = await f.app.request(f.readUrl());
  expect(response.status).toBe(409); const body = await response.json(); expect(body.error).toBe("expected_identity_mismatch"); expect(body.suffix).toBeUndefined();
});
it.each(["claude-code", "codex"] as const)("conditional %s read refuses replacement during live record resolution", async runtime => {
  const f = fixture(runtime);
  vi.spyOn(ProcessCensus.prototype, "list").mockImplementation(async () => { f.replace(); return f.processes(); });
  const response = await f.app.request(f.readUrl());
  expect(response.status).toBe(409); expect((await response.json()).suffix).toBeUndefined();
});
it("conditional read refuses a Claude file whose content identifies a replacement", async () => {
  const f = fixture(); writeFileSync(f.records.get(A)!, JSON.stringify({ type: "user", sessionId: B }) + "\n");
  expect((await f.app.request(f.readUrl())).status).toBe(409);
});
it.each(["claude-code", "codex"] as const)("conditional %s send refuses A->B inside actual tmux buffer preparation", async runtime => {
  const f = fixture(runtime); f.onLoad(f.replace);
  const result = await f.transport.send(f.expected.sessionName, "for original A", { expectedIdentity: f.expected, deliveryId: "original-send" } as never);
  expect(result.ok).toBe(false); expect(result.reason).toBe("expected_identity_mismatch"); expect(result.sent).toBe(false);
  expect(f.commands.some(command => command.includes("paste-buffer") || command.includes("send-keys"))).toBe(false);
});
it.each(["claude-code", "codex"] as const)("conditional %s send refuses replacement after paste before Enter", async runtime => {
  const f = fixture(runtime); f.beforeKeys(f.replace);
  const result = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected } as never);
  expect(result.ok).toBe(false); expect(result.reason).toBe("expected_identity_mismatch");
  expect(result.sent).toBe(true); expect(result.inputPhase).toBe("written");
  expect(f.commands.filter(command => command.includes("paste-buffer"))).toHaveLength(1);
  expect(f.commands.some(command => command.includes("send-keys"))).toBe(false);
});
it("conditional send refuses unavailable identity without input", async () => {
  const f = fixture(); f.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id=?").run(f.node.id);
  const result = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected } as never);
  expect(result.reason).toBe("expected_identity_unavailable"); expect(result.sent).toBe(false);
  expect(f.commands.some(command => command.includes("paste-buffer"))).toBe(false);
});
it("conditional send carries the checked original identity receipt", async () => {
  const f = fixture(); const result = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected } as never);
  expect(result.ok, JSON.stringify(result)).toBe(true); expect((result as any).checkedIdentity).toEqual(f.expected);
  expect(f.commands.filter(command => command.includes("paste-buffer"))).toHaveLength(1);
});
it("retained conditional input keeps its identity through a committed dispatch", async () => {
  const f = fixture(); const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name));
  f.tmux.deliveryGuard = guard; await guard.set(f.node.id, true, "test", "hold original");
  const held = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected, deliveryId: "held-original" } as never);
  expect(held.outcome).toBe("retained"); await guard.set(f.node.id, false, "test", "release current request"); f.replace();
  const result = await f.transport.send(f.expected.sessionName, "for A", { committedOutboxIds: ["held-original"] });
  expect(result.ok).toBe(false); expect(result.reason).toBe("expected_identity_mismatch");
  expect(f.commands.some(command => command.includes("paste-buffer"))).toBe(false);
});
it("delivery-ID reuse cannot replace or omit the original identity constraint", async () => {
  const f = fixture(); f.onLoad(f.replace);
  await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected, deliveryId: "reused-original" } as never);
  const omitted = await f.transport.send(f.expected.sessionName, "for A", { deliveryId: "reused-original" });
  expect(omitted.ok).toBe(false); expect(omitted.reason).toBe("expected_identity_mismatch");
  const changed = await f.transport.send(f.expected.sessionName, "for A", { deliveryId: "reused-original", expectedIdentity: { ...f.expected, nativeId: B } } as never);
  expect(changed.reason).toBe("delivery_identity_conflict");
});
it("new conditional endpoint refuses a missing expectation, rather than silently sending", async () => {
  const f = fixture(); const response = await f.app.request("/api/transport/send-expected", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: f.expected.sessionName, text: "hello" }) });
  expect(response.status).toBe(400); expect(f.commands.some(command => command.includes("paste-buffer"))).toBe(false);
});
it("legacy sends retain their ordinary behavior", async () => {
  const f = fixture(); const result = await f.transport.send(f.expected.sessionName, "ordinary input");
  expect(result.ok, JSON.stringify(result)).toBe(true); expect(f.commands.some(command => command.includes("paste-buffer"))).toBe(true);
});


it("rejects a conditional runtime-switch send without retaining input and requires expectation on retry", async () => {
  const f = fixture();
  f.db.prepare(`INSERT INTO seat_runtime_switches (id,node_id,canonical_session,staging_session,predecessor_pane,successor_pane,
    predecessor_generation,successor_generation,from_runtime,to_runtime,phase,reason,plan_json,deadline_at)
    VALUES ('switch-original',?,?,'staging-original','%1','%2',?,'next-generation','claude-code','codex','preparing','test','{}','2099-01-01T00:00:00Z')`)
    .run(f.node.id, f.expected.sessionName, f.registry.currentOccupantTenure(f.node.id)!.generationUuid);
  const post = (path: string, expectedIdentity?: unknown) => f.app.request(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: f.expected.sessionName, text: "for original A", deliveryId: "switch-held", expectedIdentity }) });
  const held = await post("/api/transport/send-expected", f.expected), body = await held.json();
  expect(held.status).toBe(409); expect(body).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached", reason: "expected_identity_unavailable" });
  expect(body.outcome).not.toBe("retained");
  expect(f.db.prepare("SELECT * FROM outbox_entries WHERE outbox_id='switch-held'").get()).toBeUndefined();
  const ordinary = await post("/api/transport/send"); expect(await ordinary.json()).toMatchObject({ outcome: "retained", reason: "runtime_switch_in_progress" });
  f.db.prepare("UPDATE seat_runtime_switches SET phase='finished',committed_at=? WHERE id='switch-original'").run(new Date().toISOString()); f.replace();
  const retry = await post("/api/transport/send-expected", f.expected);
  expect(retry.status).toBe(409); expect(await retry.json()).toMatchObject({ reason: "expected_identity_mismatch", sent: false });
  expect((await post("/api/transport/send-expected")).status).toBe(400);
  expect(f.commands.some(command => command.includes("paste-buffer"))).toBe(false);
});

it("a conflicting ID request cannot fail the first pending draft-aware input", async () => {
  const f = fixture("claude-code", true); await f.guard!.set(f.node.id, { mode: "draft-aware" }, "test", "protect input");
  expect(f.transport.guardedDelivery).toBeDefined();
  let entered!: () => void, release!: () => void;
  const atResolver = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.tmux.getPanePid).mockImplementationOnce(async () => { entered(); await gate; return 10; });
  const first = f.transport.send(f.expected.sessionName, "first input", { expectedIdentity: f.expected, deliveryId: "concurrent-original" } as never);
  await atResolver;
  let conflict, pending;
  try {
    conflict = await f.transport.send(f.expected.sessionName, "different input", { expectedIdentity: f.expected, deliveryId: "concurrent-original" } as never);
    pending = f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id='concurrent-original'").get();
  } finally { release(); }
  const firstResult = await first;
  expect(conflict?.reason).toBe("delivery_identity_conflict"); expect(pending).toEqual({ delivery_state: "pending" });
  expect(firstResult).toMatchObject({ ok: true, checkedIdentity: f.expected });
  expect(f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id='concurrent-original'").get()).toEqual({ delivery_state: "delivered" });
});

it("conditional Claude polling stops reading at the first native identity in a large record", async () => {
  const f = fixture();
  const record = JSON.stringify({ type: "user", sessionId: A, message: { content: "original" } }) + "\n" + " ".repeat(2 * 1024 * 1024);
  writeFileSync(f.records.get(A)!, record);
  const url = f.readUrl().replace("sinceBytes=0", `sinceBytes=${Buffer.byteLength(record)}`);
  const reads = recordReads(f.records.get(A)!);
  expect((await f.app.request(url)).status).toBe(200);
  reads.reset();
  expect((await f.app.request(url)).status).toBe(200);
  expect(reads.calls).toBeGreaterThan(0);
  expect(reads.bytes).toBeLessThanOrEqual(128 * 1024);
});

it("conditional read maps a filesystem errno to documented unavailable", async () => {
  const f = fixture(), reads = recordReads(f.records.get(A)!, true);
  const response = await f.app.request(f.readUrl());
  expect(reads.calls).toBeGreaterThan(0);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "expected_identity_unavailable" });
});

it("expected input preserves caller cancellation before typing", async () => {
  const f = fixture("claude-code", true), controller = new AbortController(); controller.abort();
  const result = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected, signal: controller.signal } as never);
  expect(result).toMatchObject({ ok: false, sent: false, reason: "caller_cancelled" });
  expect(f.commands.some(command => command.includes("paste-buffer") || command.includes("send-keys"))).toBe(false);
});

it("expected input keeps typing protection ahead of input", async () => {
  const f = fixture("claude-code", true); await f.guard!.set(f.node.id, true, "test", "hold input");
  expect(f.transport.guardedDelivery).toBeDefined();
  const result = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected } as never);
  expect(result).toMatchObject({ ok: true, sent: false, outcome: "retained" });
  expect(f.commands.some(command => command.includes("paste-buffer") || command.includes("send-keys"))).toBe(false);
});

it("expected input does not answer a native selection prompt", async () => {
  const f = fixture("codex", true);
  vi.mocked(f.tmux.capturePaneContent).mockResolvedValue("Codex update available.\n\n› 1. Update now\n  2. Skip this version\n\n  gpt-5.5 high · Context [████ ] · ~/project");
  const result = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected, waitForIdleMs: 100 } as never);
  expect(result).toMatchObject({ ok: false, sent: false, reason: "target_needs_input" });
  expect(f.commands.some(command => command.includes("paste-buffer") || command.includes("send-keys"))).toBe(false);
});
