import type Database from "better-sqlite3";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ContextUsage, ContextUnknownReason } from "./types.js";

/** Freshness threshold: samples older than this are considered stale for compact displays. */
export const FRESHNESS_THRESHOLD_MS = 120_000; // 2 minutes

export interface ContextUsageStoreOpts {
  stateDir: string;
}

interface SidecarRaw {
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: string;
  };
  session_id?: string;
  session_name?: string;
  transcript_path?: string;
  sampled_at?: string;
}

interface ContextUsageRow {
  node_id: string;
  session_id: string | null;
  session_name: string | null;
  availability: string;
  reason: string | null;
  source: string | null;
  used_percentage: number | null;
  remaining_percentage: number | null;
  context_window_size: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  current_usage: string | null;
  transcript_path: string | null;
  sampled_at: string | null;
  updated_at: string;
}

export class ContextUsageStore {
  readonly db: Database.Database;
  private stateDir: string;

  constructor(db: Database.Database, opts: ContextUsageStoreOpts) {
    this.db = db;
    this.stateDir = opts.stateDir;
  }

  /** Get the sidecar file path for a session. */
  getSidecarPath(sessionName: string): string {
    // Sanitize session name for filesystem safety
    const safe = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_");
    return join(this.stateDir, "context", `${safe}.json`);
  }

