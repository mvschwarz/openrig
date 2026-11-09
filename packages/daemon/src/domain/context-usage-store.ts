import { physicalSessionName } from "./session-registry.js";
import Database from "better-sqlite3";
import { join } from "node:path";
import os from "node:os";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { resolveCodexDbPaths } from "./codex-thread-id.js";
import { declaredRuntimeHomes } from "./seat-runtime-home.js";
import type { ContextUsage, ContextUnknownReason } from "./types.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import {
  contextUsageDirectory,
  legacyContextUsageDirectory,
  telemetrySidecarPath,
} from "./telemetry-state-paths.js";

/** Freshness threshold: samples older than this are considered stale for compact displays. */
export const FRESHNESS_THRESHOLD_MS = 600_000; // 10 minutes per PM spec

export interface ContextUsageStoreOpts {
  stateDir: string;
  codexHomeDir?: string | null;
  /** Explicit CODEX_HOME. codexHomeDir above is the legacy OS-home input. */
  codexHome?: string;
  // GHOST-STAGE (c-id): resolve the LIVE occupant's boot time (atom-B tenure) for a node, so a
  // reading sampled BEFORE the current occupant booted (a prior generation) is rejected instead of
  // driving the threshold. null = UNKNOWN → the gate is inert (note-2).
  resolveOccupantBootAt?: (nodeId: string) => string | null;
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
  source?: string;
  model?: string | { id?: string; display_name?: string; source?: string };
  /** Managed seat generation inherited by the status-line collector. Lets consumers distinguish
   *  a canonical occupant from a retained predecessor whose launch-time --name aliases the seat. */
  occupant_generation?: string;
  transcript_path?: string;
  /** Claude's statusline `cost.total_cost_usd`: a cumulative client-side estimate for the native session. */
  cost?: { total_cost_usd?: number | null } | null;
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
    rate_limits?: unknown;
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
  private codexHome?: string;
  private stmtSessionNodeId?: Database.Statement;
  private stmtCurrentTenureGen?: Database.Statement;
  private stmtContinuedByAdoption?: Database.Statement;

  private readonly resolveOccupantBootAt?: (nodeId: string) => string | null;
  constructor(db: Database.Database, opts: ContextUsageStoreOpts) {
    this.db = db;
    this.stateDir = opts.stateDir;
    this.codexHomeDir = opts.codexHomeDir ?? safeHomeDir();
    this.codexHome = opts.codexHome;
    this.resolveOccupantBootAt = opts.resolveOccupantBootAt;
  }

  /**
   * GHOST-STAGE (c-id): is this reading from a generation PRIOR to the node's live occupant?
   * A reading sampled strictly before the current occupant booted belongs to a retired tenure
   * (the frozen-88% specimen in the mixed-gen window after handover, where the name is reused so
   * session_mismatch cannot catch it). Returns false when boot time is UNKNOWN or the reading has
   * no sampled_at — the gate is inert (note-2: never treat unknown as stale), leaving
   * session_mismatch + freshness as the remaining guards. boot_at is SQLite datetime('now') (UTC,
   * no zone marker), so it is parsed as UTC; a bare Date.parse would read it as local time.
   */
  private isPriorGenerationReading(nodeId: string, sampledAt: string | null): boolean {
    if (!sampledAt) return false;
    const bootAt = this.resolveOccupantBootAt?.(nodeId) ?? null;
    if (!bootAt) return false;
    const sampled = Date.parse(sampledAt);
    const boot = parseSqliteUtcMs(bootAt);
    if (Number.isNaN(sampled) || Number.isNaN(boot)) return false;
    return sampled < boot;
  }

  /** Get the sidecar file path for a session. */
  getSidecarPath(sessionName: string): string {
    return telemetrySidecarPath(contextUsageDirectory(this.stateDir), sessionName);
  }

