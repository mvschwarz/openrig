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
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { resolveExpectedConversation } from "../src/domain/expected-conversation.js";
import { readProcessTable } from "../src/domain/process-table.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { transportRoutes } from "../src/routes/transport.js";
import { restoreProc, serveFakeProc } from "./helpers/fake-proc.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
function lstart(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}
const cleanup: Array<() => unknown> = [];
afterEach(() => { restoreProc(); vi.restoreAllMocks(); syncBuiltinESMExports(); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(runtime: "claude-code" | "codex" = "claude-code", guarded = false) {
  const root = mkdtempSync(join(tmpdir(), "expected-conversation-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const repo = new RigRepository(db), rig = repo.createRig("expected"), node = repo.addNode(rig.id, "team.worker", { runtime });
  const registry = new SessionRegistry(db), sessionName = "team-worker@expected";
  const session = registry.registerSession(node.id, sessionName); registry.updateStatus(session.id, "running");
  registry.updateResumeToken(session.id, runtime === "codex" ? "codex_id" : "claude_id", A);
  registry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%1" });
  const observedAt = new Date().toISOString();
  const before = lstart(new Date(Date.now() - 60_000));
  new SeatIdentityStore(db).upsert({ nodeId: node.id, verdict: "verified", evidenceSource: "pane_process", reason: null,
    evidence: { registeredPane: "%1", observedPid: 20, observedPanePid: 10, observedPidStartedAt: before, observedPanePidStartedAt: before, observedCommand: runtime, matchedLayer: 1 }, sessionName, observedAt });
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
  const rows = () => [{ pid: 10, ppid: 1, command: "zsh", startedAt: before }, { pid: 20, ppid: 10,
    command: runtime === "codex" ? `codex resume ${current}` : `claude --session-id ${current}`, startedAt: before }];
  vi.spyOn(ProcessCensus.prototype, "list").mockImplementation(async () => rows());
  vi.spyOn(CodexThreadIdResolver.prototype, "resolve").mockImplementation(async () => current);
  vi.spyOn(CodexThreadIdResolver.prototype, "resolveWithHome").mockImplementation(async () => ({ thread: current, codexHome: root }));
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
  return { root, db, registry, node, tmux, guard, transport, app, expected, commands, store, records, readUrl, processes: rows, before, observedAt,
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

it.each([false, true])("keeps an unconfirmed conditional send indeterminate in its durable receipt (guard installed: %s)", async guarded => {
  const f = fixture("claude-code", guarded);
  const result = await f.transport.send(f.expected.sessionName, "for A", {
    expectedIdentity: f.expected, deliveryId: "uncertain-original", verify: true,
  } as never);
  expect(result).toMatchObject({ ok: true, verified: false, outcome: "rendered-unconfirmed" });
  expect(f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id=?").get("uncertain-original"))
    .toEqual({ delivery_state: "indeterminate" });
  expect(f.commands.filter(command => command.includes("paste-buffer"))).toHaveLength(1);
  expect(f.commands.filter(command => command.includes("send-keys") && command.includes("Enter"))).toHaveLength(1);
});

it("records an exception after the paste as indeterminate, not pending or failed", async () => {
  const f = fixture();
  vi.spyOn(f.tmux, "sendKeys").mockRejectedValue(new Error("submit reply lost"));
  const result = await f.transport.send(f.expected.sessionName, "for A", {
    expectedIdentity: f.expected, deliveryId: "written-original",
  } as never);
  expect(result).toMatchObject({ ok: false, sent: true, inputPhase: "written" });
  expect(f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id=?").get("written-original"))
    .toEqual({ delivery_state: "indeterminate" });
  expect(f.commands.filter(command => command.includes("paste-buffer"))).toHaveLength(1);
});

it("records a lost paste result as indeterminate without claiming it was not written", async () => {
  const f = fixture();
  vi.spyOn(f.tmux, "sendText").mockRejectedValue(new Error("paste reply lost"));
  const result = await f.transport.send(f.expected.sessionName, "for A", {
    expectedIdentity: f.expected, deliveryId: "attempted-original",
  } as never);
  expect(result).toMatchObject({ ok: false, inputPhase: "attempted" });
  expect(result.sent).toBeUndefined();
  expect(f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id=?").get("attempted-original"))
    .toEqual({ delivery_state: "indeterminate" });
});

it("gives an attempted input phase priority over a false sent flag", async () => {
  const f = fixture();
  vi.spyOn(f.transport as never, "sendClassifiedInput" as never).mockResolvedValue({
    ok: false, sessionName: f.expected.sessionName, sent: false, inputPhase: "attempted", reason: "send_failed",
  } as never);
  const result = await f.transport.send(f.expected.sessionName, "for A", {
    expectedIdentity: f.expected, deliveryId: "contradictory-original", waitForIdleMs: 1000,
  } as never);
  expect(result).toMatchObject({ ok: false, sent: false, inputPhase: "attempted" });
  expect(f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id=?").get("contradictory-original"))
    .toEqual({ delivery_state: "indeterminate" });
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

it.each([["claude-code", false], ["codex", false], ["claude-code", true], ["codex", true]] as const)("conditional native %s send rechecks identity and caller after lease wait (abort=%s)", async (runtime, abort) => {
  const f = fixture(runtime, true);
  const { ActivityGrantStore } = await import("../src/domain/activity-grants.js");
  const { RunnerChannel } = await import("../src/domain/runner-channel.js");
  const { OutboxHandler } = await import("../src/domain/outbox-handler.js");
  const grants = new ActivityGrantStore(f.db);
  const grant = grants.issue({ nodeId: f.node.id, generation: f.registry.currentOccupantTenure(f.node.id)!.generationUuid, issuedBy: "launch",
    run: { runId: "original-run", binding: { runtime, runner: 1, pane: "%1", panePid: 10 } } });
  expect(grants.activate(grant.grantId)).toBe(true);
  const outbox = new OutboxHandler(f.db), channel = new RunnerChannel(grants, outbox);
  channel.post(grant.token, { type: "hello", version: 1, runId: "original-run", retained: true, capabilities: { input: true, wake: true, cancel: false } });
  cleanup.push(channel.connect(grant.token));
  new RigRepository(f.db).setNodeInputRoute(f.node.id, "native");
  const transport = new SessionTransport({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: f.registry,
    tmuxAdapter: f.tmux, contextUsageStore: f.store, runnerChannel: channel } as never);
  let release!: () => void, queued!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const atLease = new Promise<void>(resolve => { queued = resolve; });
  const operation = f.guard!.operation.bind(f.guard!);
  const held = operation(f.expected.sessionName, async () => { await gate; });
  vi.spyOn(f.guard!, "operation").mockImplementation((name, fn, retained) => {
    queued(); return operation(name, fn, retained);
  });
  const caller = new AbortController();
  const pending = transport.send(f.expected.sessionName, "for original A", { expectedIdentity: f.expected, deliveryId: "native-original", signal: caller.signal } as never);
  await atLease;
  if (abort) vi.mocked(f.tmux.getPanePid).mockImplementation(async () => { caller.abort(); return 10; });
  else f.replace();
  release(); await held;
  const result = await pending;
  expect(result).toMatchObject({ ok: false, sent: false, reason: abort ? "caller_cancelled" : "expected_identity_mismatch" });
  expect(outbox.runnerReceipt("native-original")).toBeNull();
  expect(f.commands.some(command => command.includes("paste-buffer") || command.includes("send-keys"))).toBe(false);
});

it.each<[string, "claude-code" | "codex", boolean, "root" | "native", string]>([
  ["dual-PID Claude pane root", "claude-code", false, "root", "pane root"],
  ["dual-PID Claude native process", "claude-code", false, "native", "native Claude process"],
  ["legacy Claude pane root with recorded start", "claude-code", true, "root", "pane root"],
  ["dual-PID Codex pane root", "codex", false, "root", "pane root"],
  ["dual-PID Codex native process", "codex", false, "native", "native Codex process"],
  ["legacy Codex pane root with recorded start", "codex", true, "root", "pane root"],
])("refuses %s when its verified PID carries a different start time than recorded", async (_case, runtime, legacy, target, label) => {
  const f = fixture(runtime);
  if (legacy) {
    f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=NULL, observed_pid_started_at=?, observed_pane_pid_started_at=NULL WHERE node_id=?")
      .run(f.before, f.node.id);
  }
  const later = lstart(new Date(Date.parse(f.observedAt) + 5_000));
  vi.mocked(ProcessCensus.prototype.list).mockResolvedValue([
    { pid: 10, ppid: 1, command: "zsh", startedAt: target === "root" ? later : f.before },
    { pid: 20, ppid: 10, command: runtime === "codex" ? `codex resume ${A}` : `claude --session-id ${A}`, startedAt: target === "native" ? later : f.before },
  ]);
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_unavailable",
    message: expect.stringContaining(`its ${label} start time changed since verification`),
  });
  const response = await f.app.request(f.readUrl());
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "expected_identity_unavailable" });
  const send = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected } as never);
  expect(send).toMatchObject({ ok: false, sent: false, reason: "expected_identity_unavailable" });
  expect(f.commands.some(command => command.includes("paste-buffer") || command.includes("send-keys"))).toBe(false);
});

it.each<[string, "claude-code" | "codex", "same-second" | "unknown-start" | "stamp-before-sample", boolean]>([
  ["Claude same-second start (recorded)", "claude-code", "same-second", false],
  ["Claude same-second start (legacy without recorded start)", "claude-code", "same-second", true],
  ["Codex same-second start (recorded)", "codex", "same-second", false],
  ["Codex same-second start (legacy without recorded start)", "codex", "same-second", true],
  ["Claude unknown root and native start", "claude-code", "unknown-start", false],
  ["Claude legacy unknown root and native start", "claude-code", "unknown-start", true],
  ["Codex unknown pane root start", "codex", "unknown-start", false],
  ["Claude stamp-before-sample verdict", "claude-code", "stamp-before-sample", false],
  ["Claude legacy stamp-before-sample verdict", "claude-code", "stamp-before-sample", true],
  ["Codex stamp-before-sample verdict", "codex", "stamp-before-sample", false],
  ["Codex legacy stamp-before-sample verdict", "codex", "stamp-before-sample", true],
])("does not refuse %s without positive evidence of a changed process, including on typed send", async (_case, runtime, kind, legacy) => {
  const f = fixture(runtime);
  const nowMs = Date.now();
  const sameSecond = lstart(new Date(nowMs));
  const afterStamp = lstart(new Date(nowMs + 2_000));
  const nativeCmd = runtime === "codex" ? `codex resume ${A}` : `claude --session-id ${A}`;
  const liveRootStart = kind === "unknown-start" ? undefined : kind === "same-second" ? sameSecond : afterStamp;
  const liveNativeStart = kind === "unknown-start"
    ? (runtime === "codex" ? f.before : undefined)
    : kind === "same-second" ? sameSecond : afterStamp;
  const verdictObservedAt = kind === "stamp-before-sample" ? new Date(nowMs).toISOString() : new Date(nowMs).toISOString();
  if (legacy) {
    f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=NULL, observed_pid_started_at=NULL, observed_pane_pid_started_at=NULL, observed_at=? WHERE node_id=?")
      .run(verdictObservedAt, f.node.id);
  } else {
    f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid_started_at=?, observed_pane_pid_started_at=?, observed_at=? WHERE node_id=?")
      .run(liveNativeStart ?? f.before, liveRootStart ?? f.before, verdictObservedAt, f.node.id);
  }
  vi.mocked(ProcessCensus.prototype.list).mockResolvedValue([
    { pid: 10, ppid: 1, command: "zsh", ...(liveRootStart ? { startedAt: liveRootStart } : {}) },
    { pid: 15, ppid: 10, command: "sh wrapper.sh", ...(kind === "same-second" ? { startedAt: sameSecond } : {}) },
    { pid: 20, ppid: 15, command: nativeCmd, ...(liveNativeStart ? { startedAt: liveNativeStart } : {}) },
  ]);
  const resolved = await resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store);
  expect(resolved.identity).toEqual(f.expected);
  const send = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected } as never);
  expect(send.ok, JSON.stringify(send)).toBe(true);
  expect(f.commands.filter(command => command.includes("paste-buffer"))).toHaveLength(1);
  expect(f.commands.filter(command => command.includes("send-keys") && command.includes("Enter"))).toHaveLength(1);
});

it("retains exact pane and native start times from rebindAndVerifyPaneIdentity and refuses only when live start disagrees", async () => {
  const f = fixture("claude-code");
  const stampBeforeSample = new Date(Date.now() + 1_000);
  const processStart = lstart(new Date(Date.now() + 3_000));
  const reusedStart = lstart(new Date(Date.now() + 10_000));
  const nativeRows = [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 20, executableName: "zsh", command: "zsh", startedAt: processStart },
    { pid: 20, ppid: 10, pgid: 20, tpgid: 20, executableName: "claude", command: `claude --session-id ${A}`, startedAt: processStart },
  ];
  vi.mocked(f.tmux.getPaneCommand).mockResolvedValue("zsh");
  const rebound = await rebindAndVerifyPaneIdentity({
    db: f.db, sessionRegistry: f.registry, tmux: f.tmux, nodeId: f.node.id, sessionName: f.expected.sessionName,
    runtime: "claude-code", expectedResumeToken: A, now: () => stampBeforeSample,
    listProcesses: async () => nativeRows,
  });
  expect(rebound).toMatchObject({ ok: true, pane: "%1", pid: 10 });
  expect(new SeatIdentityStore(f.db).getForNode(f.node.id)).toMatchObject({
    verdict: "verified",
    evidence: { observedPanePid: 10, observedPid: 20, observedPanePidStartedAt: processStart, observedPidStartedAt: processStart },
  });

  vi.mocked(ProcessCensus.prototype.list).mockResolvedValue(nativeRows);
  expect((await resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).identity).toEqual(f.expected);

  vi.mocked(ProcessCensus.prototype.list).mockResolvedValue([
    nativeRows[0]!,
    { ...nativeRows[1]!, startedAt: reusedStart },
  ]);
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_unavailable",
    message: expect.stringContaining("native Claude process start time changed since verification"),
  });
});

