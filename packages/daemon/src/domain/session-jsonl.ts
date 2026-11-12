// Seat-handover boot recap — the shared provider-JSONL role/content reader. Reads a
// KNOWN provider session-transcript path (claude sidecar `transcript_path` / codex `rollout_path`)
// into the last-N {role, content} exchanges for the successor's boot recap. DEFENSIVE / honest-degraded
// by contract: metadata lines, thinking/tool_use-only messages, and unparseable lines carry no user
// text and are silently skipped; a missing/corrupt file yields [] and NEVER throws (a boot recap must
// never crash the successor). Ownership: dev-planner ruled this the shared parser (their rig-ask L2
// only greps raw lines); it may consume this later if L2 upgrades to structured excerpts.
//
// Grounded at source on the real claude-projects line shape:
//   {type:"user"|"assistant", message:{role, content}} where content is a STRING or an array of
//   {type:"text"|"thinking"|"tool_use", text?} blocks (only "text" carries user-visible content).
// Codex rollout lines use {payload:{type:"message", role, content}} — handled by the same reader.
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export interface JsonlExchange {
  role: string;
  content: string;
}

/** Extract the user-visible text from a message `content` field (string, or an array of blocks —
 *  join `text` blocks, plus Codex input_text/output_text when requested; skip thinking/tool_use). Returns "" when there is no text. */
function extractText(content: unknown, codex = false): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: string } => {
        if (!block || typeof block !== "object") return false;
        const { type, text } = block as { type?: unknown; text?: unknown };
        const visible = type === "text" || (codex && (type === "input_text" || type === "output_text"));
        return visible && typeof text === "string";
      })
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** Interpret ONE parsed JSONL object as an exchange, or null if it carries no user-visible message
 *  (metadata, thinking/tool_use-only, unrecognized shape). */
function toExchange(obj: unknown): JsonlExchange | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  // claude-projects: {type:"user"|"assistant", message:{role, content}}
  const msg = o.message as { role?: unknown; content?: unknown } | undefined;
  if (msg && typeof msg.role === "string") {
    const content = extractText(msg.content);
    return content.length > 0 ? { role: msg.role, content } : null;
  }
  // codex rollout: {payload:{type:"message", role, content}}
  const payload = o.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
  if (payload && payload.type === "message" && typeof payload.role === "string") {
    const content = extractText(payload.content, true);
    return content.length > 0 ? { role: payload.role, content } : null;
  }
  return null;
}

/** Read complete lines newest-first; join bytes before UTF-8 decoding, including long records. */
function* readLinesBackwards(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    let position = fstatSync(fd).size;
    let fragments: Buffer[] = [];
    while (position > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, position));
      position -= chunk.length;
      let read = 0;
      while (read < chunk.length) {
        const count = readSync(fd, chunk, read, chunk.length - read, position + read);
        if (count === 0) throw new Error("transcript changed before the recap read completed");
        read += count;
      }
      let end = chunk.length;
      while (end > 0) {
        const newline = chunk.lastIndexOf(10, end - 1);
        if (newline === -1) break;
        const tail = chunk.subarray(newline + 1, end);
        yield (fragments.length ? Buffer.concat([tail, ...fragments.reverse()]) : tail).toString("utf8");
        fragments = [];
        end = newline;
      }
      if (end > 0) fragments.push(chunk.subarray(0, end));
    }
    if (fragments.length) yield Buffer.concat(fragments.reverse()).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse the LAST `n` visible exchanges without reading the whole provider session transcript.
 * Memory follows the selected exchanges and longest visited line, not the whole file.
 * Honest-degraded: any read/decoding failure returns []; never return a partial recap.
 * Unparseable/metadata/text-less lines are skipped, as before.
 */
export function parseJsonlExchanges(path: string, n: number): JsonlExchange[] {
  if (n <= 0) return [];
  const exchanges: JsonlExchange[] = [];
  try {
    for (const line of readLinesBackwards(path)) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // corrupt/blank line — skip, never throw
      }
      const ex = toExchange(obj);
      if (ex && exchanges.push(ex) >= n) break;
    }
  } catch {
    return [];
  }
  return exchanges.reverse();
}
