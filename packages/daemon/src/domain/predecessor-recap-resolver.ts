import { parseJsonlExchanges, type JsonlExchange } from "./session-jsonl.js";
import type { PredecessorRecapResolver } from "./seat-handover-service.js";

/**
 * Production resolver for the seat-handover boot recap: resolve the DEPARTING seat's provider record
 * path — claude `transcript_path` (via the sidecar, keyed by session name) or codex `rollout_path`
 * (via the thread, keyed by the departing resume token) — and parse the last N exchanges into a
 * bounded from-record recap.
 *
 * The recap is the PERMANENT claude-runtime leg of scrollback-preserving handover, not an interim
 * measure: claude-code seats run in the tmux alternate screen, which keeps no scrollback buffer, so
 * a successor pane can never natively scroll into the predecessor conversation there. (Codex seats
 * get native scrollback via the in-pane respawn; the recap still renders as a convenience.)
 *
 * Bounded on BOTH axes: at most `maxExchanges` exchanges, and each exchange's content is capped at
 * `maxCharsPerExchange` characters (a single pasted-file or long-form exchange must not flood the
 * successor pane); truncation is visible and points the reader at the full record. Honest-degraded:
 * no resolvable path OR zero parsed exchanges → null (the composer then omits the recap sections,
 * never fabricating one). Pure + injected deps so the runtime-branching + null handling is
 * unit-tested without a live daemon; startup wires the real reads.
 */
const DEFAULT_MAX_EXCHANGES = 6;
const DEFAULT_MAX_CHARS_PER_EXCHANGE = 500;
const TRUNCATION_MARKER = "… [truncated; full text in the predecessor record]";

export interface PredecessorRecapResolverDeps {
  /** Claude: normalized usage carries `transcript_path`; resolve it from the session name. */
  readClaudeTranscriptPath: (sessionName: string) => string | null;
  /** Codex: normalized usage carries `rollout_path`; resolve it from the thread id (resume token). */
  readCodexTranscriptPath: (args: { threadId: string | null; sessionName: string }) => string | null;
  /** Look up the departing session's codex resume token (thread id) by node + session name. */
  lookupResumeToken: (nodeId: string, sessionName: string) => string | null;
  /** Injectable for tests; defaults to the real JSONL parser. */
  parseExchanges?: (path: string, n: number) => JsonlExchange[];
  /** Bounded recap size (default 6). */
  maxExchanges?: number;
  /** Per-exchange content cap in characters (default 500); over-cap content is visibly truncated. */
  maxCharsPerExchange?: number;
}

function boundExchange(ex: JsonlExchange, maxChars: number): JsonlExchange {
  if (ex.content.length <= maxChars) return ex;
  return { role: ex.role, content: ex.content.slice(0, maxChars) + TRUNCATION_MARKER };
}

export function makePredecessorRecapResolver(deps: PredecessorRecapResolverDeps): PredecessorRecapResolver {
  const parse = deps.parseExchanges ?? parseJsonlExchanges;
  const max = deps.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const maxChars = deps.maxCharsPerExchange ?? DEFAULT_MAX_CHARS_PER_EXCHANGE;
  return ({ nodeId, runtime, sessionName }) => {
    const path =
      runtime === "codex"
        ? deps.readCodexTranscriptPath({ threadId: deps.lookupResumeToken(nodeId, sessionName), sessionName })
        : deps.readClaudeTranscriptPath(sessionName);
    if (!path) return null;
    const recap = parse(path, max);
    if (recap.length === 0) return null;
    return { recap: recap.map((ex) => boundExchange(ex, maxChars)), recordPath: path };
  };
}