it.each<[string, "dual" | "legacy" | "shell-root", "new-pid" | "reused-pid"]>([
  ["dual-PID replaced by new PID", "dual", "new-pid"],
  ["dual-PID reused under same PID", "dual", "reused-pid"],
  ["legacy verdict replaced by new PID", "legacy", "new-pid"],
  ["legacy verdict reused under same PID", "legacy", "reused-pid"],
  ["shell-root dual-PID replaced by new PID", "shell-root", "new-pid"],
])("refuses a Claude process replaced after its opening census (%s)", async (_case, verdictKind, mode) => {
  const f = fixture("claude-code");
  if (verdictKind === "legacy") f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=NULL WHERE node_id=?").run(f.node.id);
  if (verdictKind === "shell-root") f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=10 WHERE node_id=?").run(f.node.id);
  const later = lstart(new Date(Date.parse(f.observedAt) + 5_000));
  const opening = [
    { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
    { pid: 20, ppid: 10, command: `claude --session-id ${A}`, startedAt: f.before },
  ];
  const closing = [
    { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
    { pid: mode === "new-pid" ? 21 : 20, ppid: 10, command: `claude --session-id ${A}`, startedAt: later },
  ];
  const listSpy = vi.mocked(ProcessCensus.prototype.list).mockImplementation(async (opts) => opts?.fresh ? closing : opening);
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_mismatch",
    message: expect.stringContaining("changed during native resolution"),
  });
  expect(listSpy).toHaveBeenCalledWith({ fresh: true });
  const send = await f.transport.send(f.expected.sessionName, "for A", { expectedIdentity: f.expected } as never);
  expect(send).toMatchObject({ ok: false, sent: false, reason: "expected_identity_mismatch" });
  expect(f.commands.some(command => command.includes("paste-buffer") || command.includes("send-keys"))).toBe(false);
});

