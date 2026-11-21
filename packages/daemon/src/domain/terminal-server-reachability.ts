/**
 * #3315 — whether the daemon can reach its tmux server, kept apart from whether the daemon itself is up.
 *
 * The tmux adapter already classifies a lost server ("no server running on …", or the socket missing or refusing
 * connections) as `transport_unavailable`: session existence NOT determined. Nothing remembered that answer, so every
 * watchdog, wake-ladder and sweep attempt found it out again, spent a retry and wrote events (31 h of that in the
 * issue). This tracker remembers it per server socket:
 *
 * - The loss and the return are recorded once each, when the state changes (an event, and a log line), never per
 *   attempt.
 * - While a server is unreachable, delivery to the seats it carries is held (`holds`, consulted through the queue's
 *   existing delivery hold, RigDeliveryDrainStore.holds): owed work stays owed and spends no attempt.
 * - The tracker notices the return on its own with a read-only probe on a backoff, and any probe the daemon makes
 *   for other reasons counts too. It never starts a server or a seat: a return is someone else's act (a launch, an
 *   operator, the init system).
 * - A return probe that can't be read (it throws, or answers nothing) is no evidence the server is still gone, nor
 *   that it is back: the reading becomes `unknown`, the loss is kept as history (`lastLoss`), and the hold ends, so
 *   ordinary delivery resumes. A later classified probe records the loss again, or the return.
 * - An unreachable server is not, by itself, evidence that a given session is gone: this record marks no seat missing,
 *   stopped or detached (the seat readings follow their own evidence). One unreachable socket holds only its own seats.
 * - Only a server some running seat depends on counts: tmux exits with its last session, so an absent server with no
 *   seat on it is the normal idle state, not a loss.
 * - Probes finish in any order. Each state of a socket has an epoch, and a probe carries the epoch it started in: a
 *   probe that started before the current loss, return or unknown reading can't end it or open another (its
 *   observation only refreshes the reading when it agrees).
 */

export type TerminalServerObservation =
  | { reachable: true }
  | { reachable: false; cause: string };

export interface TerminalServerState {
  /** The server's socket as the daemon addresses it (its `-S` path, or tmux's default socket). */
  socket: string;
  /** `unknown`: the last reading couldn't be made (a return probe that threw or answered nothing). Not held. */
  state: "reachable" | "unreachable" | "unknown";
  /** When the current state began. For a server never seen unreachable: the daemon's first observation of it. */
  since: string;
  /** The tmux diagnostic that showed the server unreachable, or why the reading is unknown; absent while reachable. */
  cause?: string;
  /** While unknown: the loss that was being watched when the reading stopped (history; it holds nothing). */
  lastLoss?: { since: string; cause?: string };
  lastCheckedAt: string;
  /** Changes since the daemon started (a flapping server shows here). */
  transitions: number;
}

export interface TerminalReachabilitySnapshot {
  /** `ok`: every observed server answers; `degraded`: at least one does not; `unknown`: none observed yet, or a
   *  server's last reading couldn't be made. */
  state: "ok" | "degraded" | "unknown";
  servers: TerminalServerState[];
}

export type TerminalServerChange =
  | { type: "tmux.server_gone"; socket: string; cause: string; since: string }
  | { type: "tmux.server_back"; socket: string; since: string; goneSince: string };

export interface TerminalServerReachabilityOptions {
  now?: () => Date;
  /** Called once per change, after the state is updated. */
  onChange?: (change: TerminalServerChange) => void;
  /** A read-only presence check of one server. It must never start a server. A thrown error or null is an unreadable
   *  probe: the reading becomes unknown and the hold ends (see the class comment). */
  probe?: (socket: string) => Promise<TerminalServerObservation | null>;
  /** Called once when an unreadable return probe ends a hold, after the state is updated (no event: nothing is
   *  proven). The daemon offers owed work again through the same pass as a return. */
  onUnknown?: (state: TerminalServerState) => void;
  /** First delay before probing an unreachable server again; doubles per failed probe. */
  probeIntervalMs?: number;
  /** Ceiling for that delay. */
  probeMaxIntervalMs?: number;
  /** Whether any seat depends on `socket` (a running tmux seat). A server that is absent while no seat runs on it is
   *  the normal state (tmux exits with its last session), not a loss: it is not recorded, and a recorded loss stops
   *  being watched once no seat depends on it. Absent: every socket counts. */
  watched?: (socket: string) => boolean;
}

