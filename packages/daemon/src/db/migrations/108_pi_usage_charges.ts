import type { Migration } from "../migrate.js";

/**
 * OPR.0.7.0.2 (cost reporting, K4): OpenRouter's actual charge for a Pi request, kept beside (never inside) Pi's
 * model-priced estimate.
 * - pi_usage_entries gains the assistant turn's Pi API and the provider response id Pi recorded, which tie the
 *   entry to OpenRouter's own record of the request.
 * - pi_usage_charges: one row per (Pi session, entry). "charged" is final (data.total_cost in USD, with the
 *   generation's account context); "unavailable" says why, and can still become "charged". A replay, restart
 *   or repeated lookup never adds a second charge.
 */
export const piUsageChargesSchema: Migration = {
  name: "108_pi_usage_charges.sql",
  sql: `
    ALTER TABLE pi_usage_entries ADD COLUMN api TEXT;
    ALTER TABLE pi_usage_entries ADD COLUMN response_id TEXT;
    CREATE TABLE IF NOT EXISTS pi_usage_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pi_session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('charged', 'unavailable')),
      total_cost_usd REAL,
      upstream_inference_cost_usd REAL,
      cache_discount_usd REAL,
      is_byok INTEGER,
      provider_name TEXT,
      model TEXT,
      api_type TEXT,
      workspace_id TEXT,
      generation_created_at TEXT,
      credential_source TEXT NOT NULL,
      reason TEXT,
      seat_session TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE (pi_session_id, entry_id),
      CHECK (status <> 'charged' OR total_cost_usd IS NOT NULL)
    );
  `,
};