it.each<[string, "claude-code" | "codex", boolean]>([
  ["dual-PID Claude", "claude-code", false],
  ["legacy Claude", "claude-code", true],
  ["dual-PID Codex", "codex", false],
  ["legacy Codex", "codex", true],
])("refuses %s when the pane root is replaced under a reused PID during lookup", async (_case, runtime, legacy) => {
  const f = fixture(runtime);
  if (legacy) f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=NULL WHERE node_id=?").run(f.node.id);
  const later = lstart(new Date(Date.parse(f.observedAt) + 5_000));
  const nativeCmd = runtime === "codex" ? `codex resume ${A}` : `claude --session-id ${A}`;
  let replaced = false;
  vi.mocked(ProcessCensus.prototype.list).mockImplementation(async () => [
    { pid: 10, ppid: 1, command: "zsh", startedAt: replaced ? later : f.before },
    { pid: 20, ppid: 10, command: nativeCmd, startedAt: f.before },
  ]);
  if (runtime === "claude-code") {
    const readSidecar = vi.mocked(f.store.readSidecar).getMockImplementation()!;
    vi.mocked(f.store.readSidecar).mockImplementation((name) => { replaced = true; return readSidecar(name); });
  } else {
    vi.mocked(CodexThreadIdResolver.prototype.resolveWithHome).mockImplementation(async () => {
      replaced = true;
      return { thread: A, codexHome: f.root };
    });
  }
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_mismatch",
    message: expect.stringContaining("changed during native resolution"),
  });
});

