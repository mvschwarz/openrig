import { readOpenRigEnv } from "./openrig-compat.js";
import { execFileSync } from "node:child_process";

export type TmuxIdentityReader = (pane: string, option: string) => string | undefined;

const readTmuxIdentity: TmuxIdentityReader = (pane, option) => {
  try {
    const value = execFileSync("tmux", ["show-option", "-v", "-t", pane, option], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
};

/**
 * The seat identity a CLI dispatch is attributed to — the SAME value the
 * DaemonClient stamps as `X-OpenRig-Session` (the P18 chokepoint), from which
 * the daemon DERIVES the actor / rendered `From:`. The process seat env wins;
 * a reconciled managed pane's `@rigged_session_name` repairs a live process
 * that predates its env binding. Caller-supplied body claims never become a
 * seat. Returns `undefined` when neither managed source resolves.
 */
export function resolveSenderSession(tmuxReader: TmuxIdentityReader = readTmuxIdentity): string | undefined {
  const env = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
  if (env) return env;
  const pane = process.env.TMUX_PANE?.trim();
  if (!pane) return undefined;
  return tmuxReader(pane, "@rigged_session_name")?.trim() || undefined;
}

/**
 * The session-less fall-open marker for an unattributable CLI dispatch. P18 (deletion atom) REVERSES A1's
 * seat-boundary refusal: an unresolved `rig send`/`broadcast` now DELIVERS carrying this HONEST label rather
 * than refusing, because the daemon half delivers-and-labels the header-absent write (no downstream 401) —
 * unverified is labelled unknown, never laundered to verified.
 *
 * This is ONE of the TWO named twin definition sites of the literal; the other is the daemon's
 * `pane-envelope.ts::SENDER_FALLBACK` (its byte-identical `wrapPaneEnvelope` twin). Both `send.ts`
 * (`wrapSendBody`) and `broadcast.ts` (the enveloped-fan-out marker) IMPORT this single CLI origin rather
 * than re-declaring it — so the CLI has NO scattered fallbacks. A THIRD literal definition anywhere in src
 * is caught BY NAME by the `send.test.ts` canonicity guard.
 */
export const SENDER_FALLBACK = "<unknown sender>";
