import type { Migration } from "../migrate.js";

/**
 * 51-08 A1 (plan-lock rev-1, PM 2026-08-07) — the append-only per-seat usage
 * series behind token-telemetry-over-time.
 *
 * PM-ruled decisions bound here: DEDICATED time-series table (the events table's
 * last-row read shape is unsuited to range queries; events stays lean); rows are
 * APPEND-ONLY and advance-only (a sample identical to the seat's previous row is
 * never written — an idle seat adds zero rows); retention is daemon-enforced
 * (A2) per the queue_transitions_archive precedent.
 *
 * Two lanes share the table under `lane`:
 *   'context'          — the context-window sample (tokens in/out, used %) the
 *                        30s context-monitor tick already has in hand; the
 *                        historical twin of context_usage's DESTRUCTIVE upsert
 *                        (018), which stays untouched as the point-in-time lane.
 *   'provider_window'  — the per-seat rate-limit windows (five_hour | weekly)
 *                        from the statusline provider-usage sidecars, which had
 *                        ZERO persistence before this table.
 *
 * OPTION-A BAR (provider-types.ts:106, host-usage-rollup.ts:12-16): seat/node
 * identity ONLY — no account identity column exists and none may be added; the
 * statusline exposes no honest account identity and this lane never fabricates
 * one.
 *
 * NUMBER SEQUENCING (desk pin 2026-08-07): 060 = tenure ledger, 061 = P7
 * lifecycle — both in-flight lanes; 062 is this slice's own mint.
 */
export const usageSamplesSchema: Migration = {
  name: "062_usage_samples.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane TEXT NOT NULL CHECK (lane IN ('context', 'provider_window')),
      seat_session TEXT NOT NULL,
      node_id TEXT,
      source TEXT,
      sampled_at TEXT,
      captured_at TEXT NOT NULL,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      used_percentage REAL,
      window TEXT CHECK (window IN ('five_hour', 'weekly') OR window IS NULL),
      window_used_percent REAL,
      resets_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_samples_seat_time
      ON usage_samples(seat_session, lane, captured_at);
    CREATE INDEX IF NOT EXISTS idx_usage_samples_node_time
      ON usage_samples(node_id, captured_at);
  `,
};
