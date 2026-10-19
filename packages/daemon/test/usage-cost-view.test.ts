// OPR.0.7.0.2 (cost reporting, first atom): Claude's statusline cost estimate reaches the usage series bound to
// its native session; the cost view labels each seat's figure by kind, source, window and coverage, and reports
// absent or stale evidence as such, never as zero. Codex shows tokens with the method-scoped no-cost note.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { computeCostView, CODEX_NO_COST_NOTE, queryUsageSeries } from "../src/domain/usage-series.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";
import type { ReadinessResult } from "../src/domain/runtime-adapter.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "usage-cost-")); dirs.push(d); return d; };

describe("Claude statusline collector", () => {
  const collector = resolve(__dirname, "../assets/claude-statusline-context.cjs");
  const run = (payload: unknown) => {
    const out = join(scratch(), "sidecar.json");
    const r = spawnSync("node", [collector, out], { input: JSON.stringify(payload), encoding: "utf8" });
    expect(r.status).toBe(0);
    return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  };
  const base = { session_id: "sess-1", session_name: "dev@r", context_window: { used_percentage: 5, total_input_tokens: 10, total_output_tokens: 2 } };

  it("passes cost.total_cost_usd through, and nothing else from cost", () => {
    expect(run({ ...base, cost: { total_cost_usd: 1.2345, total_duration_ms: 99 } }).cost).toEqual({ total_cost_usd: 1.2345 });
  });

  it("records no cost when Claude sends none (absent, not zero)", () => {
    expect(run(base).cost).toBeNull();
    expect(run({ ...base, cost: { total_cost_usd: "n/a" } }).cost).toBeNull();
  });
});

describe("ContextUsageStore reads the estimate", () => {
  it("normalizes the sidecar's cost, and null when absent", () => {
    const store = new ContextUsageStore(createDb(), { stateDir: scratch() });
    const raw = { session_id: "s", sampled_at: new Date().toISOString(), context_window: { used_percentage: 3 } };
    expect(store.normalizeSample({ ...raw, cost: { total_cost_usd: 0.5 } }).clientCostEstimateUsd).toBe(0.5);
    expect(store.normalizeSample(raw).clientCostEstimateUsd).toBeNull();
  });
});

function seriesDb(withCost = true): Database.Database {
  const db = createDb();
  if (withCost) migrate(db, ALL_MIGRATIONS); else db.exec(usageSamplesSchema.sql);
  return db;
}
function claude(samples: UsageSamplesStore, at: string, session: string, cost: number | null, tokens = 100) {
  return samples.appendContextSample({ nodeId: "n1", seatSession: "dev-claude@r", source: "claude_statusline_json", sampledAt: at,
    totalInputTokens: tokens, totalOutputTokens: 10, usedPercentage: 5, nativeSessionId: session, clientCostEstimateUsd: cost }, at);
}

describe("UsageSamplesStore keeps the estimate with its session", () => {
  it("writes the session and estimate; a cost change alone is a new row; an unchanged sample isn't", () => {
    const db = seriesDb();
    const samples = new UsageSamplesStore(db);
    expect(claude(samples, "2026-10-13T10:00:00.000Z", "s1", 0.4)).toBe(true);
    expect(claude(samples, "2026-10-13T10:00:00.000Z", "s1", 0.4)).toBe(false);
    expect(claude(samples, "2026-10-13T10:00:00.000Z", "s1", 0.6)).toBe(true);
    const rows = queryUsageSeries(db, { lane: "context" });
    expect(rows.map((r) => [r.nativeSessionId, r.clientCostEstimateUsd])).toEqual([["s1", 0.4], ["s1", 0.6]]);
  });

  it("works on a series without the cost columns, as before", () => {
    const db = seriesDb(false);
    const samples = new UsageSamplesStore(db);
    expect(claude(samples, "2026-10-13T10:00:00.000Z", "s1", 0.4)).toBe(true);
    expect(queryUsageSeries(db, { lane: "context" })[0]).not.toHaveProperty("clientCostEstimateUsd");
    expect(computeCostView(db, { nowIso: "2026-10-13T10:01:00.000Z" }).seats[0]).toMatchObject({ status: "absent", reason: expect.stringContaining("no cost columns") });
  });
});

