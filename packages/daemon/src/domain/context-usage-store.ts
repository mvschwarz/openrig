import Database from "better-sqlite3";
import { join } from "node:path";
import os from "node:os";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import type { ContextUsage, ContextUnknownReason } from "./types.js";

/** Freshness threshold: samples older than this are considered stale for compact displays. */
export const FRESHNESS_THRESHOLD_MS = 600_000; // 10 minutes per PM spec

export interface ContextUsageStoreOpts {
  stateDir: string;
  codexHomeDir?: string | null;
}

interface SidecarRaw {
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: unknown;
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

interface CodexThreadRow {
  id: string;
  rollout_path: string;
}

interface CodexTokenUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface CodexTokenCountEvent {
  timestamp?: string;
  payload?: {
    type?: string;
    info?: {
      last_token_usage?: CodexTokenUsageRaw;
      model_context_window?: number;
    };
  };
}

export class ContextUsageStore {
  readonly db: Database.Database;
  private stateDir: string;
  private codexHomeDir: string | null;

  constructor(db: Database.Database, opts: ContextUsageStoreOpts) {
    this.db = db;
    this.stateDir = opts.stateDir;
    this.codexHomeDir = opts.codexHomeDir ?? safeHomeDir();
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

  /** Read the latest Codex token_count event for a thread and normalize it. */
  readCodexAndNormalize(input: { threadId: string | null | undefined; sessionName: string }): ContextUsage {
    const threadId = input.threadId?.trim();
    if (!threadId) return this.unknownUsage("no_data");

    const thread = this.readCodexThread(threadId);
    if (!thread?.rollout_path) return this.unknownUsage("no_data");

    const tokenEvent = this.readLatestCodexTokenCount(thread.rollout_path);
    if (!tokenEvent) return this.unknownUsage("no_data");

    return this.normalizeCodexTokenCount({
      event: tokenEvent,
      sessionName: input.sessionName,
      threadId,
      transcriptPath: thread.rollout_path,
    });
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
      currentUsage: this.normalizeCurrentUsage(cw.current_usage),
      transcriptPath: raw.transcript_path ?? null,
      sessionId: raw.session_id ?? null,
      sessionName: raw.session_name ?? null,
      sampledAt,
      fresh,
    };
  }

  /** Normalize a Codex token_count JSONL event into ContextUsage. */
  private normalizeCodexTokenCount(input: {
    event: CodexTokenCountEvent;
    sessionName: string;
    threadId: string;
    transcriptPath: string;
  }): ContextUsage {
    const info = input.event.payload?.info;
    const usage = info?.last_token_usage;
    const contextWindowSize = info?.model_context_window;

    if (!usage || typeof contextWindowSize !== "number" || contextWindowSize <= 0) {
      return this.unknownUsage("parse_error");
    }

    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    const totalTokens = typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : (inputTokens ?? 0) + (outputTokens ?? 0);
    const usedPercentage = clampPercentage(Math.round((totalTokens / contextWindowSize) * 100));
    const remainingPercentage = clampPercentage(100 - usedPercentage);
    const sampledAt = input.event.timestamp ?? null;

    return {
      availability: "known",
      reason: null,
      source: "codex_token_count_jsonl",
      usedPercentage,
      remainingPercentage,
      contextWindowSize,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      currentUsage: this.normalizeCurrentUsage({
        last_token_usage: usage,
        model_context_window: contextWindowSize,
      }),
      transcriptPath: input.transcriptPath,
      sessionId: input.threadId,
      sessionName: input.sessionName,
      sampledAt,
      fresh: sampledAt ? this.isFresh(sampledAt) : false,
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

  private normalizeCurrentUsage(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private readCodexThread(threadId: string): CodexThreadRow | null {
    for (const dbPath of this.resolveCodexStateDbPaths()) {
      try {
        const codexDb = new Database(dbPath, { readonly: true });
        try {
          const row = codexDb.prepare(
            "SELECT id, rollout_path FROM threads WHERE id = ? LIMIT 1",
          ).get(threadId) as CodexThreadRow | undefined;
          if (row?.rollout_path) return row;
        } finally {
          codexDb.close();
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private resolveCodexStateDbPaths(): string[] {
    if (!this.codexHomeDir) return [];

    const codexDir = join(this.codexHomeDir, ".codex");
    const discovered: Array<{ version: number; path: string }> = [];

    try {
      for (const entry of readdirSync(codexDir)) {
        const match = entry.match(/^state_(\d+)\.sqlite$/);
        if (!match) continue;
        discovered.push({
          version: Number(match[1]),
          path: join(codexDir, entry),
        });
      }
    } catch {
      // Best-effort only; fall back to the current common filename below.
    }

    if (discovered.length === 0) {
      discovered.push({ version: 5, path: join(codexDir, "state_5.sqlite") });
    }

    return discovered
      .sort((a, b) => b.version - a.version)
      .map((entry) => entry.path)
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .filter((path) => existsSync(path));
  }

  private readLatestCodexTokenCount(rolloutPath: string): CodexTokenCountEvent | null {
    let content: string;
    try {
      content = this.readTail(rolloutPath, 4_000_000);
    } catch {
      return null;
    }

    const lines = content.trimEnd().split("\n").reverse();
    for (const line of lines) {
      if (!line.includes("\"token_count\"")) continue;
      try {
        const parsed = JSON.parse(line) as CodexTokenCountEvent;
        if (parsed.payload?.type === "token_count") return parsed;
      } catch {
        continue;
      }
    }

    return null;
  }

  private readTail(filePath: string, maxBytes: number): string {
    const stat = statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      return buffer.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  }
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function safeHomeDir(): string | null {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}
