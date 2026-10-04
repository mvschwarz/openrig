import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { compactionRoutes } from "../src/routes/compaction.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const seat = "writer@test-rig", node = "test-node";
const input = { sessionName: seat, runtime: "claude-code", usedPercentage: 90 };
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0)) dispose();
});

function fixture(kind: "legacy" | "fresh" | "adopt" = "legacy", primaryMiss = false) {
  const db = createDb();
  cleanup.push(() => db.close());
  // Seed a valid running binding before migration 060, then migrate normally.
  // No deleted ledger rows, failed mint or null guard double creates the gap.
  migrate(db, ALL_MIGRATIONS.filter(m => m.name < "060"));
  db.prepare("INSERT INTO rigs (id,name) VALUES (?,?)").run("test-rig-id", "test-rig");
  db.prepare("INSERT INTO nodes (id,rig_id,logical_id,role,runtime) VALUES (?,?,?,?,?)")
    .run(node, "test-rig-id", "writer", "worker", "claude-code");
  db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)")
    .run("test-binding", node, seat, "%1");
  if (kind === "legacy") db.prepare(`INSERT INTO sessions (id,node_id,session_name,status,origin,startup_status)
    VALUES (?,?,?,'running','launched','ready')`).run("000legacy-session", node, seat);
  migrate(db, ALL_MIGRATIONS);
  const registry = new SessionRegistry(db), rigRepo = new RigRepository(db);
  if (kind === "fresh") {
    const s = registry.registerSession(node, seat);
    registry.updateStatus(s.id, "running");
  }
  if (kind === "adopt") registry.registerClaimedSession(node, seat);
  const home = mkdtempSync(join(tmpdir(), "compaction-generation-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  const writes: string[] = [], keys: string[][] = [];
  let clock = Date.now(), onSleep: (() => Promise<void>) | undefined;
  const tmux: any = {
    deliveryGuard: guard,
    probeSession: vi.fn(async () => ({ state: "present" })),
    hasSession: vi.fn(async () => true),
    listPanes: vi.fn(async () => [{ id: "%1" }]),
    getPaneCommand: vi.fn(async () => "claude"),
    setSessionOption: vi.fn(async () => ({ ok: true })),
    sendText: vi.fn(async (_: string, text: string) => { writes.push(text); return { ok: true }; }),
    sendKeys: vi.fn(async (_: string, k: string[]) => { keys.push(k); return { ok: true }; }),
  };
  const transport = new SessionTransport({
    db, rigRepo, sessionRegistry: registry, tmuxAdapter: tmux,
    sleep: async ms => { clock += ms; }, now: () => new Date(clock), waitForIdlePollMs: 5,
  });
  // Physical input and native activity are offline boundaries. SQL metadata,
  // generation lookups, guarded transport, enforcer and both routes are real.
  (transport as any).claudeDeliveryObservation = async () => ({ state: "unknown", detail: "offline native boundary" });
  (transport as any).classifySendReadiness = async () => ({ state: "idle", reason: "fixture idle", evidenceSource: "fixture" });
  (transport as any).diagnoseProducerLink = async () => "offline fixture";
  const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a restore map.",
    compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "" };
  const enforcer = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as any, transport, {
    openrigHome: home, now: () => clock,
    sleep: async ms => { clock += ms; await onSleep?.(); },
    resolveOccupantGeneration: s => primaryMiss ? null : registry.currentOccupantGenerationForSession(s),
  });
  const claim = new ClaimService({ db, rigRepo, sessionRegistry: registry,
    discoveryRepo: new DiscoveryRepository(db), eventBus: new EventBus(db), tmuxAdapter: tmux });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("db" as never, db);
    c.set("compactionEnforcer" as never, enforcer);
    c.set("sessionTransport" as never, transport);
    c.set("contextUsageStore" as never, { getForNode: () => ({ availability: "known", usedPercentage: 90 }) });
    c.set("claimService" as never, claim);
    // The reconcile converge operation uses ClaimService, never the launcher.
    c.set("podInstantiator" as never, {});
    await next();
  });
  app.route("/api/compaction", compactionRoutes());
  app.route("/api/sessions", sessionAdminRoutes);
  const req = async (path: string, body?: unknown) => {
    const response = await app.request(path, body === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { db, registry, guard, transport, enforcer, writes, keys, req, clock: () => clock,
    onSleep: (fn: () => Promise<void>) => { onSleep = fn; } };
}

function publish(f: ReturnType<typeof fixture>, attempt = f.enforcer.getPreparationState(seat)!) {
  mkdirSync(dirname(attempt.mapPath), { recursive: true });
  writeFileSync(attempt.mapPath + ".tmp", `# Restore map\nCurrent work and next action.\n${attempt.marker}\n`);
  renameSync(attempt.mapPath + ".tmp", attempt.mapPath);
}
function compacts(f: ReturnType<typeof fixture>) { return f.writes.filter(t => t.startsWith("/compact")); }
const trigger = "/api/compaction/trigger", state = "/api/compaction/state?session=" + encodeURIComponent(seat);
const reconcile = "/api/sessions/" + encodeURIComponent(seat) + "/reconcile";

it("missing generation fails at the public route before preparation and names explicit recovery", async () => {
  const f = fixture(), requestAt = f.clock();
  expect(f.db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
  expect(f.registry.currentOccupantGenerationForSession(seat)).toBeNull();
  expect(f.guard.maybeTarget(seat)).toEqual({ nodeId: node, session: seat, pane: "%1", occupant: null });
  const result = await f.req(trigger, { session: seat });
  expect(result.status).toBe(409);
  expect(result.body.reason).toBe("occupant_generation_unavailable");
  expect(result.body.error).toContain(`rig reconcile-session ${shellQuote(seat)} --no-launch`);
  expect(result.body.error).toContain(`explicitly retry rig compact ${shellQuote(seat)}`);
  const current = await f.req(state);
  expect(current.body.preparation).toMatchObject({ status: "stopped", occupantGeneration: null,
    reason: "occupant_generation_unavailable" });
  expect(current.body.guidance).toBe(result.body.error);
  expect(f.clock()).toBe(requestAt);
  expect(f.writes).toEqual([]);
  expect(f.keys).toEqual([]);
});

it("missing generation disarms automatic preparation; public reconcile requires a new deliberate attempt", async () => {
  const f = fixture();
  const result = await f.enforcer.maybeAutoCompact(input);
  expect("reason" in result ? result.reason : undefined).toBe("occupant_generation_unavailable");
  expect(result.triggered).toBe(false);
  const stopped = f.enforcer.getPreparationState(seat)!;
  expect(stopped.status).toBe("stopped");
  expect((await f.req(state)).body.guidance).toContain("--no-launch");
  // Same API called by `rig reconcile-session <seat> --no-launch`, with no hidden
  // rig/node arguments needed for the persisted canonical binding.
  const recovered = await f.req(reconcile, {});
  expect(recovered).toMatchObject({ status: 200, body: { ok: true } });
  const generation = f.registry.currentOccupantGenerationForSession(seat);
  expect(generation).toMatch(/^[0-9a-f-]{36}$/i);
  expect(f.guard.maybeTarget(seat)?.occupant).toBe(generation);
  publish(f, stopped);
  await f.enforcer.maybeAutoCompact(input);
  expect(f.enforcer.getPreparationState(seat)?.attemptId).toBe(stopped.attemptId);
  expect(f.writes).toEqual([]);
  expect(f.keys).toEqual([]);
  f.onSleep(async () => publish(f));
  expect(await f.req(trigger, { session: seat })).toMatchObject({ status: 200, body: { stage: "compact-sent" } });
  const next = f.enforcer.getPreparationState(seat)!;
  expect(next.attemptId).not.toBe(stopped.attemptId);
  expect(next.mapPath).not.toBe(stopped.mapPath);
  expect(next.occupantGeneration).toBe(generation);
  expect(compacts(f)).toHaveLength(1);
});

it("explicit skip-map still works without a generation and uses the existing 120-second budget", async () => {
  const f = fixture(), requestAt = f.clock();
  expect(await f.req(trigger, { session: seat, skipMap: true })).toMatchObject({ status: 200, body: { ok: true } });
  expect(f.enforcer.getPreparationState(seat)).toMatchObject({ occupantGeneration: null, deadlineAt: requestAt + 120000 });
  expect(f.writes).toHaveLength(2);
  expect(compacts(f)).toHaveLength(1);
});

it("skip-map cannot take over an active generationless attempt or revive cancellation", async () => {
  const f = fixture();
  let release!: (value: { ok: true }) => void;
  vi.spyOn(f.transport, "waitUntilIdle").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.req(trigger, { session: seat, skipMap: true });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const first = f.enforcer.getPreparationState(seat)!;
  expect((await f.req(trigger, { session: seat, skipMap: true })).body.reason).toBe("already_in_progress");
  await f.req("/api/compaction/cancel", { session: seat });
  release({ ok: true });
  expect((await pending).body.reason).toBe("preparation_cancelled");
  publish(f, first);
  await f.enforcer.maybeAutoCompact(input);
  expect(compacts(f)).toHaveLength(0);
  expect(f.enforcer.getPreparationState(seat)).toMatchObject({ attemptId: first.attemptId, status: "stopped" });
});

it("skip-map without generation still refuses a positive input prompt", async () => {
  const f = fixture();
  (f.transport as any).classifySendReadiness = async () => ({ state: "needs_input", reason: "permission prompt", evidenceSource: "fixture" });
  expect((await f.req(trigger, { session: seat, skipMap: true })).body.ok).toBe(false);
  expect(compacts(f)).toHaveLength(0);
});

for (const kind of ["fresh", "adopt"] as const) for (const primaryMiss of [false, true]) {
  it(`${kind} registration supports a valid map (primary resolver missed: ${primaryMiss})`, async () => {
    const f = fixture(kind, primaryMiss);
    const generation = f.registry.currentOccupantGenerationForSession(seat);
    expect(generation).toMatch(/^[0-9a-f-]{36}$/i);
    expect(f.guard.maybeTarget(seat)?.occupant).toBe(generation);
    f.onSleep(async () => publish(f));
    expect(await f.req(trigger, { session: seat })).toMatchObject({ status: 200, body: { ok: true } });
    expect(f.enforcer.getPreparationState(seat)?.occupantGeneration).toBe(generation);
    expect(compacts(f)).toHaveLength(1);
  });
}