it.each(["claude-code", "codex"] as const)("refuses %s when an intermediate launcher between pane root and native process is replaced during lookup", async runtime => {
  const f = fixture(runtime);
  const later = lstart(new Date(Date.parse(f.observedAt) + 5_000));
  const nativeCmd = runtime === "codex" ? `codex resume ${A}` : `claude --session-id ${A}`;
  const opening = [
    { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
    { pid: 15, ppid: 10, command: "sh wrapper.sh", startedAt: f.before },
    { pid: 20, ppid: 15, command: nativeCmd, startedAt: f.before },
  ];
  const closing = [
    { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
    { pid: 15, ppid: 10, command: "sh wrapper.sh", startedAt: later },
    { pid: 20, ppid: 15, command: nativeCmd, startedAt: f.before },
  ];
  vi.mocked(ProcessCensus.prototype.list).mockImplementation(async (opts) => opts?.fresh ? closing : opening);
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_mismatch",
    message: expect.stringContaining("changed during native resolution"),
  });
});

it.each<[string, "claude-code" | "codex", boolean]>([
  ["dual-PID Claude", "claude-code", false],
  ["legacy Claude", "claude-code", true],
  ["dual-PID Codex", "codex", false],
  ["legacy Codex", "codex", true],
])("ignores a transient shell/tool child under %s during lookup", async (_case, runtime, legacy) => {
  const f = fixture(runtime);
  if (legacy) f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=NULL WHERE node_id=?").run(f.node.id);
  const later = lstart(new Date(Date.parse(f.observedAt) + 5_000));
  const nativeCmd = runtime === "codex" ? `codex resume ${A}` : `claude --session-id ${A}`;
  const base = [
    { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
    { pid: 20, ppid: 10, command: nativeCmd, startedAt: f.before },
  ];
  const tools = [
    { pid: 30, ppid: 20, command: "sh -c echo claude codex", startedAt: later },
    { pid: 31, ppid: 20, command: "git grep codex", startedAt: later },
    ...(runtime === "claude-code" && !legacy ? [{ pid: 32, ppid: 20, command: "claude -p summarize", startedAt: later }] : []),
  ];
  vi.mocked(ProcessCensus.prototype.list).mockImplementation(async (opts) => opts?.fresh ? [...base, ...tools] : base);
  const resolved = await resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store);
  expect(resolved.identity).toEqual(f.expected);
});

