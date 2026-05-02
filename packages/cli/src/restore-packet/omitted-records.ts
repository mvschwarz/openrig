// omitted-records.ts — classifies a parsed source record into one of the
// 4 omitted-class enums (per M1 contract § 5) or accepts it as a kept
// user-visible message.
//
// v0 generator excludes the following record classes from
// transcript-latest.md and transcript.md:
//
// - reasoning_records: internal reasoning records that the runtime emitted
//   but were not user-visible messages.
// - raw_tool_outputs: full raw tool execution output (often verbose; may
//   contain transient state).
// - function_call_output: function-call result records that are not
//   user-visible.
// - redacted_secrets: applied to any matched credential patterns per the
//   redaction policy. (This class counts records whose content matched
//   a secret pattern AND was therefore redacted.)
//
// `omitted_classes` in the summary enumerates the classes ACTUALLY
// excluded for THIS packet (not all available classes); the validator
// checks each name is one of the 4 enum values.

import { emptyOmittedCounts, type OmittedCounts, type OmittedRecordClass } from "./types.js";
import { hasSecretPattern } from "./redaction.js";

/** Source-runtime-agnostic record classifier output. */
export type ClassifyResult =
  | { kind: "kept" }
  | { kind: "omitted"; reason: OmittedRecordClass };

/**
 * Classify a Codex JSONL record (the parsed JSON object) into kept /
 * omitted. Caller is responsible for passing only `response_item`-class
 * records; session_meta and compacted are handled separately by the
 * Codex parser.
 *
 * Codex semantics (per Velocity prior art):
 * - response_item with payload.type === "function_call" → function_call_output
 * - response_item with payload.type === "custom_tool_call" → raw_tool_outputs
 * - response_item with payload.type === "reasoning" → reasoning_records
 * - response_item with payload.type === "message" + role in {developer,user,assistant}
 *   → kept (after secret-pattern check)
 * - everything else → reasoning_records (catch-all for non-message non-tool
 *   payload types)
 */
export function classifyCodexRecord(record: { payload?: { type?: unknown; role?: unknown } }): ClassifyResult {
  const payloadType = typeof record.payload?.type === "string" ? record.payload.type : "";
  switch (payloadType) {
    case "function_call":
      return { kind: "omitted", reason: "function_call_output" };
    case "custom_tool_call":
      return { kind: "omitted", reason: "raw_tool_outputs" };
    case "reasoning":
      return { kind: "omitted", reason: "reasoning_records" };
    case "message": {
      const role = typeof record.payload?.role === "string" ? record.payload.role : "";
      if (role !== "developer" && role !== "user" && role !== "assistant") {
        return { kind: "omitted", reason: "reasoning_records" };
      }
      return { kind: "kept" };
    }
    default:
      return { kind: "omitted", reason: "reasoning_records" };
  }
}

/**
 * Classify a Claude transcript record. Claude shape carries the role
 * directly at `record.type` (user / assistant / system / attachment /
 * summary etc). Per the M2b dispatch's "emit the same structured
 * representation as the Codex parser" requirement, the omitted-class
 * mapping mirrors Codex.
 */
export function classifyClaudeRecord(record: { type?: unknown }): ClassifyResult {
  const type = typeof record.type === "string" ? record.type : "";
  switch (type) {
    case "user":
    case "assistant":
      return { kind: "kept" };
    case "attachment":
      // Attachments are tool-result-class records (file content the user
      // attached or tool output). Map to raw_tool_outputs.
      return { kind: "omitted", reason: "raw_tool_outputs" };
    case "summary":
      // System/summary records are non-user-visible meta; map to
      // reasoning_records.
      return { kind: "omitted", reason: "reasoning_records" };
    default:
      // Everything else (sessionId-only, agentInfo, permissionMode meta,
      // etc.) is metadata, not a user-visible message.
      return { kind: "omitted", reason: "reasoning_records" };
  }
}

/** State holder for accumulating omitted-class counts during parsing. */
export class OmittedCounter {
  readonly counts: OmittedCounts = emptyOmittedCounts();

  recordOmission(reason: OmittedRecordClass): void {
    this.counts[reason] += 1;
  }

  /**
   * Mark that a kept message had secret content (was redacted). Increments
   * `redacted_secrets` per occurrence. Caller checks `hasSecretPattern`
   * BEFORE redaction to decide whether to record this.
   */
  recordRedaction(): void {
    this.counts.redacted_secrets += 1;
  }

  /**
   * Returns the list of omitted classes that have at least one record.
   * Used to populate `summary.omitted_classes` per contract § 5.
   * Order: stable (the enum order from the type definition).
   */
  activeClasses(): OmittedRecordClass[] {
    const order: OmittedRecordClass[] = [
      "reasoning_records",
      "raw_tool_outputs",
      "function_call_output",
      "redacted_secrets",
    ];
    return order.filter((cls) => this.counts[cls] > 0);
  }
}

/** Re-export for convenience. */
export { hasSecretPattern };
