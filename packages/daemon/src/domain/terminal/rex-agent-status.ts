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

/** A seat's activity and runtime at one reading. */
export interface SeatActivity { activity: AgentActivity | null; runtime: string | null }

/** A seat's current activity and runtime, resolved the way `rig ps --nodes` resolves them. */
export type ResolveSeatActivity = (sessionName: string) => SeatActivity;

/** The Rex state for an OpenRig activity; unknown becomes `clear`, never idle. */
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

/** The OSC 7501 report for a status; a state with no runtime to name is a `clear`, so no earlier state lingers. */
export function rexStatusReport(status: RexAgentStatus, runtime: string | null): string {
  const fields = status.state === "clear" || !runtime
    ? "state=clear"
    : [`state=${status.state}`, `app=${rexApp(runtime)}`, ...(status.kind ? [`kind=${status.kind}`] : [])].join(":");
  return `\x1b]7501;${fields}\x1b\\`;
}


const isRex = (termtype: string): boolean => /^rex\b/i.test(termtype);

/** How long a seat found without a Rex client is left alone before it is looked at again, so a Rex client attached
 *  by hand, or by Rex after an app restart, is still found. */
export const REX_CLIENT_RECHECK_MS = 5 * 60_000;
/** How often a seat with Rex clients is looked at again without an activity change: to reach a newly attached
 *  client and to retry a report a client missed. Within it, an unchanged report costs no tmux call. */
export const REX_CLIENT_REFRESH_MS = 5_000;

/** String Terminator: closes an OSC a partial write left open, and does nothing otherwise. */
const ST = "\x1b\\";

