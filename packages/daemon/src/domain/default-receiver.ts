import type Database from "better-sqlite3";
import { resolveRecoveryAgentSeat } from "./queue-owner.js";

/** The kernel's operator agent (pod operator, member agent): the receiving agent when none is set. */
export const KERNEL_OPERATOR_SESSION = "operator-agent@kernel";

export type DefaultReceiverSource = "setting" | "kernel-operator" | "none";
/** `missing`: no seat by that name on this host. `unknown`: the seat couldn't be read. Never a reason to pick another seat. */
export type ReceiverState = "running" | "stopped" | "missing" | "unknown";

/** The agent that receives what a person answers when nothing else reads it: requests with no owner of their own, such
 *  as a pairing request or a mode's scheduled end, and Slack messages no thread or channel route claims. */
export interface DefaultReceiver {
  session: string | null;
  source: DefaultReceiverSource;
  state: ReceiverState;
}

/** The chosen agent (`agents.operator_session`, an agent's canonical session), else the kernel operator when this host has
 *  its seat, else none. A stopped receiver stays the receiver: its answers wait for it, and its state says so. This never
 *  chooses whichever seat happens to be running, and never a person: the person's own address
 *  (`workspace.operator_seat_name`) is a separate setting. */
export function resolveDefaultReceiver(
  db: Database.Database,
  configured: () => string | null = resolveRecoveryAgentSeat,
): DefaultReceiver {
  const chosen = configured();
  if (chosen) return { session: chosen, source: "setting", state: seatState(db, chosen) };
  const kernel = seatState(db, KERNEL_OPERATOR_SESSION);
  if (kernel === "running" || kernel === "stopped") return { session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", state: kernel };
  return { session: null, source: "none", state: kernel };
}

function seatState(db: Database.Database, session: string): ReceiverState {
  try {
    const row = db.prepare("SELECT COUNT(*) AS seats, COALESCE(MAX(status = 'running'), 0) AS running FROM sessions WHERE session_name = ?")
      .get(session) as { seats: number; running: number };
    return row.running ? "running" : row.seats ? "stopped" : "missing";
  } catch {
    return "unknown";
  }
}

/** One line on who receives answers here and in what state, for the person's settings and status views. */
export function describeDefaultReceiver(receiver: DefaultReceiver): string {
  if (!receiver.session) {
    return receiver.state === "unknown"
      ? "OpenRig couldn't tell whether this host has a receiving agent."
      : `No receiving agent on this host: set one with rig config set agents.operator_session <seat>, or start the kernel (${KERNEL_OPERATOR_SESSION}).`;
  }
  const from = receiver.source === "setting" ? "chosen in agents.operator_session" : "the kernel operator, since agents.operator_session is unset";
  const state = receiver.state === "running" ? "running: it reads answers now"
    : receiver.state === "stopped" ? "stopped: answers wait for it, and nothing is decided meanwhile"
      : receiver.state === "missing" ? "no seat by that name on this host yet: answers wait until it exists"
        : "its state couldn't be read: answers may wait";
  return `${receiver.session}, ${from}; ${state}.`;
}
