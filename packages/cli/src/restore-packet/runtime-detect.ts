// runtime-detect.ts — auto-detect the source runtime from a JSONL/transcript
// shape.
//
// Per M1 contract § 3.4: source-runtime resolution for `--source-jsonl` is
// auto-detected from the JSONL shape (Codex JSONL has `payload.type`
// markers; Claude transcript has different shape). If auto-detect is
// ambiguous, fail with clear error and prompt for `--source-runtime`
// flag.
//
// Detection is by content shape, NOT file extension or filename
// (per dispatch's "Do NOT use file extensions or filenames as the
// detection key. Detect by content shape.").
//
// Codex shape: each line is JSON with `type` field; the discriminating
// markers are `type: "session_meta"`, `type: "response_item"`, or
// `type: "compacted"`. response_item records carry a `payload` object
// with a `type` sub-field.
//
// Claude shape: each line is JSON with `type` field; values include
// `user`, `assistant`, `system`, `attachment`, `summary`, etc. NO
// `payload` wrapper; the message content is directly under `message`
// or `attachment`.

import type { SourceRuntime } from "./types.js";

/**
 * Detect the source runtime from a sample of JSONL lines.
 *
 * Returns:
 * - "codex" — at least one line has `type: "response_item"` OR
 *   `type: "session_meta"` OR `type: "compacted"`.
 * - "claude-code" — at least one line has `type: "user"` or
 *   `type: "assistant"` AND no Codex markers seen.
 * - null — input is empty / non-JSONL / ambiguous (e.g., neither
 *   marker class appears).
 *
 * Detection is non-greedy: walks the input lines until a definitive
 * marker is found. Bias toward Codex markers if both shape classes
 * appear (extremely unlikely in practice; would indicate a malformed
 * mixed source).
 */
export function detectRuntime(content: string): SourceRuntime | null {
  if (typeof content !== "string" || content.length === 0) return null;

  let sawCodexMarker = false;
  let sawClaudeMarker = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let record: { type?: unknown; payload?: { type?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      // Skip malformed JSON lines; they don't affect detection.
      continue;
    }

    const recordType = typeof record.type === "string" ? record.type : "";

    // Codex discriminators: type values + payload wrapper presence.
    if (
      recordType === "response_item" ||
      recordType === "session_meta" ||
      recordType === "compacted"
    ) {
      sawCodexMarker = true;
      // Early-return on the strongest Codex marker; ambiguity bias
      // toward Codex if Claude markers also appear is intentional
      // (Codex's response_item is structurally distinct from any
      // Claude record; if it's present, the content is Codex JSONL).
      return "codex";
    }

    // Claude discriminators: top-level type as a user/assistant marker.
    if (recordType === "user" || recordType === "assistant") {
      sawClaudeMarker = true;
      // Don't early-return on Claude alone — keep looking for any
      // Codex marker (defensive against the unlikely mixed-shape case).
    }
  }

  if (sawCodexMarker) return "codex";
  if (sawClaudeMarker) return "claude-code";
  return null;
}