/** Writes to a terminal and returns how many bytes went out. */
async function writeTty(tty: string, text: string): Promise<number> {
  // O_NOCTTY: never take the client's terminal as the daemon's own. O_NONBLOCK: a stalled terminal drops the report
  // instead of holding the seat's later reports behind it.
  const handle = await open(tty, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
  try {
    return (await handle.write(text)).bytesWritten;
  } finally {
    await handle.close();
  }
}

/** A seat with Rex clients: the report each client last took ("" when that isn't known, such as a client this relay
 *  hasn't written to since the daemon started or since it moved from another seat), and when the clients were last
 *  listed. */
interface ShownSeat { delivered: Map<string, string>; listedAt: number }

export class RexAgentStatusRelay {
  private readonly clients: RexStatusClients;
  private readonly resolve: ResolveSeatActivity;
  private readonly write: (tty: string, text: string) => Promise<number>;
  private readonly now: () => number;
  private readonly sweeps: boolean;
  private readonly shown = new Map<string, ShownSeat>();
  /** When a seat was last found without a Rex client. */
  private readonly unshownAt = new Map<string, number>();
  /** Terminals a partial write left inside an unfinished OSC. */
  private readonly dangling = new Set<string>();
  /** The seat each terminal was last written for, so a seat whose terminal another seat wrote to since sends again. */
  private readonly lastWriter = new Map<string, string>();
  /** One report at a time per seat, so two quick changes reach the tile in order. */
  private readonly pending = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(deps: {
    clients: RexStatusClients; resolve: ResolveSeatActivity; writeTty?: (tty: string, text: string) => Promise<number>; now?: () => number;
    /** False keeps the periodic sweep off; tests call sweep() themselves. */
    sweep?: boolean;
  }) {
    this.clients = deps.clients;
    this.resolve = deps.resolve;
    this.write = deps.writeTty ?? writeTty;
    this.now = deps.now ?? Date.now;
    this.sweeps = deps.sweep ?? true;
  }

  /** A Rex view just opened these seats' tiles: show each one's current state. */
  async tilesOpened(seats: string[]): Promise<void> {
    await Promise.all(seats.map((seat) => this.report(seat, { opening: true })));
  }

  /** The seat's activity may have changed; `current` is its activity when the caller already resolved it. */
  activityChanged(seat: string, current?: SeatActivity): Promise<void> {
    return this.report(seat, { current });
  }

  /** Look again, with no activity change, at seats whose clients are due a listing: retries, new clients, rechecks. */
  async sweep(): Promise<void> {
    const now = this.now();
    const due = [
      ...[...this.shown].filter(([, s]) => now - s.listedAt >= REX_CLIENT_REFRESH_MS).map(([seat]) => seat),
      ...[...this.unshownAt].filter(([, at]) => now - at >= REX_CLIENT_RECHECK_MS).map(([seat]) => seat),
    ];
    await Promise.all(due.map((seat) => this.report(seat, {})));
  }

  /** Stop the periodic sweep. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private report(seat: string, opts: { opening?: boolean; current?: SeatActivity }): Promise<void> {
    const next = (this.pending.get(seat) ?? Promise.resolve()).then(() => this.reportNow(seat, opts)).catch(() => {});
    this.pending.set(seat, next);
    void next.then(() => { if (this.pending.get(seat) === next) this.pending.delete(seat); });
    return next;
  }

  private async reportNow(seat: string, { opening = false, current }: { opening?: boolean; current?: SeatActivity }): Promise<void> {
    const now = this.now();
    const unshown = this.unshownAt.get(seat);
    if (!opening && unshown !== undefined && now - unshown < REX_CLIENT_RECHECK_MS) return;
    // Inside the queue, so a report still in flight can't record a delivery the opening has to repeat.
    if (opening) for (const [tty] of this.shown.get(seat)?.delivered ?? []) this.shown.get(seat)!.delivered.set(tty, "");

    const { activity, runtime } = current ?? this.resolve(seat);
    const status = rexAgentStatus(activity);
    const report = rexStatusReport(status, runtime);
    const known = this.shown.get(seat);
    const hasIt = (tty: string, delivered: string) => delivered === report && this.lastWriter.get(tty) === seat;
    const everyClientHasIt = known !== undefined && known.delivered.size > 0 && [...known.delivered].every(([tty, r]) => hasIt(tty, r));
    if (everyClientHasIt && now - known.listedAt < REX_CLIENT_REFRESH_MS) return;

    const clients = await this.clients.listSessionClientTerminals(seat);
    // tmux couldn't be read: the sweep tries again, without deciding the seat has no Rex client.
    if (clients === null) {
      if (!known) this.shown.set(seat, { delivered: new Map(), listedAt: now });
      this.unshownAt.delete(seat);
      this.startSweeping();
      return;
    }
    const ttys = clients.filter((c) => isRex(c.termtype)).map((c) => c.tty);
    if (ttys.length === 0) {
      this.shown.delete(seat);
      this.unshownAt.set(seat, now);
      this.startSweeping();
      return;
    }
    this.unshownAt.delete(seat);
    const seatState: ShownSeat = known ?? { delivered: new Map(), listedAt: now };
    seatState.listedAt = now;
    for (const tty of [...seatState.delivered.keys()]) if (!ttys.includes(tty)) seatState.delivered.delete(tty);
    this.shown.set(seat, seatState);
    this.startSweeping();

    // A client with no record here may still show what this relay told it before a daemon restart, or another seat's
    // state, so it gets the current report, a clear included.
    const targets = ttys.filter((tty) => !hasIt(tty, seatState.delivered.get(tty) ?? ""));
    await Promise.all(targets.map(async (tty) => {
      try {
        const text = this.dangling.has(tty) ? ST + report : report;
        this.lastWriter.set(tty, seat);
        const written = await this.write(tty, text);
        if (written > 0) this.dangling.delete(tty);
        if (written !== Buffer.byteLength(text)) {
          if (written > 0) this.dangling.add(tty);
          throw new Error(`wrote ${written} of ${Buffer.byteLength(text)} bytes`);
        }
        seatState.delivered.set(tty, report);
      } catch {
        // What it shows is now unknown, so the next look sends it the current report, whatever that is.
        seatState.delivered.set(tty, "");
      }
    }));
  }

  private startSweeping(): void {
    if (this.stopped || this.timer || !this.sweeps) return;
    this.timer = setInterval(() => { void this.sweep(); }, REX_CLIENT_REFRESH_MS);
    this.timer.unref?.();
  }
}
