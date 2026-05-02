// claude-transcript-parser.ts — parses Claude transcript JSONL into the
// same StructuredTranscript shape as the Codex parser.
//
// NEW work for the Restore-Packet vertical M2b. No prior art. Inspected
// host's Claude transcript files at ~/.claude/projects/<project>/<id>.jsonl.
//
// Claude JSONL semantics (observed):
// - First few lines may carry meta records: { type, customTitle, sessionId }
//   or { type, agentName, sessionId } or { type, permissionMode, sessionId }.
// - Message records have type: "user" | "assistant" with fields:
//   { type, message, cwd, timestamp, parentUuid, sessionId, ... }.
//   `message` is an object whose shape is provider-API-specific:
//   - user: { role: "user", content: string | array }
//   - assistant: { role: "assistant", content: array of { type: "text", text } }
// - Attachment records ({ type: "attachment", attachment, ... }) carry tool
//   input/output content; mapped to raw_tool_outputs by the omitted-records
//   classifier and skipped from the message stream.
// - Other types ({ type: "summary" }, sessionId-only meta records, etc.)
//   are mapped to reasoning_records.

import { redact, hasSecretPattern } from "./redaction.js";
import { classifyClaudeRecord, OmittedCounter } from "./omitted-records.js";
import type {
  ExtractedMessage,
  PathCount,
  StructuredTranscript,
  TypeCounts,
  SessionMeta,
} from "./types.js";

const PATH_PATTERNS: readonly RegExp[] = [
  /\/Users\/wrandom\/[A-Za-z0-9._~:/@%+=,\- ]+/g,
  /\b(?:packages|docs|scripts|test|tests|src|openrig-work|rigs|control-plane)\/[A-Za-z0-9._~:/@%+=,\-]+/g,
];

function extractPaths(text: string, counts: Map<string, number>): void {
  for (const pattern of PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const cleaned = match[0].replace(/[),.;\]"'`]+$/g, "");
      if (cleaned.length < 6) continue;
      counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
    }
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim());
  if (!line) return "";
  return line.trim().slice(0, 180);
}

/**
 * Extract user-visible text from a Claude `message.content` field.
 * Handles three shapes:
 * - string (legacy / user): use directly.
 * - array of part objects (assistant or tool-bearing user): collect
 *   the `text` field of each `{ type: "text", text }` entry.
 * - other / null / undefined: empty string.
 *
 * Tool-use parts (`{ type: "tool_use", ... }`) and tool-result parts
 * (`{ type: "tool_result", ... }`) are intentionally NOT included in
 * the visible message text; those are captured separately as
 * raw_tool_outputs / function_call_output via the attachment-record path.
 */
function textFromClaudeMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const obj = message as Record<string, unknown>;
  const content = obj.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      // Skip tool_use / tool_result; they're not user-visible message text.
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
}

interface ClaudeRecord {
  type?: unknown;
  timestamp?: unknown;
  message?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  parentUuid?: unknown;
  attachment?: unknown;
  [key: string]: unknown;
}

/**
 * Parse a Claude transcript JSONL string into a StructuredTranscript.
 * Pure function; no I/O.
 *
 * Output is the SAME shape as the Codex parser per the M2b dispatch's
 * "emit the same structured representation as the Codex parser"
 * requirement. Downstream modules (packet-writer, redaction-counter)
 * see no runtime difference.
 */
export function parseClaudeTranscript(content: string): StructuredTranscript {
  const messages: ExtractedMessage[] = [];
  const pathCounts = new Map<string, number>();
  const typeCounts: TypeCounts = {};
  const omittedCounter = new OmittedCounter();
  let sessionMeta: SessionMeta | null = null;
  let lineCount = 0;
  let messageCount = 0;
  // Claude transcripts don't have "compacted" records; field stays at 0.

  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim()) continue;
    lineCount++;

    let record: ClaudeRecord;
    try {
      record = JSON.parse(rawLine) as ClaudeRecord;
    } catch {
      continue;
    }

    const recordType = typeof record.type === "string" ? record.type : "";
    typeCounts[recordType] = (typeCounts[recordType] ?? 0) + 1;

    // Capture sessionMeta from the first record that carries cwd + sessionId.
    if (
      sessionMeta === null &&
      typeof record.cwd === "string" &&
      typeof record.sessionId === "string"
    ) {
      sessionMeta = {
        cwd: record.cwd,
        sessionId: record.sessionId,
      };
    }

    const classification = classifyClaudeRecord(record);
    if (classification.kind === "omitted") {
      omittedCounter.recordOmission(classification.reason);
      // For attachment records, walk the attachment payload for paths
      // (mirrors the Codex parser's tool-call path-extraction behavior).
      if (recordType === "attachment" && record.attachment) {
        const attachStr = typeof record.attachment === "string"
          ? record.attachment
          : JSON.stringify(record.attachment);
        extractPaths(attachStr, pathCounts);
      }
      continue;
    }

    // Kept message.
    const role: "user" | "assistant" = recordType === "user" ? "user" : "assistant";
    const rawText = textFromClaudeMessage(record.message);
    if (hasSecretPattern(rawText)) {
      omittedCounter.recordRedaction();
    }
    const text = redact(rawText).trim();
    if (!text) continue;

    messageCount++;
    extractPaths(text, pathCounts);
    messages.push({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
      role,
      text,
      preview: firstLine(text),
    });
  }

  const paths: PathCount[] = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 200)
    .map(([path, count]) => ({ path, count }));

  return {
    sessionMeta,
    lineCount,
    messageCount,
    compactedCount: 0,
    typeCounts,
    omittedCounts: omittedCounter.counts,
    messages,
    paths,
  };
}
