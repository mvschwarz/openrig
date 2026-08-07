import { parseJsonlExchanges, type JsonlExchange } from "./session-jsonl.js";
import type { PredecessorRecapResolver } from "./seat-handover-service.js";

/**
 * Production resolver for the seat-handover stopgap (plan 411c43de): resolve the DEPARTING seat's
 * provider record path — claude `transcript_path` (via the sidecar, keyed by session name) or codex
 * `rollout_path` (via the thread, keyed by the departing resume token) — and parse the last N exchanges
 * into a bounded from-record recap. Honest-degraded: no resolvable path OR zero parsed exchanges → null
 * (the composer then omits the recap sections, never fabricating one). Pure + injected deps so the
 * runtime-branching + null handling is unit-tested without a live daemon; startup wires the real reads.
 */
const DEFAULT_MAX_EXCHANGES = 6;

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
}

export function makePredecessorRecapResolver(deps: PredecessorRecapResolverDeps): PredecessorRecapResolver {
  const parse = deps.parseExchanges ?? parseJsonlExchanges;
  const max = deps.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  return ({ nodeId, runtime, sessionName }) => {
    const path =
      runtime === "codex"
        ? deps.readCodexTranscriptPath({ threadId: deps.lookupResumeToken(nodeId, sessionName), sessionName })
        : deps.readClaudeTranscriptPath(sessionName);
    if (!path) return null;
    const recap = parse(path, max);
    if (recap.length === 0) return null;
    return { recap, recordPath: path };
  };
}