  /** Read and parse a sidecar JSON file. Returns discriminated result. */
  readSidecar(sessionName: string): { ok: true; data: SidecarRaw } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
    const filePath = this.getSidecarPath(sessionName);
    try {
      if (!existsSync(filePath)) return { ok: false, reason: "missing_sidecar" };
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content) as SidecarRaw;
      return { ok: true, data: parsed };
    } catch {
      return { ok: false, reason: "parse_error" };
    }
  }

  /** Read sidecar and normalize into ContextUsage in one step. */
  readAndNormalize(sessionName: string): ContextUsage {
    const result = this.readSidecar(sessionName);
    if (!result.ok) return this.unknownUsage(result.reason);
    return this.normalizeSample(result.data);
  }

  /** Normalize raw sidecar data into a ContextUsage record. */
  normalizeSample(raw: SidecarRaw | null): ContextUsage {
    if (!raw) {
      return this.unknownUsage("missing_sidecar");
    }

    const cw = raw.context_window;
    if (!cw || typeof cw.used_percentage !== "number") {
      return this.unknownUsage("parse_error");
    }

    const sampledAt = raw.sampled_at ?? null;
    const fresh = sampledAt ? this.isFresh(sampledAt) : false;

    return {
      availability: "known",
      reason: null,
      source: "claude_statusline_json",
      usedPercentage: cw.used_percentage ?? null,
      remainingPercentage: cw.remaining_percentage ?? null,
      contextWindowSize: cw.context_window_size ?? null,
      totalInputTokens: cw.total_input_tokens ?? null,
      totalOutputTokens: cw.total_output_tokens ?? null,
      currentUsage: cw.current_usage ?? null,
      transcriptPath: raw.transcript_path ?? null,
      sessionId: raw.session_id ?? null,
      sessionName: raw.session_name ?? null,
      sampledAt,
      fresh,
    };
  }

  /** Persist a context usage record for a node. Upserts. */
  persist(nodeId: string, usage: ContextUsage): void {
    this.db.prepare(`
      INSERT INTO context_usage (
        node_id, session_id, session_name, availability, reason, source,
        used_percentage, remaining_percentage, context_window_size,
        total_input_tokens, total_output_tokens, current_usage,
        transcript_path, sampled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id) DO UPDATE SET
        session_id = excluded.session_id,
        session_name = excluded.session_name,
        availability = excluded.availability,
        reason = excluded.reason,
        source = excluded.source,
        used_percentage = excluded.used_percentage,
        remaining_percentage = excluded.remaining_percentage,
        context_window_size = excluded.context_window_size,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        current_usage = excluded.current_usage,
        transcript_path = excluded.transcript_path,
        sampled_at = excluded.sampled_at,
        updated_at = datetime('now')
    `).run(
      nodeId,
      usage.sessionId,
      usage.sessionName,
      usage.availability,
      usage.reason,
      usage.source,
      usage.usedPercentage,
      usage.remainingPercentage,
      usage.contextWindowSize,
      usage.totalInputTokens,
      usage.totalOutputTokens,
      usage.currentUsage,
      usage.transcriptPath,
      usage.sampledAt,
    );
  }

  /** Get context usage for a single node. Session-aware: mismatched session returns unknown. */
  getForNode(nodeId: string, currentSessionName: string | null): ContextUsage {
    if (!currentSessionName) return this.unknownUsage("not_managed");

    const row = this.db.prepare("SELECT * FROM context_usage WHERE node_id = ?").get(nodeId) as ContextUsageRow | undefined;
    if (!row) return this.unknownUsage("no_data");

    // Session mismatch guard: prevent stale cross-session inheritance
    if (row.session_name && row.session_name !== currentSessionName) {
      return this.unknownUsage("session_mismatch");
    }

    return this.rowToUsage(row);
  }

  /** Batch get context usage for multiple nodes. Session-aware per entry. */
  getForNodes(entries: Array<{ nodeId: string; currentSessionName: string | null }>): Map<string, ContextUsage> {
    const result = new Map<string, ContextUsage>();
    if (entries.length === 0) return result;

    const nodeIds = entries.map((e) => e.nodeId);
    const sessionMap = new Map(entries.map((e) => [e.nodeId, e.currentSessionName]));

    const rows = this.db.prepare(
      `SELECT * FROM context_usage WHERE node_id IN (${nodeIds.map(() => "?").join(",")})`
    ).all(...nodeIds) as ContextUsageRow[];

    const rowMap = new Map(rows.map((r) => [r.node_id, r]));

    for (const entry of entries) {
      if (!entry.currentSessionName) {
        result.set(entry.nodeId, this.unknownUsage("not_managed"));
        continue;
      }

      const row = rowMap.get(entry.nodeId);
      if (!row) {
        result.set(entry.nodeId, this.unknownUsage("no_data"));
        continue;
      }

      if (row.session_name && row.session_name !== entry.currentSessionName) {
        result.set(entry.nodeId, this.unknownUsage("session_mismatch"));
        continue;
      }

      result.set(entry.nodeId, this.rowToUsage(row));
    }

    return result;
  }

  /** Create an unknown ContextUsage with an honest reason. */
  unknownUsage(reason: ContextUnknownReason): ContextUsage {
    return {
      availability: "unknown",
      reason,
      source: null,
      usedPercentage: null,
      remainingPercentage: null,
      contextWindowSize: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      currentUsage: null,
      transcriptPath: null,
      sessionId: null,
      sessionName: null,
      sampledAt: null,
      fresh: false,
    };
  }

  /** Check if a sample timestamp is fresh. */
  private isFresh(sampledAt: string): boolean {
    try {
      const age = Date.now() - new Date(sampledAt).getTime();
      return age < FRESHNESS_THRESHOLD_MS;
    } catch {
      return false;
    }
  }

  /** Convert a DB row to a ContextUsage, applying freshness. */
  private rowToUsage(row: ContextUsageRow): ContextUsage {
    const fresh = row.sampled_at ? this.isFresh(row.sampled_at) : false;
    return {
      availability: row.availability as ContextUsage["availability"],
      reason: row.reason as ContextUsage["reason"],
      source: row.source as ContextUsage["source"],
      usedPercentage: row.used_percentage,
      remainingPercentage: row.remaining_percentage,
      contextWindowSize: row.context_window_size,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      currentUsage: row.current_usage,
      transcriptPath: row.transcript_path,
      sessionId: row.session_id,
      sessionName: row.session_name,
      sampledAt: row.sampled_at,
      fresh,
    };
  }
}