it.each(["mutated", "spawned"] as const)("refuses dual-PID Claude when a second contributing Claude descendant is %s during sidecar read", async mode => {
  const f = fixture("claude-code");
  let changed = false;
  const readSidecar = vi.mocked(f.store.readSidecar).getMockImplementation()!;
  vi.mocked(f.store.readSidecar).mockImplementation((name) => { changed = true; return readSidecar(name); });
  vi.mocked(ProcessCensus.prototype.list).mockImplementation(async () => {
    const base = [
      { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
      { pid: 20, ppid: 10, command: `claude --session-id ${A}`, startedAt: f.before },
    ];
    if (mode === "mutated") {
      return [...base, { pid: 21, ppid: 10, command: `claude --session-id ${changed ? B : A}`, startedAt: f.before }];
    }
    return changed ? [...base, { pid: 21, ppid: 10, command: `claude --session-id ${B}`, startedAt: f.before }] : base;
  });
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_mismatch",
    message: expect.stringContaining("changed during native resolution"),
  });
});

it("keeps a legacy verdict stable when closing census returns matching descendants in another order", async () => {
  const f = fixture("claude-code");
  f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=NULL WHERE node_id=?").run(f.node.id);
  const root = { pid: 10, ppid: 1, command: "zsh", startedAt: f.before };
  const first = { pid: 20, ppid: 10, command: `claude --session-id ${A}`, startedAt: f.before };
  const second = { pid: 21, ppid: 10, command: `claude --session-id ${A}`, startedAt: f.before };
  vi.mocked(ProcessCensus.prototype.list).mockImplementation(async (opts) => opts?.fresh
    ? [root, second, first]
    : [root, first, second]);
  const resolved = await resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store);
  expect(resolved.identity).toEqual(f.expected);
});

