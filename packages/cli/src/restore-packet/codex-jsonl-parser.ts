// codex-jsonl-parser.ts — parses Codex JSONL into a StructuredTranscript.
//
// Translates the Velocity prior art parser at
// field-notes/2026-04-27-velocity-claude-from-codex-restore/tools/
// codex-jsonl-to-restore-packet.mjs:81-160 from JS to TypeScript.
// Velocity .mjs is FROZEN reference; this module borrows the structural
// shape only.
//
// Codex JSONL semantics (from Velocity prior art):
// - record.type === "session_meta" → session metadata (cwd, etc.)
// - record.type === "compacted" → compaction marker (counter only)
// - record.type === "response_item" + payload.type:
//   - "function_call" → omitted (function_call_output class); extract paths from args
//   - "custom_tool_call" → omitted (raw_tool_outputs class); extract paths from input
//   - "reasoning" → omitted (reasoning_records class)
//   - "message" → kept (after redaction); extract paths from content
//
// Output is a StructuredTranscript (per types.ts) consumed by the
// packet-writer (M2c).

import { redact, hasSecretPattern } from "./redaction.js";
import { classifyCodexRecord, OmittedCounter } from "./omitted-records.js";
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

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const obj = part as Record<string, unknown>;
      const val = obj.text ?? obj.content ?? obj.output ?? obj.input ?? "";
      return typeof val === "string" ? val : "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
}

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

interface CodexRecord {
  type?: unknown;
  timestamp?: unknown;
  payload?: {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    arguments?: unknown;
    input?: unknown;
    cwd?: unknown;
    [key: string]: unknown;
  };
}

/**
 * Parse a Codex JSONL string (the full file content as a single string)
 * into a StructuredTranscript. Pure function; no I/O.
 *
 * Malformed lines are skipped silently (matches Velocity prior art
 * `:100-102`); the lineCount counts every non-empty input line, so the
 * count of skipped lines is `lineCount - <kept-or-typed records>`.
 */
export function parseCodexJsonl(content: string): StructuredTranscript {
  const messages: ExtractedMessage[] = [];
  const pathCounts = new Map<string, number>();
  const typeCounts: TypeCounts = {};
  const omittedCounter = new OmittedCounter();
  let sessionMeta: SessionMeta | null = null;
  let lineCount = 0;
  let messageCount = 0;
  let compactedCount = 0;

  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim()) continue;
    lineCount++;

    let record: CodexRecord;
    try {
      record = JSON.parse(rawLine) as CodexRecord;
    } catch {
      continue;
    }

    const recordType = typeof record.type === "string" ? record.type : "";
    typeCounts[recordType] = (typeCounts[recordType] ?? 0) + 1;

    if (recordType === "session_meta") {
      const payload = (record.payload ?? null) as Record<string, unknown> | null;
      sessionMeta = {
        cwd: typeof payload?.cwd === "string" ? payload.cwd : null,
        sessionId: typeof payload?.id === "string" ? payload.id : null,
        raw: payload ?? undefined,
      };
      continue;
    }

    if (recordType === "compacted") {
      compactedCount++;
      continue;
    }

    if (recordType !== "response_item") continue;

    const classification = classifyCodexRecord(record);
    if (classification.kind === "omitted") {
      omittedCounter.recordOmission(classification.reason);
      // Still extract paths from tool calls (matches Velocity behavior at
      // :119-129 where args/input are walked for paths even though the
      // record itself is omitted from messages).
      const payload = record.payload;
      if (payload?.type === "function_call") {
        const args = typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments ?? {});
        extractPaths(args, pathCounts);
      } else if (payload?.type === "custom_tool_call") {
        const input = typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input ?? {});
        extractPaths(input, pathCounts);
      }
      continue;
    }

    // Kept message.
    const role = record.payload?.role;
    const roleStr = typeof role === "string" ? role : "unknown";
    if (roleStr !== "developer" && roleStr !== "user" && roleStr !== "assistant") {
      continue;
    }

    const rawText = textFromContent(record.payload?.content);
    if (hasSecretPattern(rawText)) {
      omittedCounter.recordRedaction();
    }
    const text = redact(rawText).trim();
    if (!text) continue;

    messageCount++;
    extractPaths(text, pathCounts);
    messages.push({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
      role: roleStr,
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
    compactedCount,
    typeCounts,
    omittedCounts: omittedCounter.counts,
    messages,
    paths,
  };
}