export const TERMINAL_PROBE_INTERVAL_MS = 5_000;
export const TERMINAL_PROBE_MAX_INTERVAL_MS = 60_000;

export class TerminalServerReachability {
  private readonly servers = new Map<string, TerminalServerState>();
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; delayMs: number }>();
  /** The epoch of each socket's current state, new at every change of state (from one counter, so never reused): a
   *  probe's observation can change the state only when the probe started in the current epoch. */
  private readonly epochs = new Map<string, number>();
  private epochCounter = 0;
  private readonly now: () => Date;
  private stopped = false;

  constructor(private readonly opts: TerminalServerReachabilityOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /** The epoch `socket` is in now; a probe reads it when it starts and hands it back with its observation. */
  epoch(socket: string): number {
    return this.epochs.get(socket) ?? 0;
  }

  /** Record what a probe of `socket` showed. Only a change of state calls onChange. `startedIn` is the epoch the probe
   *  started in (absent: the observation is current): a probe that started before the current state can't change it. */
  observe(socket: string, observation: TerminalServerObservation, startedIn?: number): void {
    const at = this.now().toISOString();
    const current = this.servers.get(socket);
    const stale = startedIn !== undefined && startedIn !== this.epoch(socket);
    if (observation.reachable) {
      if (current?.state === "unreachable" || current?.state === "unknown") {
        if (stale) return; // an older probe's success: the loss (or unknown reading) began after it started
        // From unknown, the return closes the loss kept as history.
        const goneSince = current.state === "unknown" ? current.lastLoss?.since ?? current.since : current.since;
        this.servers.set(socket, { socket, state: "reachable", since: at, lastCheckedAt: at, transitions: current.transitions + 1 });
        this.newEpoch(socket);
        this.cancelProbe(socket);
        console.warn(`[tmux] The terminal server on ${socket} answers again (unreachable since ${goneSince}).`);
        this.opts.onChange?.({ type: "tmux.server_back", socket, since: at, goneSince });
        return;
      }
      this.servers.set(socket, current ? { ...current, lastCheckedAt: at }
        : { socket, state: "reachable", since: at, lastCheckedAt: at, transitions: 0 });
      return;
    }
    if (current?.state === "unreachable") {
      this.servers.set(socket, { ...current, cause: observation.cause, lastCheckedAt: at });
      return;
    }
    if (stale) return; // an older probe's failure: the return (or unknown reading) began after it started
    if (!this.isWatched(socket)) {
      if (current) this.servers.set(socket, { ...current, lastCheckedAt: at });
      return;
    }
    this.servers.set(socket, { socket, state: "unreachable", since: at, cause: observation.cause, lastCheckedAt: at,
      transitions: (current?.transitions ?? 0) + (current ? 1 : 0) });
    this.newEpoch(socket);
    console.warn(`[tmux] The terminal server on ${socket} cannot be reached (${observation.cause}). Automatic delivery to `
      + "its seats is held until it answers again; the daemon does not restart it.");
    this.opts.onChange?.({ type: "tmux.server_gone", socket, cause: observation.cause, since: at });
    this.scheduleProbe(socket, this.opts.probeIntervalMs ?? TERMINAL_PROBE_INTERVAL_MS);
  }

  /** The unreachable state of `socket`, or null while it answers or was never observed. */
  unreachable(socket: string): TerminalServerState | null {
    const state = this.servers.get(socket);
    return state?.state === "unreachable" ? { ...state } : null;
  }

  /** Whether any observed server is unreachable: the cheap check that comes before any per-seat lookup. */
  anyUnreachable(): boolean {
    for (const state of this.servers.values()) if (state.state === "unreachable") return true;
    return false;
  }

  snapshot(): TerminalReachabilitySnapshot {
    const servers = [...this.servers.values()].map(s => ({ ...s }));
    if (!servers.length) return { state: "unknown", servers };
    if (servers.some(s => s.state === "unreachable")) return { state: "degraded", servers };
    return { state: servers.some(s => s.state === "unknown") ? "unknown" : "ok", servers };
  }

  /** Stop the return probes (daemon shutdown). Observations still update the state. */
  stop(): void {
    this.stopped = true;
    for (const socket of [...this.timers.keys()]) this.cancelProbe(socket);
  }

  /** The epoch of the loss `socket` is in now, or undefined while it is not unreachable. */
  private currentLoss(socket: string): number | undefined {
    return this.servers.get(socket)?.state === "unreachable" ? this.epoch(socket) : undefined;
  }

  private newEpoch(socket: string): void {
    this.epochs.set(socket, ++this.epochCounter);
  }

  private isWatched(socket: string): boolean {
    try { return this.opts.watched ? this.opts.watched(socket) : true; } catch { return true; }
  }

  private cancelProbe(socket: string): void {
    const pending = this.timers.get(socket);
    if (pending) clearTimeout(pending.timer);
    this.timers.delete(socket);
  }

  private scheduleProbe(socket: string, delayMs: number): void {
    if (!this.opts.probe || this.stopped || this.timers.has(socket)) return;
    const timer = setTimeout(() => { void this.runProbe(socket, delayMs); }, delayMs);
    timer.unref?.();
    this.timers.set(socket, { timer, delayMs });
  }

  private async runProbe(socket: string, delayMs: number): Promise<void> {
    this.timers.delete(socket);
    const loss = this.currentLoss(socket);
    if (this.stopped || loss === undefined) return;
    let observation: TerminalServerObservation | null = null;
    let unreadable: string | null = null;
    try {
      observation = (await this.opts.probe?.(socket)) ?? null;
    } catch (error) {
      // The first line of what failed, past an exec error's "Command failed: …" wrapper line.
      const message = error instanceof Error ? error.message.replace(/^Command failed:[^\r\n]*\r?\n/, "") : String(error);
      unreadable = `the return probe failed: ${message.split(/\r?\n/, 1)[0]!.trim()}`;
    }
    // The result belongs to the loss the probe was checking. If that loss ended while it ran (a return, or a return
    // and a newer loss, recorded by any probe, this one's own observer included), the result is stale: it neither ends
    // the newer loss's hold nor applies an older failure over a return. A newer loss has its own return probe.
    if (this.currentLoss(socket) !== loss) return;
    const current = this.servers.get(socket)!;
    if (!observation) {
      // Neither loss nor return is proven: keep the loss as history, read as unknown, and stop holding. No event and
      // no more probing; the next classified probe (a delivery's, or any other) records what it finds.
      if (this.stopped) return;
      const at = this.now().toISOString();
      const state: TerminalServerState = { socket, state: "unknown", since: at,
        cause: unreadable ?? "the return probe answered nothing", lastCheckedAt: at, transitions: current.transitions + 1,
        lastLoss: { since: current.since, ...(current.cause ? { cause: current.cause } : {}) } };
      this.servers.set(socket, state);
      this.newEpoch(socket);
      console.warn(`[tmux] The terminal server on ${socket} can't be read (${state.cause}); it was unreachable since `
        + `${current.since}. Automatic delivery to its seats is no longer held; the server is not known to be back.`);
      try { this.opts.onUnknown?.({ ...state }); } catch { /* reporting only */ }
      return;
    }
    this.observe(socket, observation, loss);
    if (this.servers.get(socket)?.state === "unreachable" && !this.isWatched(socket)) {
      // Its seats were stopped or detached meanwhile: an absent server with no seat on it is not a loss any more.
      this.servers.delete(socket);
      this.newEpoch(socket);
      console.warn(`[tmux] No running seat is on ${socket} any more; the daemon stops watching that server.`);
      return;
    }
    if (this.servers.get(socket)?.state === "unreachable") {
      this.scheduleProbe(socket, Math.min(delayMs * 2, this.opts.probeMaxIntervalMs ?? TERMINAL_PROBE_MAX_INTERVAL_MS));
    }
  }
}
