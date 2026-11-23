import { readOpenRigEnv } from "./openrig-compat.js";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { openLocalDbReadonly } from "./local-db.js";

export type TmuxIdentityReader = (pane: string, option: string) => string | undefined;

/** A busy or wedged tmux server must not hold every queue request: past this, the pane's seat is unresolved. */
export const TMUX_IDENTITY_TIMEOUT_MS = 1_000;

const readTmuxIdentity: TmuxIdentityReader = (pane, option) => {
  try {
    const value = execFileSync("tmux", ["show-option", "-v", "-t", pane, option], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TMUX_IDENTITY_TIMEOUT_MS,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
};

/** Whether the daemon still binds a node to a tmux session. Claim records the binding beside the session's metadata;
 *  unclaim deletes it in its own transaction even when clearing the metadata fails. */
export type BindingCheck = (nodeId: string, tmuxSession: string) => boolean;

export function bindingIsCurrent(db: Database.Database, nodeId: string, tmuxSession: string): boolean {
  return db.prepare("SELECT 1 FROM bindings WHERE node_id = ? AND tmux_session = ?").get(nodeId, tmuxSession) !== undefined;
}

/** The binding as this home's database records it; no database, or no answer, isn't evidence of a binding. */
const localBindingIsCurrent: BindingCheck = (nodeId, tmuxSession) => {
  let db: Database.Database | undefined;
  try {
    db = openLocalDbReadonly();
    return bindingIsCurrent(db, nodeId, tmuxSession);
  } catch {
    return false;
  } finally {
    db?.close();
  }
};

// The pane's seat, read once per run (runProgram resets it), so a command's preflight and every request it sends share one
// value and one tmux read. Keyed by what produced it, so a different pane or reader reads again.
let paneSeat: { pane: string; tmuxReader: TmuxIdentityReader; isBound: BindingCheck; session: string | undefined } | undefined;

/** Forget the pane seat read for the previous run. */
export function resetSenderSession(): void {
  paneSeat = undefined;
}

/**
 * The seat identity a CLI dispatch is attributed to — the SAME value the
 * DaemonClient stamps as `X-OpenRig-Session` (the P18 chokepoint), from which
 * the daemon DERIVES the actor / rendered `From:`. The process seat env wins;
 * a reconciled managed pane's `@rigged_session_name` repairs a live process
 * that predates its env binding, but only while the daemon still binds that
 * session's node to it: metadata left behind on a released session isn't a
 * current seat. Caller-supplied body claims never become a seat. Returns
 * `undefined` when neither managed source resolves.
 */
export function resolveSenderSession(
  tmuxReader: TmuxIdentityReader = readTmuxIdentity,
  isBound: BindingCheck = localBindingIsCurrent,
): string | undefined {
  const env = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
  if (env) return env;
  const pane = process.env.TMUX_PANE?.trim();
  if (!pane) return undefined;
  if (paneSeat?.pane === pane && paneSeat.tmuxReader === tmuxReader && paneSeat.isBound === isBound) return paneSeat.session;
  const session = boundPaneSeat(pane, tmuxReader, isBound);
  paneSeat = { pane, tmuxReader, isBound, session };
  return session;
}

function boundPaneSeat(pane: string, tmuxReader: TmuxIdentityReader, isBound: BindingCheck): string | undefined {
  const session = tmuxReader(pane, "@rigged_session_name")?.trim();
  if (!session) return undefined;
  const nodeId = tmuxReader(pane, "@rigged_node_id")?.trim();
  return nodeId && isBound(nodeId, session) ? session : undefined;
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