describe("computeCostView", () => {
  const NOW = "2026-10-13T10:05:00.000Z";
  let db: Database.Database;
  let samples: UsageSamplesStore;
  beforeEach(() => { db = seriesDb(); samples = new UsageSamplesStore(db); });

  it("a Claude estimate: cumulative for its native session, labelled, with its window and coverage", () => {
    claude(samples, "2026-10-13T10:00:00.000Z", "s1", 0.4);
    claude(samples, "2026-10-13T10:03:00.000Z", "s1", 0.9, 300);
    const [seat] = computeCostView(db, { nowIso: NOW }).seats;
    expect(seat).toMatchObject({
      seatSession: "dev-claude@r", runtime: "claude-code", status: "reported", kind: "client-side estimate",
      source: "Claude statusline cost.total_cost_usd", costUsd: 0.9, resets: 0, stale: false, ageSeconds: 120,
      window: { nativeSessionId: "s1", since: "2026-10-13T10:00:00.000Z", asOf: "2026-10-13T10:03:00.000Z" },
      tokens: { input: 300, output: 10 },
    });
    expect((seat as { coverage: string }).coverage).toContain("not an invoice");
  });

  it("a drop within one session is a reset: counted, and the window starts again; the figure is never summed", () => {
    claude(samples, "2026-10-13T10:00:00.000Z", "s1", 2.0);
    claude(samples, "2026-10-13T10:01:00.000Z", "s1", 0.3);
    claude(samples, "2026-10-13T10:02:00.000Z", "s1", 0.5);
    expect(computeCostView(db, { nowIso: NOW }).seats[0]).toMatchObject({ costUsd: 0.5, resets: 1, window: { since: "2026-10-13T10:01:00.000Z" } });
  });

  it("a new native session is a new window; the old session's estimate stays in the series as history", () => {
    claude(samples, "2026-10-13T10:00:00.000Z", "s1", 3.0);
    claude(samples, "2026-10-13T10:02:00.000Z", "s2", 0.2);
    expect(computeCostView(db, { nowIso: NOW }).seats[0]).toMatchObject({ costUsd: 0.2, resets: 0, window: { nativeSessionId: "s2" } });
    expect(queryUsageSeries(db, { lane: "context" }).map((r) => r.clientCostEstimateUsd)).toEqual([3.0, 0.2]);
  });

  it("an old estimate reads stale and is still shown, never expired to zero", () => {
    claude(samples, "2026-10-13T08:00:00.000Z", "s1", 1.5);
    expect(computeCostView(db, { nowIso: NOW }).seats[0]).toMatchObject({ status: "reported", costUsd: 1.5, stale: true, ageSeconds: 7500 });
  });

  it("a Claude session with no reported cost reads absent, not $0", () => {
    claude(samples, "2026-10-13T10:00:00.000Z", "s1", null);
    const [seat] = computeCostView(db, { nowIso: NOW }).seats;
    expect(seat).toMatchObject({ status: "absent", reason: "Claude's statusline has reported no cost for this session" });
    expect(seat).not.toHaveProperty("costUsd");
  });

  it("a Codex seat shows tokens and the method-scoped no-cost note, and no dollar figure", () => {
    samples.appendContextSample({ nodeId: "n2", seatSession: "dev-codex@r", source: "codex_token_count_jsonl", sampledAt: "2026-10-13T10:04:00.000Z",
      totalInputTokens: 5000, totalOutputTokens: 400, usedPercentage: 12, nativeSessionId: "019a-thread", clientCostEstimateUsd: null }, "2026-10-13T10:04:00.000Z");
    const [seat] = computeCostView(db, { nowIso: NOW }).seats;
    expect(seat).toEqual({ seatSession: "dev-codex@r", runtime: "codex", status: "no-cost-method", note: CODEX_NO_COST_NOTE,
      window: { nativeSessionId: "019a-thread", asOf: "2026-10-13T10:04:00.000Z" }, tokens: { input: 5000, output: 400 } });
  });

  it("the route serves the view, filtered by seat; an empty series is an empty list", async () => {
    claude(samples, "2026-10-13T10:00:00.000Z", "s1", 0.4);
    const app = telemetryRoutes({ db: () => db, nowIso: () => NOW });
    const all = await (await app.request("/usage/cost")).json() as { seats: unknown[]; note: string };
    expect(all.seats).toHaveLength(1);
    expect(all.note).toContain("no subscription window is shown in dollars");
    const none = await (await app.request("/usage/cost?seat=other@r")).json() as { seats: unknown[] };
    expect(none.seats).toEqual([]);
  });
});

describe("the poll tick carries the estimate into the series", () => {
  it("a Claude sidecar's cost lands on the context row with its native session", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rig = new RigRepository(db).createRig("t-rig");
    const node = new RigRepository(db).addNode(rig.id, "dev.qa", { runtime: "claude-code" });
    const session = new SessionRegistry(db).registerSession(node.id, "dev-qa@t-rig");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    const dir = scratch();
    mkdirSync(join(dir, "state", "context-usage"), { recursive: true });
    writeFileSync(join(dir, "state", "context-usage", "dev-qa@t-rig.json"), JSON.stringify({
      session_name: "dev-qa@t-rig", session_id: "claude-sess-7", sampled_at: "2026-10-13T10:00:00.000Z",
      context_window: { context_window_size: 200000, used_percentage: 10, remaining_percentage: 90, total_input_tokens: 1000, total_output_tokens: 100 },
      cost: { total_cost_usd: 0.77 },
    }));
    const monitor = new ContextMonitor(db, new ContextUsageStore(db, { stateDir: dir, codexHomeDir: dir }),
      { ensureContextCollector: vi.fn(), checkReady: vi.fn(async (): Promise<ReadinessResult> => ({ ready: true })) },
      undefined, undefined, new UsageSamplesStore(db), () => []);
    await monitor.pollOnce();
    monitor.stop();
    expect(queryUsageSeries(db, { lane: "context" })[0]).toMatchObject({ nativeSessionId: "claude-sess-7", clientCostEstimateUsd: 0.77 });
    db.close();
  });
});
