import { CODEX_TURN_STATUS_PATTERN } from "../codex-pane-patterns.js";
import {
  AGENT_ACTIVITY_FRESHNESS_MS,
  type AgentActivityStore,
} from "../agent-activity-store.js";

/**
 * Codex usage-limit banner detector (#763).
 *
 * The reactive tap only accepts a typed `at_limit` hook row, and no hook
 * producer emits one for Codex — the limit surfaces solely as a pane banner.
 * This module matches that banner and records it, so `rig provider signals`
 * and seat status report what the seat itself shows.
 */
export interface CodexLimitBanner {
  /** The "try again at …" text exactly as observed, or null when absent. */
  resetText: string | null;
  /** The banner line, truncated — audit trail for the verdict. */
  evidence: string;
}

const BANNER_LINE_RE = /^\s*■ You've hit your usage limit\b/;
const RESET_RE = /try again at ([^.!\n]+)/i;

// Fenced code blocks: banner-shaped text an agent printed is quoted content,
// not the seat's own state.
const FENCE_RE = /^\s*```/;

// A prompt can be a draft composer or a submitted message; its suffix decides.
const INPUT_LINE_RE = /^\s*›(?:\s|$)/;

/**
 * Match the banner's own line form: the ■ marker must lead (after indent).
 * An agent quoting the sentence, or an error line merely containing the
 * words without the marker, never matches. A match inside a fenced code
 * block is quoted agent output, not seat state. And the banner must still be
 * the most recent content: anything below it other than the composer
 * or footer (a user message, a reply, further output) means a recovered seat
 * whose old banner merely scrolled into view — Codex prints a new banner at
 * the bottom when the limit hits again, so that is still detected.
 */
export function detectCodexLimitBanner(paneContent: string): CodexLimitBanner | null {
  const lines = paneContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!BANNER_LINE_RE.test(line)) continue;
    if (isFenced(lines, i)) continue;
    // Once a banner is established, its following user blocks cannot supply
    // output or alter quote boundaries. Keep initial banner recognition intact.
    const after = withoutPromptContinuations(lines.slice(i + 1));
    lines.splice(i + 1, after.length, ...after);
    // The reset phrase can wrap onto the following lines in a capture — but
    // only when the banner line doesn't carry it yet. A one-line banner with
    // its reset text ends here: the next line is newer output, not a
    // continuation, and is judged on its own below.
    let blockEnd = i;
    if (!RESET_RE.test(line)) {
      for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
        if (RESET_RE.test(lines.slice(i, j + 1).join("\n"))) {
          blockEnd = j;
          break;
        }
      }
    }
    const window = lines.slice(i, blockEnd + 1).join("\n");
    const reset = RESET_RE.exec(window);
    if (!isMostRecent(lines, blockEnd)) continue;
    return {
      resetText: reset ? reset[1]!.trim() : null,
      evidence: line.trim().slice(0, 200),
    };
  }
  return null;
}

function withoutPromptContinuations(lines: string[]): string[] {
  // Codex renders draft continuations in a two-column gutter. Preserve the
  // outer prompt as their boundary; nested markers, banners and fences are
  // user text. Conservatively keep any deeper indentation inside that block.
  let promptIndent: number | null = null;
  let fenced = false;
  return lines.map((line) => {
    const indent = line.search(/\S/);
    if (indent < 0) return line;
    if (promptIndent !== null && indent > promptIndent) return "";
    if (FENCE_RE.test(line)) fenced = !fenced;
    promptIndent = !fenced && INPUT_LINE_RE.test(line) ? indent : null;
    return line;
  });
}

function isFenced(lines: string[], index: number): boolean {
  let fenced = false;
  for (let i = 0; i < index; i++) {
    if (FENCE_RE.test(lines[i]!)) fenced = !fenced;
  }
  return fenced;
}

function isMostRecent(lines: string[], index: number): boolean {
  // Before the last possible composer, only blanks may follow the banner.
  // A live turn-status row after that prompt proves it was submitted history,
  // not an input boundary. Keep indented draft continuations as user text.
  const after = lines.slice(index + 1);
  let inputAt = after.length - 1;
  while (inputAt >= 0 && !INPUT_LINE_RE.test(after[inputAt]!)) inputAt--;
  if (inputAt >= 0) {
    const indent = after[inputAt]!.search(/\S/);
    if (after.slice(inputAt + 1).some((line, offset) => {
      const text = line.trimStart();
      return line.length - text.length <= indent && CODEX_TURN_STATUS_PATTERN.test(text) &&
        !isFenced(after, inputAt + 1 + offset);
    })) return false;
  }
  const tail = inputAt < 0 ? after : after.slice(0, inputAt);
  return tail.every((line) => /^\s*$/.test(line));
}

/**
 * Record a banner observation as a typed `at_limit` hook row. See
 * `clearRecordedBanner` for how the same-banner memory is reset.
 */
/**
 * The reset text of the banner last recorded per session. A newer hook row
 * clears the signal by superseding it; if the same banner is still visible
 * afterwards, it is the same limit episode, not a new one — record again
 * only when a new banner (different reset text) appears. Bounded so idle
 * daemons cannot grow it without limit.
 */
const lastRecordedBySession = new Map<string, string | null>();
const LAST_RECORDED_CAP = 1000;

/**
 * Forget a session's recorded banner. The poller calls this when a Codex
 * seat shows no current banner: the episode is over, so a banner that
 * appears later is new even if its reset text matches the old one.
 */
export function clearRecordedBanner(sessionName: string): void {
  lastRecordedBySession.delete(sessionName);
}

export function recordCodexLimitBanner(deps: {
  store: Pick<AgentActivityStore, "getLatestForNode" | "recordHookEvent">;
  resolveGeneration: (sessionName: string) => string | null;
  sessionName: string;
  banner: CodexLimitBanner | null;
  now?: () => Date;
}): boolean {
  const nowFn = deps.now ?? (() => new Date());
  const nowMs = nowFn().getTime();
  const latest = deps.store.getLatestForNode({ sessionName: deps.sessionName });
  if (!deps.banner) {
    clearRecordedBanner(deps.sessionName);
    const generation = deps.resolveGeneration(deps.sessionName);
    // Only a newer, same-occupant capture can end the stored episode. A
    // neutral notification supersedes the limit without inventing idle/work;
    // the ordinary structural and motion evidence still decides the state.
    if (latest?.rawEvent !== "at_limit" || latest.generation !== generation ||
        !(nowMs > Date.parse(latest.eventAt ?? ""))) return false;
    return deps.store.recordHookEvent({
      runtime: "codex", sessionName: deps.sessionName,
      hookEvent: "Notification", subtype: "usage_limit_cleared",
      occurredAt: new Date(nowMs).toISOString(), generation,
    }).ok;
  }
  if (latest?.rawEvent === "at_limit") {
    // Still the reported episode: refresh only once the report ages out, so
    // a night at the limit is a handful of rows, not thousands.
    const eventMs = latest.eventAt ? Date.parse(latest.eventAt) : Number.NaN;
    if (Number.isFinite(eventMs) && nowMs - eventMs < AGENT_ACTIVITY_FRESHNESS_MS) return false;
  } else if (latest) {
    if (lastRecordedBySession.get(deps.sessionName) === deps.banner.resetText) return false;
  }
  deps.store.recordHookEvent({
    runtime: "codex",
    sessionName: deps.sessionName,
    hookEvent: "at_limit",
    subtype: deps.banner.resetText,
    generation: deps.resolveGeneration(deps.sessionName),
  });
  lastRecordedBySession.set(deps.sessionName, deps.banner.resetText);
  if (lastRecordedBySession.size > LAST_RECORDED_CAP) {
    const oldest = lastRecordedBySession.keys().next();
    if (!oldest.done) lastRecordedBySession.delete(oldest.value);
  }
  return true;
}
