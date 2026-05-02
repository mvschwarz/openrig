// types.ts — shared TypeScript types for the restore-packet generator.
//
// Both runtime adapters (codex-jsonl-parser, claude-transcript-parser)
// emit the same StructuredTranscript shape. Downstream modules
// (redaction, omitted-records, packet-writer) consume this shape
// without caring about the source runtime.

/** A single user-visible message extracted from a transcript. */
export interface ExtractedMessage {
  /** ISO-8601 timestamp if the source provides one; else null. */
  timestamp: string | null;
  /** Speaker role. Restricted to user-visible roles (developer/user/assistant). */
  role: "developer" | "user" | "assistant";
  /** Redacted message text. */
  text: string;
  /** First non-empty line of the text, truncated to ~180 chars. Used in summaries. */
  preview: string;
}

/** Canonical record-class enum per M1 contract § 5. */
export type OmittedRecordClass =
  | "reasoning_records"
  | "raw_tool_outputs"
  | "function_call_output"
  | "redacted_secrets";

/**
 * A path frequency entry from path extraction. Sorted by count
 * descending then path ascending; used to populate `touched_files.top_paths`.
 */
export interface PathCount {
  path: string;
  count: number;
}

/**
 * Per-runtime per-record-type counter. Flexible string keys because
 * Codex JSONL uses `record.type` strings and Claude transcript uses
 * `record.type` strings; both are runtime-defined.
 */
export type TypeCounts = Record<string, number>;

/**
 * Per-omitted-class counter. Records how many records were filtered
 * for each of the 4 contract enums during parsing/redaction.
 */
export type OmittedCounts = Record<OmittedRecordClass, number>;

/**
 * Optional session metadata extracted from the source. Codex emits a
 * `session_meta` record at the top of a JSONL; Claude transcripts
 * carry per-record `cwd` etc.
 */
export interface SessionMeta {
  cwd: string | null;
  sessionId: string | null;
  /** Free-form additional fields the runtime emitted; not load-bearing. */
  raw?: Record<string, unknown>;
}

/**
 * Structured representation produced by both parsers. The packet-writer
 * (M2c) consumes this to assemble a v0 restore packet.
 */
export interface StructuredTranscript {
  /** Top-level session metadata (cwd, sessionId). */
  sessionMeta: SessionMeta | null;
  /** Total source lines processed (raw JSONL line count, including malformed/skipped). */
  lineCount: number;
  /** Number of user-visible messages extracted into `messages`. */
  messageCount: number;
  /**
   * Number of "compaction" records seen. Codex emits these explicitly
   * (`type: "compacted"`); Claude doesn't. The field is parser-specific
   * but always present (zero when not applicable).
   */
  compactedCount: number;
  /** Per-record-type frequency map; used in human reports / debug. */
  typeCounts: TypeCounts;
  /** Per-omitted-class counter; populated as the parser filters records. */
  omittedCounts: OmittedCounts;
  /** Extracted messages in chronological order; redaction has been applied. */
  messages: ExtractedMessage[];
  /**
   * Path frequency inventory; sorted by count desc then path asc.
   * Capped at 200 entries.
   */
  paths: PathCount[];
}

/** Source-runtime kind. v0 supports codex + claude-code transcript shapes. */
export type SourceRuntime = "codex" | "claude-code";

export function emptyOmittedCounts(): OmittedCounts {
  return {
    reasoning_records: 0,
    raw_tool_outputs: 0,
    function_call_output: 0,
    redacted_secrets: 0,
  };
}
