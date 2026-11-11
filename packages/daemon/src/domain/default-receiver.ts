import type Database from "better-sqlite3";
import { readReceivingAgentSetting } from "./queue-owner.js";

/** The kernel's operator agent (pod operator, member agent): the receiving agent when none is set. */
export const KERNEL_OPERATOR_SESSION = "operator-agent@kernel";

export type DefaultReceiverSource = "setting" | "kernel-operator" | "none";
/** The seat's newest recorded session status, as recorded, never as proof it's reading: `running`, `idle` and `unknown`
 *  are kept apart; `stopped` is an exited, detached or superseded one (`recorded` names which). `missing`: no seat by that
 *  name on this host. `unknown` with no `recorded`: the seat couldn't be read. None of these picks another seat. */
export type ReceiverState = "running" | "idle" | "stopped" | "missing" | "unknown";

/** The agent that receives what a person answers when nothing else reads it: requests with no owner of their own, such
 *  as a pairing request or a mode's scheduled end, and Slack messages no thread or channel route claims. */
export interface DefaultReceiver {
  session: string | null;
  source: DefaultReceiverSource;
  state: ReceiverState;
  /** The seat's newest recorded status, when there is one. */
  recorded?: string;
  /** Why the chosen agent couldn't be used (an unreadable setting, or one that isn't an agent's session), carried with
   *  whatever was resolved instead, so a fallback is never presented as the choice. */
  note?: string;
}

/** The chosen agent (`agents.operator_session`, an agent's canonical session), else the kernel operator when this host has
 *  its seat, else none. A stopped receiver stays the receiver: its answers wait for it, and its state says so. This never
 *  chooses whichever seat happens to be running, and never a person: the person's own address
 *  (`workspace.operator_seat_name`) is a separate setting. */
export function resolveDefaultReceiver(
  db: Database.Database,
  configured: () => string | null | { session: string | null; problem?: string } = readReceivingAgentSetting,
): DefaultReceiver {
  const read = configured();
  const chosen = typeof read === "object" && read !== null ? read : { session: read };
  const note = chosen.problem ? { note: chosen.problem } : {};
  if (chosen.session) return { session: chosen.session, source: "setting", ...seatState(db, chosen.session), ...note };
  const kernel = seatState(db, KERNEL_OPERATOR_SESSION);
  if (kernel.state === "missing" || (kernel.state === "unknown" && !kernel.recorded)) return { session: null, source: "none", state: kernel.state, ...note };
  return { session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", ...kernel, ...note };
}

function seatState(db: Database.Database, session: string): Pick<DefaultReceiver, "state" | "recorded"> {
  let row: { status: string | null } | undefined;
  try {
    row = db.prepare("SELECT status FROM sessions WHERE session_name = ? ORDER BY rowid DESC LIMIT 1").get(session) as { status: string | null } | undefined;
  } catch {
    return { state: "unknown" };
  }
  if (!row) return { state: "missing" };
  const recorded = row.status ?? "unknown";
  const state: ReceiverState = recorded === "running" || recorded === "idle" || recorded === "unknown" ? recorded : "stopped";
  return { state, recorded };
}

/** One line on who receives answers here and in what recorded state, for the person's settings and status views. It says
 *  what's recorded, not that the agent is reading. */
export function describeDefaultReceiver(receiver: DefaultReceiver): string {
  const note = receiver.note ? `${receiver.note}. ` : "";
  if (!receiver.session) {
    return note + (receiver.state === "unknown"
      ? "OpenRig couldn't tell whether this host has a receiving agent: its seats couldn't be read."
      : `No receiving agent on this host: set one with rig config set agents.operator_session <seat>, or start the kernel (${KERNEL_OPERATOR_SESSION}).`);
  }
  const from = receiver.source === "setting" ? "chosen in agents.operator_session"
    : receiver.note ? "the kernel operator, used instead" : "the kernel operator, since agents.operator_session is unset";
  const state = receiver.state === "running" ? "its session is recorded as running"
    : receiver.state === "idle" ? "its session is recorded as idle"
      : receiver.state === "stopped" ? `its session is recorded as ${receiver.recorded}: answers wait for it, and nothing is decided meanwhile`
        : receiver.state === "missing" ? "no seat by that name on this host yet: answers wait until it exists"
          : receiver.recorded ? "its session's state is recorded as unknown: answers may wait"
            : "its seat couldn't be read: answers may wait";
  return `${note}${receiver.session}, ${from}; ${state}.`;
}

/** Who decides a runner's permission request once its person has answered, while the runner waits on it: the receiving
 *  agent, unless that's the requesting seat itself (blocked in the very turn that asked); else the kernel operator, when
 *  its seat is on this host and isn't the requester; else nobody, and OpenRig's default applies. Never the requester, and
 *  never a seat picked because it happens to be running. */
export function permissionDeciderFor(
  db: Database.Database,
  requester: string,
  configured: () => string | null | { session: string | null; problem?: string } = readReceivingAgentSetting,
): DefaultReceiver | null {
  const receiver = resolveDefaultReceiver(db, configured);
  // A seat this host doesn't have can't read anything: it isn't a decider (a stopped one is, and its delay is told).
  if (receiver.session && receiver.session !== requester && receiver.state !== "missing") return receiver;
  if (requester === KERNEL_OPERATOR_SESSION) return null;
  const kernel = seatState(db, KERNEL_OPERATOR_SESSION);
  if (kernel.state === "missing" || (kernel.state === "unknown" && !kernel.recorded)) return null;
  return { session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", ...kernel,
    // A setting that's set but ignored keeps saying so, rather than reading as unset.
    note: receiver.session ? `${receiver.session}, the receiving agent, ${receiver.session === requester ? "is the seat asking" : "isn't on this host"}` : receiver.note };
}