it("closing fresh read does not reuse an earlier in-flight readProcessTable() snapshot", async () => {
  const f = fixture("claude-code");
  vi.mocked(ProcessCensus.prototype.list).mockRestore();
  const later = lstart(new Date(Date.parse(f.observedAt) + 5_000));
  serveFakeProc([
    { pid: 10, ppid: 1, pgid: 10, tpgid: 20, name: "zsh", startedAt: f.before, command: "zsh" },
    { pid: 20, ppid: 10, pgid: 20, tpgid: 20, name: "claude", startedAt: f.before, command: `claude --session-id ${A}` },
  ]);
  let inFlight: ReturnType<typeof readProcessTable> | undefined;
  const readSidecar = vi.mocked(f.store.readSidecar).getMockImplementation()!;
  vi.mocked(f.store.readSidecar).mockImplementation((name) => {
    inFlight = readProcessTable();
    serveFakeProc([
      { pid: 10, ppid: 1, pgid: 10, tpgid: 21, name: "zsh", startedAt: f.before, command: "zsh" },
      { pid: 21, ppid: 10, pgid: 21, tpgid: 21, name: "claude", startedAt: later, command: `claude --session-id ${A}` },
    ]);
    return readSidecar(name);
  });
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_mismatch",
    message: expect.stringContaining("changed during native resolution"),
  });
  expect((await inFlight!).map((row) => row.pid)).toEqual([10, 20]);
});

it("tracks a preloaded node Codex launcher in both thread selection and closing chain validation while ignoring grep codex", async () => {
  const f = fixture("codex");
  f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=10, observed_pane_pid=NULL WHERE node_id=?").run(f.node.id);
  const later = lstart(new Date(Date.parse(f.observedAt) + 5_000));
  const preloaded = `node --require preload.js /path/to/codex resume ${A}`;
  const base = [
    { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
    { pid: 20, ppid: 10, command: preloaded, startedAt: f.before },
  ];
  vi.mocked(ProcessCensus.prototype.list).mockImplementation(async (opts) => opts?.fresh
    ? [...base, { pid: 30, ppid: 20, command: "grep codex src/app.ts", startedAt: later }]
    : base);
  const resolved = await resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store);
  expect(resolved.identity).toEqual(f.expected);

  let replaced = false;
  const readPath = vi.mocked(f.store.readCodexTranscriptPath).getMockImplementation()!;
  vi.mocked(f.store.readCodexTranscriptPath).mockImplementation((...args) => {
    replaced = true;
    return readPath(...args);
  });
  vi.mocked(ProcessCensus.prototype.list).mockImplementation(async () => [
    { pid: 10, ppid: 1, command: "zsh", startedAt: f.before },
    { pid: replaced ? 21 : 20, ppid: 10, command: preloaded, startedAt: replaced ? later : f.before },
  ]);
  await expect(resolveExpectedConversation(f.expected, f.registry, f.tmux, f.store)).rejects.toMatchObject({
    code: "expected_identity_mismatch",
    message: expect.stringContaining("changed during native resolution"),
  });
});