  /**
   * GHOST-STAGE (e) Class-A 2a: remove a retiring occupant's name-keyed context sidecar so a
   * same-name successor does not read the predecessor's frozen telemetry sample (the "gen-1 88%
   * resurfaced as a live threshold flag" specimen). Safe by TIMING — the cutover seam
   * (OccupantInvalidator) calls this inside SeatHandoverService.commit(), BEFORE the successor
   * writes its own sidecar. Missing file = no-op; best-effort (a leftover is caught downstream by
   * the freshness gate). NOTE: this is the DISK sidecar (name-keyed); the context_usage DB table is
   * node_id-keyed + already session_mismatch-gated, so it needs no invalidation here.
   */
  invalidateOccupantSidecar(sessionName: string): void {
    const filePath = this.getSidecarPath(sessionName);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      /* best-effort — a stale leftover is still gated by isFresh downstream */
    }
  }

  /** Read and parse a sidecar JSON file. Returns discriminated result. */
  readSidecar(sessionName: string): { ok: true; data: SidecarRaw } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
    const canonical = this.readSidecarAt(this.getSidecarPath(sessionName));
    if (canonical.ok || canonical.reason !== "missing_sidecar") return canonical;
    return this.readSidecarAt(
      telemetrySidecarPath(legacyContextUsageDirectory(this.stateDir), sessionName),
    );
  }

  private readSidecarAt(filePath: string): { ok: true; data: SidecarRaw } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
    try {
      if (!existsSync(filePath)) return { ok: false, reason: "missing_sidecar" };
      const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > 65536) {
          return { ok: false, reason: "parse_error" };
        }
        const content = readFileSync(fd, "utf-8");
        const parsed = JSON.parse(content) as SidecarRaw;
        return { ok: true, data: parsed };
      } finally {
        closeSync(fd);
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
        return { ok: false, reason: "missing_sidecar" };
      }
      return { ok: false, reason: "parse_error" };
    }
  }

  /** Read sidecar and normalize into ContextUsage in one step. */
  readAndNormalize(sessionName: string): ContextUsage {
    const result = this.readSidecar(sessionName);
    if (!result.ok) return this.unknownUsage(result.reason);
    return this.normalizeSample(result.data, sessionName);
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

  /** Resolve an explicitly selected native thread, even before its first token count. */
  readCodexTranscriptPath(threadId: string): string | null {
    return this.readCodexThread(threadId)?.rollout_path ?? null;
  }

  private isMismatchedOccupantGeneration(sessionName: string, reportedGeneration: string): boolean {
    if (!sessionName || !reportedGeneration) return false;
    try {
      const physical = physicalSessionName(this.db, sessionName);
      if (!this.stmtSessionNodeId) {
        this.stmtSessionNodeId = this.db.prepare(
          "SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1",
        );
      }
      const sessionRow = this.stmtSessionNodeId.get(physical) as { node_id: string } | undefined;
      if (!sessionRow?.node_id) return false;

      const nodeId = sessionRow.node_id;
      if (!this.stmtCurrentTenureGen) {
        this.stmtCurrentTenureGen = this.db.prepare(
          "SELECT generation_uuid FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1",
        );
      }
      const tenureRow = this.stmtCurrentTenureGen.get(nodeId) as { generation_uuid: string | null } | undefined;
      if (!tenureRow?.generation_uuid) {
        // No tenure row: keep unmanaged / legacy seats inert (false = not mismatched)
        return false;
      }
      if (tenureRow.generation_uuid === reportedGeneration) {
        return false;
      }

      // Generation is not the latest ordinal. Check if it was continued by adoption:
      if (!this.stmtContinuedByAdoption) {
        this.stmtContinuedByAdoption = this.db.prepare(
          `SELECT 1 FROM occupant_tenures e WHERE e.node_id = ? AND e.generation_uuid = ? AND NOT EXISTS (
             SELECT 1 FROM occupant_tenures l WHERE l.node_id = e.node_id AND l.generation_ordinal > e.generation_ordinal
               AND l.kind <> 'adopt'
           ) LIMIT 1`,
        );
      }
      const continued = this.stmtContinuedByAdoption.get(nodeId, reportedGeneration);
      if (continued) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /** Normalize raw sidecar data into a ContextUsage record. */
  normalizeSample(raw: SidecarRaw | null, sessionName?: string): ContextUsage;
  normalizeSample(sessionName: string, raw: SidecarRaw | null): ContextUsage;
  normalizeSample(arg1: string | SidecarRaw | null, arg2?: string | SidecarRaw | null): ContextUsage {
    let sessionName = "";
    let raw: SidecarRaw | null = null;
    if (typeof arg1 === "string") {
      sessionName = arg1;
      raw = (arg2 as SidecarRaw | null) ?? null;
    } else {
      raw = arg1 ?? null;
      if (typeof arg2 === "string") sessionName = arg2;
    }

    if (!raw) {
      return this.unknownUsage("missing_sidecar");
    }

    const sessionId = typeof raw.session_id === "string" ? raw.session_id : null;
    const sessionNameResolved = typeof raw.session_name === "string" ? raw.session_name : null;
    const rawSource = typeof raw.source === "string" ? raw.source.trim() : "";
    const resolvedSource: "claude_statusline_json" | "codex_token_count_jsonl" | "runner_sidecar" =
      rawSource === "runner_sidecar" || rawSource === "runner-sidecar"
        ? "runner_sidecar"
        : rawSource === "codex_token_count_jsonl"
          ? "codex_token_count_jsonl"
          : "claude_statusline_json";

    if (sessionName && typeof raw.occupant_generation === "string" && raw.occupant_generation.trim().length > 0) {
      if (this.isMismatchedOccupantGeneration(sessionName, raw.occupant_generation.trim())) {
        return this.unknownUsage("stale_generation", { sessionId, sessionName: sessionNameResolved });
      }
    }

    const cw = raw.context_window;
    if (!cw) {
      return {
        ...this.unknownUsage("parse_error"),
        sessionId,
        sessionName: sessionId !== null ? sessionNameResolved : null,
      };
    }

    if (typeof cw.used_percentage !== "number") {
      const hasTokenMetrics = typeof cw.total_input_tokens === "number" || typeof cw.total_output_tokens === "number" || cw.current_usage !== undefined;
      if (hasTokenMetrics) {
        const sampledAt = typeof raw.sampled_at === "string" ? raw.sampled_at : null;
        const fresh = sampledAt ? this.isFresh(sampledAt) : false;
        return {
          availability: "unknown",
          reason: "window_capacity_unknown",
          source: resolvedSource,
          sessionId,
          sessionName: sessionNameResolved,
          usedPercentage: null,
          remainingPercentage: null,
          contextWindowSize: cw.context_window_size ?? null,
          totalInputTokens: cw.total_input_tokens ?? null,
          totalOutputTokens: cw.total_output_tokens ?? null,
          currentUsage: this.normalizeCurrentUsage(cw.current_usage),
          transcriptPath: raw.transcript_path ?? null,
          sampledAt,
          fresh,
          clientCostEstimateUsd: typeof raw.cost?.total_cost_usd === "number" && Number.isFinite(raw.cost.total_cost_usd) ? raw.cost.total_cost_usd : null,
        };
      }
      return {
        ...this.unknownUsage("parse_error"),
        sessionId,
        sessionName: sessionId !== null ? sessionNameResolved : null,
      };
    }

    const sampledAt = typeof raw.sampled_at === "string" ? raw.sampled_at : null;
    const fresh = sampledAt ? this.isFresh(sampledAt) : false;

    return {
      availability: "known",
      reason: null,
      source: resolvedSource,
      usedPercentage: cw.used_percentage ?? null,
      remainingPercentage: cw.remaining_percentage ?? null,
      contextWindowSize: cw.context_window_size ?? null,
      totalInputTokens: cw.total_input_tokens ?? null,
      totalOutputTokens: cw.total_output_tokens ?? null,
      currentUsage: this.normalizeCurrentUsage(cw.current_usage),
      transcriptPath: raw.transcript_path ?? null,
      sessionId,
      sessionName: sessionNameResolved,
      sampledAt,
      fresh,
      clientCostEstimateUsd: typeof raw.cost?.total_cost_usd === "number" && Number.isFinite(raw.cost.total_cost_usd) ? raw.cost.total_cost_usd : null,
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
    currentSessionName = physicalSessionName(this.db, currentSessionName);

    const row = this.db.prepare("SELECT * FROM context_usage WHERE node_id = ?").get(nodeId) as ContextUsageRow | undefined;
    if (!row) return this.unknownUsage("no_data");

    // Session mismatch guard: prevent stale cross-session inheritance
    if (row.session_name && row.session_name !== currentSessionName) {
      return this.unknownUsage("session_mismatch");
    }

    // GHOST-STAGE (c-id): generation guard. Under handover the name is REUSED, so session_mismatch
    // passes while the table still holds the retiree's pre-boot reading (the mixed-gen window).
    // Reject readings from before the live occupant booted → insufficient-data, evaluate current-gen only.
    if (this.isPriorGenerationReading(nodeId, row.sampled_at)) {
      return this.unknownUsage("stale_generation");
    }

    return this.rowToUsage(row);
  }

  /** Batch get context usage for multiple nodes. Session-aware per entry. */
  getForNodes(entries: Array<{ nodeId: string; currentSessionName: string | null }>): Map<string, ContextUsage> {
    const result = new Map<string, ContextUsage>();
    if (entries.length === 0) return result;

    entries = entries.map(entry => ({ ...entry, currentSessionName: entry.currentSessionName ? physicalSessionName(this.db, entry.currentSessionName) : null }));
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

      // GHOST-STAGE (c-id): generation guard — see getForNode. Reject pre-boot (prior-gen) readings.
      if (this.isPriorGenerationReading(entry.nodeId, row.sampled_at)) {
        result.set(entry.nodeId, this.unknownUsage("stale_generation"));
        continue;
      }

      result.set(entry.nodeId, this.rowToUsage(row));
    }

    return result;
  }

  /** Create an unknown ContextUsage with an honest reason. */
  unknownUsage(
    reason: ContextUnknownReason,
    meta?: { sessionId?: string | null; sessionName?: string | null },
  ): ContextUsage {
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
      sessionId: meta?.sessionId ?? null,
      sessionName: meta?.sessionName ?? null,
      sampledAt: null,
      fresh: false,
    };
  }

  /** Check if a sample timestamp is fresh. */
  private isFresh(sampledAt: string): boolean {
    try {
      const age = Date.now() - new Date(sampledAt).getTime();
      return age >= 0 && age < FRESHNESS_THRESHOLD_MS;
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
    const daemon = this.codexHome || this.codexHomeDir ? resolveCodexDbPaths(this.codexHomeDir ?? "", "state", undefined, this.codexHome) : [];
    // A seat with its own CODEX_HOME keeps its threads there. A thread id is unique across homes, so each declared home is
    // searched after the daemon's.
    const seats = declaredRuntimeHomes(this.db, "codex").flatMap(home => resolveCodexDbPaths("", "state", undefined, home));
    return [...new Set([...daemon, ...seats])];
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
        if (parsed.payload?.type === "token_count") {
          // Native Codex also writes quota-only updates under token_count.
          // They carry no context measurement and must not replace its timestamp.
          if (parsed.payload.info == null && parsed.payload.rate_limits != null) continue;
          return parsed;
        }
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
