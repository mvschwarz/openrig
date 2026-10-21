import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { NodeBinding, ReadinessResult } from "../src/domain/runtime-adapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("context observations retain their compaction target", () => {
  let db: Database.Database;
  let home: string;
  let repo: RigRepository;
  let registry: SessionRegistry;
  let store: ContextUsageStore;
  let guard: SeatDeliveryGuard;
  let enforcer: ClaudeCompactionEnforcer;
  let transport: SessionTransport;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    home = mkdtempSync(join(tmpdir(), "context-compaction-race-"));
    repo = new RigRepository(db);
    registry = new SessionRegistry(db);
    store = new ContextUsageStore(db, { stateDir: home });
    guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    const settings = new SettingsStore(join(home, "settings.json"));
    settings.set("policies.claude_compaction.enabled", "true");
    settings.set("policies.claude_compaction.threshold_percent", "80");
    send = vi.fn(async (seat: string, _text: string) => guard.input(seat, async () => {
      guard.checkInput(seat);
      return { ok: true };
    }));
    transport = { deliveryGuard: guard, send } as unknown as SessionTransport;
    enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: home,
      resolveOccupantGeneration: seat => registry.currentOccupantGenerationForSession(seat),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seed(name = "writer@fixture", startup: "ready" | "failed" = "failed") {
    const rig = repo.createRig(name);
    const node = repo.addNode(rig.id, "writer", { runtime: "claude-code", cwd: home });
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, startup);
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: `%${node.id}` });
    usage(name, 90);
    return { rig, node, session, name };
  }
  function usage(name: string, percentage: number, sampledAt = new Date().toISOString()) {
    const dir = join(home, "state", "context-usage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({
      session_name: name, session_id: "native-fixture", sampled_at: sampledAt,
      context_window: { used_percentage: percentage, remaining_percentage: 100 - percentage,
        total_input_tokens: 1000, total_output_tokens: 100, context_window_size: 200000 },
    }));
  }
  function monitor(checkReady: (binding: NodeBinding) => Promise<ReadinessResult>, samples?: UsageSamplesStore) {
    return new ContextMonitor(db, store, { ensureContextCollector: vi.fn(), checkReady }, enforcer, undefined, samples);
  }

  it.each(["generation", "replacement", "stopped", "pane", "retry"] as const)(
    "does not prepare compaction after %s changes during readiness observation", async change => {
      const { rig, node, session, name } = seed();
      const entered = deferred<void>();
      const probe = deferred<ReadinessResult>();
      const poller = monitor(() => { entered.resolve(); return probe.promise; });
      const poll = poller.pollOnce();
      await entered.promise;
      await guard.lifecycle([node.id], async () => {
        if (change === "generation") registry.mintOccupantTenure(node.id, "handover");
        if (change === "replacement") {
          const next = registry.registerSession(node.id, name);
          registry.updateStatus(next.id, "running");
          registry.updateStartupStatus(next.id, "ready");
        }
        if (change === "stopped") registry.updateStatus(session.id, "exited");
        if (change === "pane") registry.updateBinding(node.id, { tmuxPane: "%new" });
        if (change === "retry") {
          const events = new EventBus(db);
          events.emit({ type: "node.startup_pending", rigId: rig.id, nodeId: node.id });
          events.emit({ type: "node.startup_failed", rigId: rig.id, nodeId: node.id, sessionId: session.id, error: "fixture retry" });
        }
        guard.rebindLifecycle(node.id);
      });
      probe.resolve({ ready: true });
      await poll;
      expect(send).not.toHaveBeenCalled();
      expect(enforcer.getPreparationState(name)).toBeNull();
      if (change !== "stopped") {
        usage(name, 10);
        await poller.pollOnce();
        expect(send).not.toHaveBeenCalled();
        usage(name, 90);
        await poller.pollOnce();
        expect(send).toHaveBeenCalledTimes(1);
        expect(enforcer.getPreparationState(name)).toMatchObject({
          occupantGeneration: registry.currentOccupantGenerationForSession(name), status: "waiting",
        });
      }
    },
  );

  it("also rejects an obsolete observation when no delivery guard is supplied", async () => {
    Object.assign(transport, { deliveryGuard: undefined });
    const { node, name } = seed();
    const entered = deferred<void>();
    const probe = deferred<ReadinessResult>();
    const poll = monitor(() => { entered.resolve(); return probe.promise; }).pollOnce();
    await entered.promise;
    registry.mintOccupantTenure(node.id, "handover");
    probe.resolve({ ready: true });
    await poll;
    expect(send).not.toHaveBeenCalled();
    expect(enforcer.getPreparationState(name)).toBeNull();
  });

  it("does not read or compact a later seat retired while an earlier seat was observed", async () => {
    const seats = [seed("first@fixture"), seed("second@fixture")];
    const entered = deferred<NodeBinding>();
    const probe = deferred<ReadinessResult>();
    const read = vi.spyOn(store, "readAndNormalize");
    const poll = monitor(binding => { entered.resolve(binding); return probe.promise; }).pollOnce();
    const first = await entered.promise;
    const later = seats.find(seat => seat.node.id !== first.nodeId)!;
    await guard.lifecycle([later.node.id], async () => { registry.updateStatus(later.session.id, "exited"); });
    probe.resolve({ ready: true });
    await poll;
    expect(read.mock.calls.map(args => args[0])).not.toContain(later.name);
    expect(send.mock.calls.map(args => args[0])).not.toContain(later.name);
    expect(enforcer.getPreparationState(later.name)).toBeNull();
  });

  it("rechecks eligibility after waiting behind a lifecycle operation", async () => {
    const { node, session, name } = seed("writer@fixture", "ready");
    const entered = deferred<void>();
    const release = deferred<void>();
    const queued = deferred<void>();
    const compact = enforcer.maybeAutoCompact.bind(enforcer);
    vi.spyOn(enforcer, "maybeAutoCompact").mockImplementation(input => { queued.resolve(); return compact(input); });
    const lifecycle = guard.lifecycle([node.id], async () => {
      entered.resolve();
      await release.promise;
      registry.updateStatus(session.id, "exited");
    });
    await entered.promise;
    const poll = monitor(async () => ({ ready: true })).pollOnce();
    await queued.promise;
    release.resolve();
    await lifecycle;
    await poll;
    expect(send).not.toHaveBeenCalled();
    expect(enforcer.getPreparationState(name)).toBeNull();
  });

  it.each([
    { readiness: { ready: true }, expected: "ready" },
    { readiness: { ready: false, code: "trust_gate", reason: "fixture trust prompt" }, expected: "attention_required" },
  ])("allows its own $expected readiness normalization and the next current observation", async ({ readiness, expected }) => {
    const { session, name } = seed();
    const poller = monitor(async () => readiness);
    await poller.pollOnce();
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id)).toEqual({ startup_status: expected });
    expect(send).toHaveBeenCalledTimes(1);
    expect(enforcer.getPreparationState(name)).toMatchObject({ status: "waiting" });
  });

  it.each([
    { path: "sampled", field: "startup_status" },
    { path: "sampled", field: "startup_completed_at" },
    { path: "pending", field: "startup_status" },
    { path: "pending", field: "startup_completed_at" },
  ] as const)("rejects an independent $field change during readiness on the $path path", async ({ path, field }) => {
    const { session, name } = seed("writer@fixture", "ready");
    const entered = deferred<void>();
    const probe = deferred<ReadinessResult>();
    const poller = monitor(() => { entered.resolve(); return probe.promise; });
    if (path === "pending") {
      await poller.pollOnce();
      const prep = enforcer.getPreparationState(name)!;
      writeFileSync(`${prep.mapPath}.tmp`, `# Fixture restore map\n${prep.marker}\n`);
      await poller.pollOnce();
      expect(enforcer.hasPendingPostCompactStage(name)).toBe(true);
      rmSync(join(home, "state", "context-usage", `${name}.json`));
    }
    registry.updateStartupStatus(session.id, "failed");
    const sendsBefore = send.mock.calls.length;
    const poll = poller.pollOnce();
    await entered.promise;
    if (field === "startup_status") registry.updateStartupStatus(session.id, "attention_required");
    else registry.updateStartupStatus(session.id, "failed", "2026-01-01T00:00:00.000Z");
    probe.resolve({ ready: true });
    await poll;
    expect(send).toHaveBeenCalledTimes(sendsBefore);
    if (path === "sampled") expect(enforcer.getPreparationState(name)).toBeNull();
    else expect(enforcer.hasPendingPostCompactStage(name)).toBe(true);

    await poller.pollOnce();
    expect(send).toHaveBeenCalledTimes(sendsBefore + 1);
  });

  it.each([
    { path: "sampled", field: "startup_status" },
    { path: "sampled", field: "startup_completed_at" },
    { path: "pending", field: "startup_status" },
    { path: "pending", field: "startup_completed_at" },
  ] as const)("keeps a later seat's usage when its $field changes while an earlier seat is observed ($path)", async ({ path, field }) => {
    const samples = new UsageSamplesStore(db);
    const startup = path === "pending" ? "ready" : "failed";
    const seats = [seed("first@fixture", startup), seed("second@fixture", startup)];
    let blockNext = false;
    const entered = deferred<NodeBinding>();
    const probe = deferred<ReadinessResult>();
    const poller = monitor(binding => {
      if (!blockNext) return Promise.resolve({ ready: true });
      blockNext = false;
      entered.resolve(binding);
      return probe.promise;
    }, samples);
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    let sampledAt = minutesAgo(0);
    if (path === "pending") {
      await poller.pollOnce();
      for (const { name } of seats) {
        const prep = enforcer.getPreparationState(name)!;
        writeFileSync(`${prep.mapPath}.tmp`, `# Fixture restore map\n${prep.marker}\n`);
      }
      await poller.pollOnce();
      for (const { name } of seats) expect(enforcer.hasPendingPostCompactStage(name)).toBe(true);
      // A known but stale sample is still recorded, and leaves the pending stage to drain.
      sampledAt = minutesAgo(20);
      for (const { session } of seats) registry.updateStartupStatus(session.id, "failed");
    }
    for (const { name } of seats) usage(name, 90, sampledAt);
    const sendsTo = (name: string) => send.mock.calls.filter(args => args[0] === name).length;
    const sentBefore = new Map(seats.map(({ name }) => [name, sendsTo(name)]));

    blockNext = true;
    const poll = poller.pollOnce();
    const first = await entered.promise;
    const later = seats.find(seat => seat.node.id !== first.nodeId)!;
    if (field === "startup_status") registry.updateStartupStatus(later.session.id, "attention_required");
    else registry.updateStartupStatus(later.session.id, "failed", "2026-01-01T00:00:00.000Z");
    const readiness = () => db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(later.session.id);
    const changed = readiness();
    probe.resolve({ ready: true });
    await poll;

    const series = () => (db.prepare(
      "SELECT sampled_at FROM usage_samples WHERE lane = 'context' AND seat_session = ? ORDER BY id",
    ).all(later.name) as Array<{ sampled_at: string }>).map(row => row.sampled_at);
    expect(store.getForNode(later.node.id, later.name)).toMatchObject({ usedPercentage: 90, sampledAt });
    expect(series()).toContain(sampledAt);
    // The stale observation neither normalizes nor compacts or drains.
    expect(readiness()).toEqual(changed);
    expect(sendsTo(later.name)).toBe(sentBefore.get(later.name));
    if (path === "sampled") expect(enforcer.getPreparationState(later.name)).toBeNull();
    else expect(enforcer.hasPendingPostCompactStage(later.name)).toBe(true);

    const nextSampledAt = path === "pending" ? minutesAgo(19) : minutesAgo(0);
    usage(later.name, 91, nextSampledAt);
    await poller.pollOnce();
    expect(series().indexOf(sampledAt)).toBeGreaterThanOrEqual(0);
    expect(series().indexOf(nextSampledAt)).toBeGreaterThan(series().indexOf(sampledAt));
    expect(store.getForNode(later.node.id, later.name)).toMatchObject({ usedPercentage: 91, sampledAt: nextSampledAt });
  });

  it.each(["startup_status", "startup_completed_at"] as const)(
    "rejects a later %s change after its own normalization while waiting for the lease", async field => {
      const { node, session, name } = seed();
      const entered = deferred<void>();
      const release = deferred<void>();
      const queued = deferred<void>();
      const compact = enforcer.maybeAutoCompact.bind(enforcer);
      vi.spyOn(enforcer, "maybeAutoCompact").mockImplementation(input => { queued.resolve(); return compact(input); });
      const lifecycle = guard.lifecycle([node.id], async () => {
        entered.resolve();
        await release.promise;
        if (field === "startup_status") registry.updateStartupStatus(session.id, "attention_required");
        else registry.updateStartupStatus(session.id, "ready", "2026-01-01T00:00:00.000Z");
      });
      await entered.promise;
      const poller = monitor(async () => ({ ready: true }));
      const poll = poller.pollOnce();
      await queued.promise;
      expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id)).toEqual({ startup_status: "ready" });
      release.resolve();
      await lifecycle;
      await poll;
      expect(send).not.toHaveBeenCalled();
      expect(enforcer.getPreparationState(name)).toBeNull();
      await poller.pollOnce();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("does not advance an unsampled pending stage after a queued stop, then drains a current poll", async () => {
    const { node, session, name } = seed("writer@fixture", "ready");
    const poller = monitor(async () => ({ ready: true }));
    await poller.pollOnce();
    const prep = enforcer.getPreparationState(name)!;
    writeFileSync(`${prep.mapPath}.tmp`, `# Fixture restore map\n${prep.marker}\n`);
    await poller.pollOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(enforcer.hasPendingPostCompactStage(name)).toBe(true);
    rmSync(join(home, "state", "context-usage", `${name}.json`));

    const entered = deferred<void>();
    const release = deferred<void>();
    const queued = deferred<void>();
    const drain = enforcer.drainPendingPostCompactStage.bind(enforcer);
    vi.spyOn(enforcer, "drainPendingPostCompactStage").mockImplementation(input => { queued.resolve(); return drain(input); });
    const lifecycle = guard.lifecycle([node.id], async () => {
      entered.resolve();
      await release.promise;
      registry.updateStatus(session.id, "exited");
    });
    await entered.promise;
    const poll = poller.pollOnce();
    await queued.promise;
    release.resolve();
    await lifecycle;
    await poll;
    expect(send).toHaveBeenCalledTimes(2);
    expect(enforcer.hasPendingPostCompactStage(name)).toBe(true);

    registry.updateStatus(session.id, "running");
    await poller.pollOnce();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[1]).toContain("OpenRig post-compaction turn boundary.");
  });
});
