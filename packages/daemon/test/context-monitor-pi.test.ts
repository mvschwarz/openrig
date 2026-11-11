import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore, FRESHNESS_THRESHOLD_MS } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

// openrig#2967 — Wave 2 lane B: the context monitor consumes the Pi runner
// sidecar's launch-scoped contextUsage. Pi only; OMP stays excluded.

describe("ContextMonitor pi context usage", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let store: ContextUsageStore;
  let monitor: ContextMonitor;
  let tmpDir: string;
  let sidecarBySession: Map<string, PiRunnerState | null>;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmpDir = join(tmpdir(), `context-monitor-pi-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new ContextUsageStore(db, { stateDir: tmpDir });
    sidecarBySession = new Map();
    monitor = new ContextMonitor(db, store, undefined, undefined, undefined, undefined, undefined,
      sessionName => sidecarBySession.get(sessionName) ?? null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    monitor.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedNode(runtime: "pi" | "omp", sessionName: string) {
    const rig = rigRepo.createRig(`test-rig-${runtime}`);
    const node = rigRepo.addNode(rig.id, `dev.${runtime}`, { runtime });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    return { node, sessionName };
  }

  function runnerState(overrides: Partial<PiRunnerState> = {}): PiRunnerState {
    return { ready: true, sessionId: "pi-session-1", sessionFile: "/state/pi/sessions/s.jsonl", updatedAt: new Date().toISOString(), ...overrides };
  }

  it("polls a running pi seat, persists the sidecar sample with source pi", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi@test");
    sidecarBySession.set(sessionName, runnerState({
      contextUsage: { tokens: 123, percent: 1.23, contextWindow: 10000, updatedAt: new Date().toISOString() },
    }));

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.source).toBe("pi");
    expect(usage.usedPercentage).toBe(1);
    expect(usage.remainingPercentage).toBe(99);
    expect(usage.contextWindowSize).toBe(10000);
    expect(usage.totalInputTokens).toBe(123);
    expect(usage.sessionId).toBe("pi-session-1");
    expect(usage.sessionName).toBe(sessionName);
    expect(usage.fresh).toBe(true);
  });

  it("does not poll omp seats even with a runner sidecar", async () => {
    const { node, sessionName } = seedNode("omp", "dev-omp@test");
    sidecarBySession.set(sessionName, runnerState({
      contextUsage: { tokens: 500, percent: 5, contextWindow: 10000, updatedAt: new Date().toISOString() },
    }));

    await monitor.pollOnce();

    expect(store.getForNode(node.id, sessionName).availability).toBe("unknown");
    expect(db.prepare("SELECT COUNT(*) AS n FROM context_usage WHERE node_id = ?").get(node.id)).toEqual({ n: 0 });
  });

  it("reads unknown, not zero, while pi reports null tokens and percent after compaction", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi-null@test");
    sidecarBySession.set(sessionName, runnerState({
      contextUsage: { tokens: null, percent: null, contextWindow: 200000, updatedAt: new Date().toISOString() },
    }));

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.usedPercentage).toBeNull();
  });

  it("replaces a known reading with honest unknown after compaction, never a fabricated decrease", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi-drop@test");
    sidecarBySession.set(sessionName, runnerState({
      contextUsage: { tokens: 180000, percent: 90, contextWindow: 200000, updatedAt: new Date().toISOString() },
    }));
    await monitor.pollOnce();
    expect(store.getForNode(node.id, sessionName).usedPercentage).toBe(90);

    sidecarBySession.set(sessionName, runnerState({
      contextUsage: { tokens: null, percent: null, contextWindow: 200000, updatedAt: new Date().toISOString() },
    }));
    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.usedPercentage).toBeNull();
  });

  it("reads unknown when the sidecar carries no contextUsage (fresh launch or unpolled seat)", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi-missing@test");
    sidecarBySession.set(sessionName, runnerState());

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("no_data");
  });

  it("reads unknown when no runner sidecar exists at all", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi-absent@test");

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("no_data");
  });

  it("marks a known sample stale when updatedAt is older than the freshness threshold", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi-stale@test");
    const staleAt = new Date(Date.now() - FRESHNESS_THRESHOLD_MS - 1).toISOString();
    sidecarBySession.set(sessionName, runnerState({
      contextUsage: { tokens: 1000, percent: 10, contextWindow: 10000, updatedAt: staleAt },
    }));

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.fresh).toBe(false);
    expect(usage.sampledAt).toBe(staleAt);
  });

  it("computes the percentage from tokens and contextWindow when percent is null", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi-tokens@test");
    sidecarBySession.set(sessionName, runnerState({
      contextUsage: { tokens: 2500, percent: null, contextWindow: 10000, updatedAt: new Date().toISOString() },
    }));

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(25);
  });

  it("reads unknown without a pi runner reader instead of a Claude sidecar", async () => {
    const { node, sessionName } = seedNode("pi", "dev-pi-noreader@test");
    const readerless = new ContextMonitor(db, store);

    await readerless.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("unsupported_runtime");
  });
});
