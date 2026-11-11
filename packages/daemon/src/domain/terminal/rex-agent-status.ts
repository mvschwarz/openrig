import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { AgentActivity } from "../types.js";

/**
 * Rex shows a block's agent and its state from OSC 7501 reports, but a Rex tile runs only `tmux attach`, and the agent
 * inside the seat's pane writes to OpenRig's tmux server, so Rex never sees its own reports. This relays the activity
 * OpenRig already resolves for a seat straight to the tmux clients attached to the seat's session that identify as
 * Rex (their XTVERSION reply), leaving tmux options and other terminals alone.
 */

/** What a Rex tile is told about a seat: a state, or `clear` when OpenRig doesn't know it. */
export type RexAgentStatus = { state: "working" | "idle" | "blocked"; kind?: "permission" } | { state: "clear" };

/** The daemon's tmux adapter, as far as the relay uses it. */
export interface RexStatusClients {
  listSessionClientTerminals(session: string): Promise<Array<{ tty: string; termtype: string }> | null>;
}

export interface SeatActivity { activity: AgentActivity | null; runtime: string | null }

/** A seat's current activity and runtime, resolved the way `rig ps --nodes` resolves them. */
export type ResolveSeatActivity = (sessionName: string) => SeatActivity;

export function rexAgentStatus(activity: AgentActivity | null): RexAgentStatus {
  switch (activity?.state) {
    case "running": return { state: "working" };
    case "idle": return { state: "idle" };
    case "needs_input": return activity.reason === "permission_prompt" ? { state: "blocked", kind: "permission" } : { state: "blocked" };
    default: return { state: "clear" };
  }
}

/** The runtime as Rex names the app; a runtime it doesn't know is passed as OpenRig names it. */
const rexApp = (runtime: string): string => runtime.replace(/[^A-Za-z0-9_.+-]/g, "-").slice(0, 32);

export function rexStatusReport(status: RexAgentStatus, runtime: string | null): string | null {
  let fields: string;
  if (status.state === "clear") fields = "state=clear";
  else {
    if (!runtime) return null;
    fields = [`state=${status.state}`, `app=${rexApp(runtime)}`, ...(status.kind ? [`kind=${status.kind}`] : [])].join(":");
  }
  return `\x1b]7501;${fields}\x1b\\`;
}

const isRex = (termtype: string): boolean => /^rex\b/i.test(termtype);

/** How long a seat found without a Rex client is left alone, so a Rex client attached by hand, or by Rex after an app
 *  restart, is still found. */
export const REX_CLIENT_RECHECK_MS = 5 * 60_000;

async function writeTty(tty: string, text: string): Promise<void> {
  // O_NOCTTY: never take the client's terminal as the daemon's own. O_NONBLOCK: a stalled terminal drops the report
  // instead of holding the seat's later reports behind it.
  const handle = await open(tty, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
  try { await handle.write(text); } finally { await handle.close(); }
}

export class RexAgentStatusRelay {
  private readonly clients: RexStatusClients;
  private readonly resolve: ResolveSeatActivity;
  private readonly write: (tty: string, text: string) => Promise<void>;
  /** The last report delivered per seat, so a seat is written only when what Rex should show changes. */
  private readonly last = new Map<string, string>();
  /** When a seat was last found without a Rex client. Such a seat isn't looked at again until a Rex view opens it or
   *  REX_CLIENT_RECHECK_MS passes. */
  private readonly unshownAt = new Map<string, number>();
  private readonly now: () => number;
  /** One report at a time per seat, so two quick changes reach the tile in order. */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(deps: {
    clients: RexStatusClients; resolve: ResolveSeatActivity; writeTty?: (tty: string, text: string) => Promise<void>; now?: () => number;
  }) {
    this.clients = deps.clients;
    this.now = deps.now ?? Date.now;
    this.resolve = deps.resolve;
    this.write = deps.writeTty ?? writeTty;
  }

  /** A Rex view just opened these seats' tiles: show each one's current state. */
  async tilesOpened(seats: string[]): Promise<void> {
    await Promise.all(seats.map((seat) => {
      this.unshownAt.delete(seat);
      this.last.delete(seat);
      return this.report(seat, true);
    }));
  }

  /** The seat's activity may have changed; `current` is its activity when the caller already resolved it. */
  activityChanged(seat: string, current?: SeatActivity): Promise<void> {
    const unshown = this.unshownAt.get(seat);
    if (unshown !== undefined && this.now() - unshown < REX_CLIENT_RECHECK_MS) return Promise.resolve();
    return this.report(seat, false, current);
  }

  private report(seat: string, opening: boolean, current?: SeatActivity): Promise<void> {
    const next = (this.pending.get(seat) ?? Promise.resolve()).then(() => this.reportNow(seat, opening, current)).catch(() => {});
    this.pending.set(seat, next);
    void next.then(() => { if (this.pending.get(seat) === next) this.pending.delete(seat); });
    return next;
  }

  private async reportNow(seat: string, opening: boolean, current?: SeatActivity): Promise<void> {
    const { activity, runtime } = current ?? this.resolve(seat);
    const status = rexAgentStatus(activity);
    // A tile that just opened has nothing to clear.
    if (opening && status.state === "clear") return;
    const report = rexStatusReport(status, runtime);
    if (!report || this.last.get(seat) === report) return;
    const clients = await this.clients.listSessionClientTerminals(seat);
    // tmux couldn't be read: try again on the next reading, without deciding the seat has no Rex client.
    if (clients === null) return;
    const ttys = clients.filter((c) => isRex(c.termtype)).map((c) => c.tty);
    if (ttys.length === 0) {
      this.unshownAt.set(seat, this.now());
      this.last.delete(seat);
      return;
    }
    this.unshownAt.delete(seat);
    // Recorded only when every Rex client took it, so a client that missed it gets it on the next reading.
    const written = await Promise.all(ttys.map((tty) => this.write(tty, report).then(() => true, () => false)));
    if (written.every(Boolean)) this.last.set(seat, report);
  }
}
