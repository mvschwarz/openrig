import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { computeTopBurn } from "../src/domain/usage-series.js";
import type { Database } from "better-sqlite3";

/** A Pi seat posts its spend as persisted usage entries; no sidecar or token_count file exists to poll.
 *  The context monitor reads those entries on its normal tick, so the context-usage threshold and the
 *  burn series (`rig usage top`) cover Pi seats instead of reporting them as unmeasured. */
describe("ContextMonitor — Pi usage entries (context lane + burn series)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let store: ContextUsageStore;
  let usageSamples: UsageSamplesStore;
  let monitor: ContextMonitor;
  let tmpDir: string;
  const seat = "dev-impl@pi-test";
  const piSession = "pi-session-1";
  const nodeIdRef: { value: string } = { value: "" };

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmpDir = join(tmpdir(), `context-monitor-pi-${Date.now()}`);
    mkdirSync(join(tmpDir, "state", "context-usage"), { recursive: true });
    store = new ContextUsageStore(db, { stateDir: tmpDir });
    usageSamples = new UsageSamplesStore(db);
    monitor = new ContextMonitor(db, store, undefined, undefined, undefined, usageSamples);

    const rig = rigRepo.createRig("test-rig-pi");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "pi" });
    const session = sessionRegistry.registerSession(node.id, seat);
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    nodeIdRef.value = node.id;
  });

  afterEach(() => {
    monitor.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function entry(input: {
    piSessionId?: string;
    entryId: string;
    entryTimestamp: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    origin?: "own" | "inherited" | "unknown";
  }) {
    db.prepare(
      `INSERT INTO pi_usage_entries
         (pi_session_id, entry_id, parent_entry_id, entry_timestamp, kind, usage_category, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, stop_reason, origin,
          seat_session, node_id, occupant_generation, recorded_at)
       VALUES (?, ?, NULL, ?, 'assistant', NULL, 'zai', 'glm-5.3', ?, ?, ?, 0, NULL, 'stop', ?, ?, ?, NULL, ?)`,
    ).run(
      input.piSessionId ?? piSession,
      input.entryId,
      input.entryTimestamp,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens,
      input.origin ?? "own",
      seat,
      nodeIdRef.value,
      new Date().toISOString(),
    );
  }

  it("reads the current Pi session's own spend as a known context sample", async () => {
    entry({ entryId: "e1", entryTimestamp: "2026-11-14T09:00:00.000Z", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 40_000 });
    entry({ entryId: "e2", entryTimestamp: "2026-11-14T09:05:00.000Z", inputTokens: 500, outputTokens: 50, cacheReadTokens: 60_000 });
    // History the seat must not be charged for: a fork's copied entry and an earlier launch's session.
    entry({ entryId: "fork-1", entryTimestamp: "2026-11-14T08:00:00.000Z", inputTokens: 9_000, outputTokens: 900, cacheReadTokens: 900_000, origin: "inherited" });
    entry({ piSessionId: "pi-session-0", entryId: "old-1", entryTimestamp: "2026-11-13T09:00:00.000Z", inputTokens: 7_000, outputTokens: 700, cacheReadTokens: 700_000 });

    const observed = store.readPiUsageAndNormalize({ seatSession: seat });
    expect(observed.availability).toBe("known");
    expect(observed.source).toBe("pi_usage_entries");
    expect(observed.sessionId).toBe(piSession);
    expect(observed.totalInputTokens).toBe(1_000 + 40_000 + 500 + 60_000);
    expect(observed.totalOutputTokens).toBe(150);
    expect(observed.sampledAt).toBe("2026-11-14T09:05:00.000Z");
    // Pi's usage facts carry no window size; a percent stays unknown rather than invented.
    expect(observed.usedPercentage).toBeNull();
    expect(observed.contextWindowSize).toBeNull();
  });

  it("writes both the point-in-time row and the series sample on the normal tick", async () => {
    entry({ entryId: "e1", entryTimestamp: "2026-11-14T09:00:00.000Z", inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 40_000 });
    await monitor.pollOnce();

    const pointInTime = db
      .prepare("SELECT availability, source, total_input_tokens, total_output_tokens FROM context_usage WHERE node_id = ?")
      .get(nodeIdRef.value) as { availability: string; source: string; total_input_tokens: number; total_output_tokens: number };
    expect(pointInTime.availability).toBe("known");
    expect(pointInTime.source).toBe("pi_usage_entries");
    expect(pointInTime.total_input_tokens).toBe(41_000);
    expect(pointInTime.total_output_tokens).toBe(100);

    const series = db
      .prepare("SELECT lane, source, native_session_id, total_input_tokens FROM usage_samples WHERE seat_session = ?")
      .all(seat) as Array<{ lane: string; source: string; native_session_id: string; total_input_tokens: number }>;
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ lane: "context", source: "pi_usage_entries", native_session_id: piSession, total_input_tokens: 41_000 });
  });

  it("puts the Pi seat in the ranked burn view once two turns land", async () => {
    entry({ entryId: "e1", entryTimestamp: "2026-11-14T09:00:00.000Z", inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 40_000 });
    await monitor.pollOnce();
    entry({ entryId: "e2", entryTimestamp: "2026-11-14T09:05:00.000Z", inputTokens: 500, outputTokens: 50, cacheReadTokens: 20_000 });
    await monitor.pollOnce();

    const result = computeTopBurn(db, { windowHours: 24, nowIso: new Date().toISOString(), topN: 10 });
    const rank = result.ranked.find((r) => r.seatSession === seat);
    expect(rank, `ranked: ${JSON.stringify(result.ranked)}, unknown: ${JSON.stringify(result.unknown)}`).toBeDefined();
    // The second turn's whole context (fresh + cache read) and its output are the burn between the two samples.
    expect(rank!.tokensDelta).toBe(500 + 20_000 + 50);
    expect(rank!.samples).toBe(2);
    expect(result.totalRankedSeats).toBeGreaterThanOrEqual(1);
  });

  it("does not advance the series again when no entry was posted", async () => {
    entry({ entryId: "e1", entryTimestamp: "2026-11-14T09:00:00.000Z", inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 40_000 });
    await monitor.pollOnce();
    await monitor.pollOnce();
    const count = db.prepare("SELECT COUNT(*) AS n FROM usage_samples WHERE seat_session = ?").get(seat) as { n: number };
    expect(count.n).toBe(1);
  });

  it("reports an unmeasured Pi seat as unknown, never a zero sample", async () => {
    await monitor.pollOnce();
    const observed = store.readPiUsageAndNormalize({ seatSession: seat });
    expect(observed.availability).toBe("unknown");
    expect(observed.reason).toBe("no_data");
    const count = db.prepare("SELECT COUNT(*) AS n FROM usage_samples WHERE seat_session = ?").get(seat) as { n: number };
    expect(count.n).toBe(0);
  });
});
