// Slice 01: the durable half of the Codex usage rows. Each reading of a resolved allowance (keyed by
// codexUsageIdentityKey) is stored with only selected, normalized fields, so a restart or a login switch keeps the
// account's last reading, its reset and its last observed exhaustion. Nothing here reads a provider, an auth file or a
// profile, and nothing is matched by percentages or reset times: the key is the only join.
import type Database from "better-sqlite3";
import type { UsageAllowanceIdentity } from "./provider-types.js";
import type { UsageReading, UsageReadWindow } from "./usage-windows.js";

/** Exhaustion episodes kept per allowance key. */
export const EXHAUSTION_EPISODES_KEPT = 20;

/** One exhaustion episode: a window observed exhausted under one reset (or, with no exhausted window, the provider's
 *  limit evidence), however many refreshes saw it. `lastObservedAt` is its most recent observation. */
export interface ExhaustionEpisode {
  window: string | null;
  resetsAt: string | null;
  evidence: string;
  lastObservedAt: string;
}

interface Row {
  id: number;
  identity_key: string;
  account_id: string | null;
  workspace_id: string | null;
  limit_id: string;
  email: string | null;
  plan_type: string | null;
  identity_source: string;
  observed_at: string;
  limit_evidence: string | null;
  windows_json: string;
}

/** The fields kept for one window: selected one by one, so nothing else on the object is ever stored. */
function selectWindow(w: UsageReadWindow): UsageReadWindow {
  return {
    window: String(w.window),
    durationMins: typeof w.durationMins === "number" ? w.durationMins : null,
    usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : null,
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toReading(row: Row): UsageReading<UsageAllowanceIdentity> {
  return {
    identity: { accountId: row.account_id, workspaceId: row.workspace_id, limitId: row.limit_id, email: row.email, planType: row.plan_type, source: row.identity_source as UsageAllowanceIdentity["source"] },
    windows: (JSON.parse(row.windows_json) as UsageReadWindow[]).map(selectWindow),
    limitEvidence: row.limit_evidence,
    observedAt: row.observed_at,
  };
}

/** The episodes one stored reading shows: each exhausted window under its reset, or the limit evidence alone. */
function episodesOf(row: Row): Array<Omit<ExhaustionEpisode, "lastObservedAt"> & { id: string }> {
  const windows = (JSON.parse(row.windows_json) as UsageReadWindow[]).map(selectWindow);
  const exhausted = windows.filter((w) => w.usedPercent !== null && w.usedPercent >= 100);
  if (exhausted.length > 0) {
    return exhausted.map((w) => ({ id: `${w.window}|${w.resetsAt ?? ""}`, window: w.window, resetsAt: w.resetsAt, evidence: row.limit_evidence ?? "at the limit" }));
  }
  if (row.limit_evidence !== null) {
    const reset = windows.map((w) => w.resetsAt).filter((r): r is string => r !== null).sort()[0] ?? null;
    return [{ id: `limit|${row.limit_evidence}|${reset ?? ""}`, window: null, resetsAt: reset, evidence: row.limit_evidence }];
  }
  return [];
}

export class ProviderAccountReadingsStore {
  constructor(private readonly db: Database.Database) {}

  /** Store one reading of `key`. Only the identity labels, the windows' four fields, the limit evidence and the
   *  observation time are written. The same observation (time and values) isn't written twice; a newer observation
   *  with equal values is. Then the key's rows are pruned (other keys are untouched). */
  record(key: string, reading: UsageReading<UsageAllowanceIdentity>): void {
    const id = reading.identity;
    const windowsJson = JSON.stringify(reading.windows.map(selectWindow));
    const limitEvidence = str(reading.limitEvidence);
    const last = this.db.prepare("SELECT observed_at, windows_json, limit_evidence FROM provider_account_readings WHERE identity_key = ? ORDER BY observed_at DESC, id DESC LIMIT 1")
      .get(key) as Pick<Row, "observed_at" | "windows_json" | "limit_evidence"> | undefined;
    if (last && last.observed_at === reading.observedAt && last.windows_json === windowsJson && last.limit_evidence === limitEvidence) return;
    this.db.prepare(`INSERT INTO provider_account_readings
        (provider, identity_key, account_id, workspace_id, limit_id, email, plan_type, identity_source, observed_at, limit_evidence, windows_json)
        VALUES ('codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, str(id.accountId), str(id.workspaceId), String(id.limitId), str(id.email), str(id.planType), String(id.source), reading.observedAt, limitEvidence, windowsJson);
    this.prune(key);
  }

  /** Keep the key's latest reading, its latest reading per window, and the latest reading of each of its newest
   *  EXHAUSTION_EPISODES_KEPT episodes; delete its other rows. */
  private prune(key: string): void {
    const rows = this.rows(key);
    if (rows.length === 0) return;
    const keep = new Set<number>([rows[0]!.id]);
    const seenWindow = new Set<string>();
    for (const row of rows) {
      for (const w of JSON.parse(row.windows_json) as UsageReadWindow[]) {
        if (!seenWindow.has(w.window)) { seenWindow.add(w.window); keep.add(row.id); }
      }
    }
    const seenEpisode = new Set<string>();
    for (const row of rows) {
      for (const e of episodesOf(row)) {
        if (seenEpisode.has(e.id)) continue;
        if (seenEpisode.size >= EXHAUSTION_EPISODES_KEPT) break;
        seenEpisode.add(e.id); keep.add(row.id);
      }
    }
    const drop = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (drop.length > 0) this.db.prepare(`DELETE FROM provider_account_readings WHERE id IN (${drop.map(() => "?").join(",")})`).run(...drop);
  }

  /** The key's rows, newest observation first. */
  private rows(key: string): Row[] {
    return this.db.prepare("SELECT * FROM provider_account_readings WHERE identity_key = ? ORDER BY observed_at DESC, id DESC").all(key) as Row[];
  }

  /** The key's latest stored reading, or null. */
  latest(key: string): UsageReading<UsageAllowanceIdentity> | null {
    const row = this.rows(key)[0];
    return row ? toReading(row) : null;
  }

  /** Every stored key's latest reading, as the projection held it. */
  latestAll(): Array<{ key: string; reading: UsageReading<UsageAllowanceIdentity> }> {
    const rows = this.db.prepare(`SELECT * FROM provider_account_readings r WHERE id = (
        SELECT id FROM provider_account_readings WHERE identity_key = r.identity_key ORDER BY observed_at DESC, id DESC LIMIT 1)
      ORDER BY identity_key`).all() as Row[];
    return rows.map((row) => ({ key: row.identity_key, reading: toReading(row) }));
  }

  /** The key's exhaustion episodes, newest first, each with its most recent observation. */
  exhaustionEpisodes(key: string): ExhaustionEpisode[] {
    const out = new Map<string, ExhaustionEpisode>();
    for (const row of this.rows(key)) {
      for (const e of episodesOf(row)) {
        if (!out.has(e.id)) out.set(e.id, { window: e.window, resetsAt: e.resetsAt, evidence: e.evidence, lastObservedAt: row.observed_at });
      }
    }
    return [...out.values()];
  }

  /** The key's most recent observed exhaustion, or null. */
  lastExhaustion(key: string): { at: string; window: string | null; evidence: string } | null {
    const newest = this.exhaustionEpisodes(key)[0];
    return newest ? { at: newest.lastObservedAt, window: newest.window, evidence: newest.evidence } : null;
  }
}
