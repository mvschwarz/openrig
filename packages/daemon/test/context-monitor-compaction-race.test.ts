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
  function usage(name: string, percentage: number) {
    const dir = join(home, "state", "context-usage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({
      session_name: name, session_id: "native-fixture", sampled_at: new Date().toISOString(),
      context_window: { used_percentage: percentage, remaining_percentage: 100 - percentage,
        total_input_tokens: 1000, total_output_tokens: 100, context_window_size: 200000 },
    }));
  }
  function monitor(checkReady: (binding: NodeBinding) => Promise<ReadinessResult>) {
    return new ContextMonitor(db, store, { ensureContextCollector: vi.fn(), checkReady }, enforcer);
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

  it("allows its own readiness normalization and the next current observation", async () => {
    const { session, name } = seed();
    const poller = monitor(async () => ({ ready: true }));
    await poller.pollOnce();
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id)).toEqual({ startup_status: "ready" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(enforcer.getPreparationState(name)).toMatchObject({ status: "waiting" });
  });

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
