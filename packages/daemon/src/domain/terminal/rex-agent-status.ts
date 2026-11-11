import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { AgentActivity } from "../types.js";

/**
 * Rex shows a block's agent and its state from OSC 7501 reports, but a Rex tile runs only `tmux attach`, and the agent
 * inside the seat's pane writes to OpenRig's tmux server, so Rex never sees its own reports. This relays the activity
 * OpenRig already resolves for a seat to the tiles that show it: each seat opened in a Rex tile gets tmux passthrough
 * and a marker on its pane, and its state is written to the pane's tty in tmux's passthrough envelope, which tmux hands
 * to every client attached to the pane. Terminals other than Rex ignore OSC 7501.
 */

/** The pane option that marks a seat as shown in a Rex tile; it outlives a daemon restart, as the tile does. */
export const REX_STATUS_MARKER = "@openrig-rex-status";

/** What a Rex tile is told about a seat: a state, or `clear` when OpenRig doesn't know it. */
export type RexAgentStatus = { state: "working" | "idle" | "blocked"; kind?: "permission" } | { state: "clear" };

/** The panes the relay reads and marks: the daemon's tmux adapter. */
export interface RexStatusPanes {
  getPaneLocalOption(target: string, option: string): Promise<string | null | undefined>;
  restorePaneOption(target: string, option: string, value: string | null): Promise<{ ok: boolean }>;
  getPaneTty(target: string): Promise<string | null>;
}

/** A seat's current activity and runtime, resolved the way `rig ps --nodes` resolves them; null when unknown. */
export type ResolveSeatActivity = (sessionName: string) => { activity: AgentActivity | null; runtime: string | null };

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

/** The OSC 7501 report, wrapped for tmux passthrough (each ESC inside doubled). */
export function rexStatusReport(status: RexAgentStatus, runtime: string | null): string | null {
  let fields: string;
  if (status.state === "clear") fields = "state=clear";
  else {
    if (!runtime) return null;
    fields = [`state=${status.state}`, `app=${rexApp(runtime)}`, ...(status.kind ? [`kind=${status.kind}`] : [])].join(":");
  }
  return `\x1bPtmux;\x1b\x1b]7501;${fields}\x1b\x1b\\\x1b\\`;
}

async function writeTty(tty: string, text: string): Promise<void> {
  // O_NOCTTY: the daemon never takes a seat's terminal as its own.
  const handle = await open(tty, constants.O_WRONLY | constants.O_NOCTTY);
  try { await handle.write(text); } finally { await handle.close(); }
}

export class RexAgentStatusRelay {
  private readonly panes: RexStatusPanes;
  private readonly resolve: ResolveSeatActivity;
  private readonly write: (tty: string, text: string) => Promise<void>;
  /** The last report per seat, so a seat is read and written only when what Rex should show changes. */
  private readonly last = new Map<string, string>();
  /** One report at a time per seat, so two quick changes reach the tile in order. */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(deps: { panes: RexStatusPanes; resolve: ResolveSeatActivity; writeTty?: (tty: string, text: string) => Promise<void> }) {
    this.panes = deps.panes;
    this.resolve = deps.resolve;
    this.write = deps.writeTty ?? writeTty;
  }

  /** Mark the seats a Rex view just opened and show each one's current state. A seat that can't be marked is skipped. */
  async tilesOpened(seats: string[]): Promise<void> {
    await Promise.all(seats.map(async (seat) => {
      const passthrough = await this.panes.restorePaneOption(seat, "allow-passthrough", "on");
      if (!passthrough.ok || !(await this.panes.restorePaneOption(seat, REX_STATUS_MARKER, "on")).ok) return;
      this.last.delete(seat);
      await this.report(seat, true);
    }));
  }

  /** The seat's activity may have changed. */
  async activityChanged(seat: string): Promise<void> {
    await this.report(seat, false);
  }

  private report(seat: string, opening: boolean): Promise<void> {
    const next = (this.pending.get(seat) ?? Promise.resolve()).then(() => this.reportNow(seat, opening)).catch(() => {});
    this.pending.set(seat, next);
    void next.then(() => { if (this.pending.get(seat) === next) this.pending.delete(seat); });
    return next;
  }

  private async reportNow(seat: string, opening: boolean): Promise<void> {
    const { activity, runtime } = this.resolve(seat);
    const status = rexAgentStatus(activity);
    // A tile that just opened has nothing to clear.
    if (opening && status.state === "clear") return;
    const report = rexStatusReport(status, runtime);
    if (!report || this.last.get(seat) === report) return;
    this.last.set(seat, report);
    if (!opening && await this.panes.getPaneLocalOption(seat, REX_STATUS_MARKER) !== "on") return;
    const tty = await this.panes.getPaneTty(seat);
    if (!tty) return;
    await this.write(tty, report).catch(() => this.last.delete(seat));
  }
}
