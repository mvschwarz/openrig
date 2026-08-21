import { parseJsonlExchanges, type JsonlExchange } from "./session-jsonl.js";
import type { PredecessorRecapResolver, PredecessorRecapResolution } from "./seat-handover-service.js";

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
 * B16 — the claude leg is RACE-GUARDED and every null is NAMED. The sidecar is keyed by SESSION
 * NAME, and the cutover reuses the canonical name across generations, so a successor that has
 * already booted overwrites the very sidecar this resolver queries (the live defect: the resolver
 * read the successor's fresh sidecar and honestly returned nothing, silently). Two defenses:
 * the SERVICE now resolves BEFORE the successor launches, and this resolver verifies the sidecar's
 * session_id against the predecessor's recorded resume token when both are present — a mismatch is
 * an UNAVAILABLE verdict naming the collision, never a silent null and never someone else's recap.
 * Every no-recap outcome returns { unavailableReason } so the packet can say what happened
 * (honest-degraded means LABELED, not silent).
 *
 * Bounded on BOTH axes: at most `maxExchanges` exchanges, and each exchange's content is capped at
 * `maxCharsPerExchange` characters (a single pasted-file or long-form exchange must not flood the
 * successor pane); truncation is visible and points the reader at the full record. Pure + injected
 * deps so the runtime-branching + guard handling is unit-tested without a live daemon; startup
 * wires the real reads.
 */
const DEFAULT_MAX_EXCHANGES = 6;
const DEFAULT_MAX_CHARS_PER_EXCHANGE = 500;
const TRUNCATION_MARKER = "… [truncated; full text in the predecessor record]";

export interface PredecessorRecapResolverDeps {
  /** Claude: the name-keyed sidecar carries `transcript_path` + `session_id`; both ride the read so
   *  the caller can verify WHOSE record the name currently points at. */
  readClaudeRecord: (sessionName: string) => { transcriptPath: string | null; sessionId: string | null };
  /** Codex: normalized usage carries `rollout_path`; resolve it from the thread id (resume token). */
  readCodexTranscriptPath: (args: { threadId: string | null; sessionName: string }) => string | null;
  /** Look up the departing session's resume token by node + session name (codex thread id; for a
   *  claude row this is the predecessor's session uuid — the sidecar-ownership verifier). */
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
  return ({ nodeId, runtime, sessionName }): PredecessorRecapResolution => {
    let path: string | null;
    if (runtime === "codex") {
      const threadId = deps.lookupResumeToken(nodeId, sessionName);
      if (!threadId) return { unavailableReason: "no resume token recorded for the departing codex session" };
      path = deps.readCodexTranscriptPath({ threadId, sessionName });
      if (!path) return { unavailableReason: `no rollout record found for codex thread ${threadId}` };
    } else {
      const record = deps.readClaudeRecord(sessionName);
      if (!record.transcriptPath) {
        return { unavailableReason: "the name-keyed context sidecar is missing or carries no transcript_path" };
      }
      // Ownership guard: the sidecar must be the PREDECESSOR's, not a same-named successor's.
      const predecessorToken = deps.lookupResumeToken(nodeId, sessionName);
      if (predecessorToken && record.sessionId && record.sessionId !== predecessorToken) {
        return {
          unavailableReason:
            `the name-keyed sidecar belongs to session ${record.sessionId.slice(0, 8)}…, not the departing session ` +
            `${predecessorToken.slice(0, 8)}… (canonical-name reuse race — the record path would be the wrong tenure's)`,
        };
      }
      path = record.transcriptPath;
    }
    const recap = parse(path, max);
    if (recap.length === 0) {
      return { unavailableReason: `the predecessor record at ${path} yielded no user/assistant exchanges (empty, unreadable, or too large to read)` };
    }
    return { recap: recap.map((ex) => boundExchange(ex, maxChars)), recordPath: path };
  };
}
