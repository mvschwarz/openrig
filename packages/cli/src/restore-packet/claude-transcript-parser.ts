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
  /\/(?:Users|home)\/[^/\s]+\/[A-Za-z0-9._~:/@%+=,\- ]+/g,
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
 * Result of walking a Claude `message.content` field. Returns:
 * - `text`: concatenated user-visible text from `{ type: "text" }` parts.
 * - `toolUseCount`: number of `{ type: "tool_use" }` parts seen.
 *   These are nested function-call records inside an assistant turn;
 *   per M1 contract § 5 they map to `function_call_output`.
 * - `toolResultCount`: number of `{ type: "tool_result" }` parts seen.
 *   These are nested tool-output records inside a user turn; per
 *   contract § 5 they map to `raw_tool_outputs`.
 * - `toolPaths`: paths extracted from omitted tool_use inputs and
 *   tool_result content (mirrors `codex-jsonl-parser.ts`'s tool-call
 *   path-inventory behavior; the tool record itself is NOT in the
 *   message text but its file references stay in the touched-files
 *   inventory).
 *
 * R2 fix (per M2b R2 dispatch qitem-20260502011841-fb53d7fd): inspect
 * nested content parts BEFORE discarding non-text. Previously dropped
 * tool_use / tool_result silently, leading to misleading all-zero
 * omittedCounts on real Claude transcripts where nearly every assistant
 * turn has tool_use and most user turns have tool_result.
 */
interface ContentWalkResult {
  text: string;
  toolUseCount: number;
  toolResultCount: number;
  toolPaths: string[];
}

/**
 * Extract `text` candidates from a tool_result `content` field. The
 * Claude API allows two shapes for `tool_result.content`:
 * - string (the most common; e.g., a command's stdout): use directly.
 * - array of part objects (when the tool returned structured content):
 *   collect each part's `text` field.
 * Returns a flat string suitable for path extraction.
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push(p.text);
      }
    }
  }
  return parts.join("\n");
}

function walkClaudeContent(message: unknown): ContentWalkResult {
  const out: ContentWalkResult = { text: "", toolUseCount: 0, toolResultCount: 0, toolPaths: [] };
  if (!message || typeof message !== "object") return out;
  const obj = message as Record<string, unknown>;
  const content = obj.content;
  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) return out;

  const textParts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      textParts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const partType = typeof p.type === "string" ? p.type : "";

    if (partType === "text" && typeof p.text === "string") {
      textParts.push(p.text);
      continue;
    }

    if (partType === "tool_use") {
      out.toolUseCount += 1;
      // Extract paths from the tool_use input. Mirrors the Codex parser's
      // tool-call path-inventory behavior at codex-jsonl-parser.ts.
      const input = p.input;
      const inputStr = typeof input === "string" ? input : JSON.stringify(input ?? {});
      out.toolPaths.push(inputStr);
      continue;
    }

    if (partType === "tool_result") {
      out.toolResultCount += 1;
      // tool_result.content can be string OR array; both extract a flat
      // text body for path scanning.
      const resultText = toolResultText(p.content);
      out.toolPaths.push(resultText);
      continue;
    }

    // Other part types (image, etc.) are not user-visible text and not
    // counted in the M1 contract enums; skip without counting.
  }
  out.text = textParts.filter((s) => s.length > 0).join("\n");
  return out;
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
    const walked = walkClaudeContent(record.message);

    // R2 fix: count nested tool_use / tool_result parts BEFORE deciding
    // whether to emit a visible-text message. These counters fire
    // regardless of whether the record contributes a message to the
    // visible transcript — capturing them here is what M1 contract § 5
    // requires for an honest `omitted_classes` field downstream.
    for (let i = 0; i < walked.toolUseCount; i++) {
      omittedCounter.recordOmission("function_call_output");
    }
    for (let i = 0; i < walked.toolResultCount; i++) {
      omittedCounter.recordOmission("raw_tool_outputs");
    }
    // Path extraction from omitted tool parts (mirrors Codex parser
    // behavior of walking tool-call args / inputs for path inventory
    // even though the records themselves are omitted from messages).
    for (const toolText of walked.toolPaths) {
      extractPaths(toolText, pathCounts);
    }

    if (hasSecretPattern(walked.text)) {
      omittedCounter.recordRedaction();
    }
    const text = redact(walked.text).trim();
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
