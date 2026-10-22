// 51-08 A1 — the WIRING pin: the series accrues from the REAL 30s tick
// (ContextMonitor.pollOnce), not from a store call a test makes directly.
// PM-ruled decision 1: piggyback the existing tick — no parallel sampler.
// RED-first: written before ContextMonitor accepted a UsageSamplesStore.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { UsageSamplesStore, type ProviderWindowSampleInput } from "../src/domain/usage-samples-store.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";
import type { ReadinessResult } from "../src/domain/runtime-adapter.js";

describe("51-08 A1 wiring — the series accrues from the real poll tick", () => {
  let db: Database;
  let store: ContextUsageStore;
  let samples: UsageSamplesStore;
  let monitor: ContextMonitor;
  let tmpDir: string;
  let sessionName: string;
  let providerRows: ProviderWindowSampleInput[];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    tmpDir = join(tmpdir(), `usage-samples-wiring-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, "state", "context-usage"), { recursive: true });
    store = new ContextUsageStore(db, { stateDir: tmpDir, codexHomeDir: tmpDir });
    samples = new UsageSamplesStore(db);
    providerRows = [];

    const rig = rigRepo.createRig("t-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "claude-code" });
    sessionName = "dev-qa@t-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    monitor = new ContextMonitor(
      db,
      store,
      {
        ensureContextCollector: vi.fn(),
        checkReady: vi.fn(async (): Promise<ReadinessResult> => ({ ready: true })),
      },
      undefined,
      undefined,
      samples,
      () => providerRows,
    );
  });

  afterEach(() => {
    monitor.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSidecar(over: Record<string, unknown> = {}) {
    const safe = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_");
    writeFileSync(
      join(tmpDir, "state", "context-usage", `${safe}.json`),
      JSON.stringify({
        session_name: sessionName,
        sampled_at: "2026-08-07T09:00:00.000Z",
        context_window: {
          context_window_size: 200000,
          used_percentage: 10,
          remaining_percentage: 90,
          total_input_tokens: 1000,
          total_output_tokens: 100,
        },
        ...over,
      }),
    );
  }

  const seriesCount = (lane: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM usage_samples WHERE lane = ?").get(lane) as { n: number }).n;

  it("does not report a new conversation's starting tokens as burn through the telemetry route", async () => {
    vi.useFakeTimers();
    try {
      for (const [at, sessionId, input] of [
        ["2026-08-07T10:00:00.000Z", "old", 1000],
        ["2026-08-07T10:30:00.000Z", "old", 1200],
        ["2026-08-07T11:00:00.000Z", "new", 100_000],
        ["2026-08-07T12:00:00.000Z", "new", 100_500],
      ] as const) {
        vi.setSystemTime(new Date(at));
        writeSidecar({ session_id: sessionId, sampled_at: at,
          context_window: { context_window_size: 200000, used_percentage: 10,
            total_input_tokens: input, total_output_tokens: 100 } });
        await monitor.pollOnce();
      }
      const app = telemetryRoutes({ db: () => db, nowIso: () => "2026-08-07T12:00:00.000Z" });
      const response = await app.request("/usage/top?window_hours=4");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ranked: [{ seatSession: sessionName, tokensDelta: 700, tokensPerHour: 350, resets: 0, samples: 4 }],
        unknown: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("two polls over an UNCHANGED sidecar append ONE context row; an advanced sidecar appends the second", async () => {
    writeSidecar();
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(seriesCount("context")).toBe(1); // idle seat: zero growth on the second tick
    writeSidecar({
      sampled_at: "2026-08-07T09:00:30.000Z",
      context_window: {
        context_window_size: 200000,
        used_percentage: 12,
        remaining_percentage: 88,
        total_input_tokens: 4000,
        total_output_tokens: 300,
      },
    });
    await monitor.pollOnce();
    expect(seriesCount("context")).toBe(2);
    // and the point-in-time lane REGRESSION PIN: context_usage stays a single upserted row
    const cu = db.prepare("SELECT COUNT(*) AS n FROM context_usage").get() as { n: number };
    expect(cu.n).toBe(1);
  });

  it("the provider-window supplier is drained on the same tick, advance-only", async () => {
    writeSidecar();
    providerRows = [
      { seatSession: sessionName, window: "five_hour", usedPercent: 41, resetsAt: "2026-08-07T12:00:00.000Z", asOf: "2026-08-07T09:00:00.000Z" },
      { seatSession: sessionName, window: "weekly", usedPercent: 12, resetsAt: null, asOf: "2026-08-07T09:00:00.000Z" },
    ];
    await monitor.pollOnce();
    expect(seriesCount("provider_window")).toBe(2);
    await monitor.pollOnce(); // unchanged supplier output → no growth
    expect(seriesCount("provider_window")).toBe(2);
    providerRows = [
      { seatSession: sessionName, window: "five_hour", usedPercent: 44, resetsAt: "2026-08-07T12:00:00.000Z", asOf: "2026-08-07T09:05:00.000Z" },
    ];
    await monitor.pollOnce();
    expect(seriesCount("provider_window")).toBe(3);
  });

  it("a throwing provider supplier never breaks the poll (defensive parity with the enforcer seam)", async () => {
    writeSidecar();
    const boom = () => {
      throw new Error("supplier down");
    };
    const m2 = new ContextMonitor(
      db,
      store,
      { ensureContextCollector: vi.fn(), checkReady: vi.fn(async (): Promise<ReadinessResult> => ({ ready: true })) },
      undefined,
      undefined,
      samples,
      boom,
    );
    await expect(m2.pollOnce()).resolves.toBeUndefined();
    expect(seriesCount("context")).toBe(1); // context lane still landed
    m2.stop();
  });
});
