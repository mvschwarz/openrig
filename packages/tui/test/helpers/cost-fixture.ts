// Slice 02 — System → Cost test fixture: a real daemon store seeded with every cost shape the cost route serves
// (Claude with a reset, tiny, stale and no-cost estimates; Codex tokens; a source with no cost; a Pi fork session with
// own, inherited and unknown-origin entries and OpenRouter charges beside them), and the daemon's own cost route
// over it. Shared by the presenter tests and the journey through the TUI.
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../../../daemon/src/db/connection.js";
import { migrate } from "../../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../../daemon/src/db/all-migrations.js";
import { UsageSamplesStore } from "../../../daemon/src/domain/usage-samples-store.js";
import { PiUsageEntriesStore } from "../../../daemon/src/domain/pi-usage-entries-store.js";
import { telemetryRoutes } from "../../../daemon/src/routes/telemetry.js";

export const NOW = "2026-10-14T05:00:00.000Z";
export const at = (min: number) => new Date(Date.parse("2026-10-14T04:00:00.000Z") + min * 60_000).toISOString();

export function seed(d: Database.Database) {
  const samples = new UsageSamplesStore(d);
  const ctx = (seat: string, source: string, minute: number, session: string | null, cost: number | null, input = 1000, output = 50) =>
    samples.appendContextSample({ nodeId: "n", seatSession: seat, source, sampledAt: at(minute), totalInputTokens: input,
      totalOutputTokens: output, usedPercentage: 5, nativeSessionId: session, clientCostEstimateUsd: cost }, at(minute));
  // Claude: a reset inside one session, then a fresh estimate; a stale one; one with no cost reported.
  ctx("dev-claude@r", "claude_statusline_json", 50, "s1", 2.0);
  ctx("dev-claude@r", "claude_statusline_json", 52, "s1", 0.3);
  ctx("dev-claude@r", "claude_statusline_json", 58, "s1", 0.45, 2000, 80);
  ctx("tiny-claude@r", "claude_statusline_json", 58, "s2", 0.0041);
  ctx("old-claude@r", "claude_statusline_json", 0, "s9", 1.5);
  ctx("quiet-claude@r", "claude_statusline_json", 59, "s5", null);
  // Codex: tokens, no cost method. And a source with no cost.
  ctx("dev-codex@r", "codex_token_count_jsonl", 59, "t1", null, 4000, 300);
  ctx("misc@r", "other_source", 59, null, null);
  // Pi: a fork session with own, inherited and unknown-origin entries, and OpenRouter charges beside them.
  const pi = new PiUsageEntriesStore(d);
  const fact = (id: string, minute: number, cost: number | null, origin: "own" | "inherited" | "unknown", extra: Record<string, unknown> = {}) => ({
    entryId: id, parentEntryId: null, entryTimestamp: at(minute), kind: "assistant" as const, usageCategory: null, provider: "openrouter",
    model: "z-ai/glm-5.2", input: 100, output: 20, cacheRead: 5, cacheWrite: 1, costTotal: cost, stopReason: "stop", origin,
    api: "openai-completions", responseId: `gen-${id}`, ...extra });
  pi.record({ seatSession: "dev-pi@r", nodeId: null, generation: null, piSessionId: "pi-s1", facts: [
    fact("h1", 1, 0.2, "inherited"), fact("u1", 2, 0.03, "unknown"),
    fact("a1", 10, 0.01, "own"), fact("a2", 11, 0.002, "own"), fact("a3", 12, null, "own"), fact("a4", 13, 0.02, "own", { stopReason: "error" }),
    fact("m1", 14, 0.05, "own", { api: "anthropic-messages", responseId: "msg_1" }),
  ] }, at(20));
  const charge = (entryId: string, status: "charged" | "unavailable", total: number | null, reason: string | null = null) => ({
    entryId, generationId: `gen-${entryId}`, status, totalCostUsd: total, upstreamInferenceCostUsd: null, cacheDiscountUsd: null, isByok: false,
    providerName: "Z.AI", model: "z-ai/glm-5.2", apiType: "completions", workspaceId: status === "charged" ? "ws-1" : null, generationCreatedAt: at(10),
    credentialSource: "OPENROUTER_API_KEY (forwarded by OpenRig; Pi's credential observed before and after the request)", reason });
  pi.recordCharges({ seatSession: "dev-pi@r", piSessionId: "pi-s1", charges: [
    charge("a1", "charged", 0.012), charge("a2", "charged", 0.0004),
    charge("a3", "unavailable", null, "not available after 5 lookups (last: HTTP 404)"),
  ] }, at(21));
}

/** A fresh in-memory store, migrated and seeded. */
export function seededDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  seed(db);
  return db;
}

/** The daemon's real telemetry routes over this store, at a fixed time. */
export function costApp(db: () => Database.Database): Hono {
  const app = new Hono();
  app.route("/api/telemetry", telemetryRoutes({ db, nowIso: () => NOW }));
  return app;
}
