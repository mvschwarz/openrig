// Slice 13: delivery to an opted-in Claude seat through its launch-owned hook bridge. The seat's launch adds a
// SessionStart and a Stop hook with `asyncRewake` that each run one waiter for the seat, and a quick UserPromptSubmit
// marker. A waiter arms with the daemon, polls for the seat's queued messages, writes them to the hook's output and
// exits 2, which wakes Claude with them in its context at a turn boundary. OpenRig never types into the composer or a
// dialog on this path.
//
// The bridge is one branch inside the existing delivery owner (SessionTransport, under the seat's guard lease): the
// typing guard's hold and levels decide first, and the queued messages are outbox rows in send order. Each poll checks
// again that the seat is still opted in, that a row was queued for the arm's own occupant, and that the guard doesn't hold
// it now; a row the bridge can't deliver goes to typed delivery, where the guard decides. A waiter's ack records that it
// handed the message to Claude's hook, not that Claude read or acted on it. A seat whose bridge has no live arm (never
// armed, expired, its waiter gone, or a turn past its bound) gets today's typed delivery, with a warning.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type Database from "better-sqlite3";
import { OutboxHandler } from "./outbox-handler.js";
import type { RigEvent } from "./types.js";
import type { AdmissionInput } from "./seat-delivery-guard.js";
import type { QueueWakeFacts } from "./draft-aware-delivery.js";

/** The hooks' `timeout` (seconds): past an hour idle, so a waiter stays armed through a long idle (7200 measured). */
export const HOOK_BRIDGE_TIMEOUT_SECONDS = 7200;
/** A waiter exits by itself this long before its hook timeout and reports that it expired. */
export const HOOK_BRIDGE_EXPIRE_MARGIN_SECONDS = 120;
/** A waiter that hasn't polled within this bound isn't live; a message queued for a bridge with no live arm is typed
 *  after this long. */
export const HOOK_BRIDGE_LIVE_BOUND_MS = 20_000;
/** A turn the bridge waits on (a person's, its own wake's, or one in progress when the daemon restarted) is waited on for
 *  at most this long, whether or not a waiter is polling, before queued messages are typed. */
export const HOOK_BRIDGE_TURN_BOUND_MS = 15 * 60_000;
/** The first Claude Code the launch adds the bridge's hooks for. Its changelog fixes `asyncRewake` hooks in 2.1.287, so
 *  they exist by then; 2.1.306's and 2.1.322's own hook schemas carry `asyncRewake`. An older or unknown Claude keeps
 *  typed delivery. */
export const HOOK_BRIDGE_MIN_CLAUDE = "2.1.287";
export const HOOK_BRIDGE_CHANNEL = "hook-bridge";
/** The actor recorded for a change made from a terminal with no seat identity, as the typing guard records it. */
export const UNATTRIBUTED_ACTOR = "unattributed (no seat identity)";

export interface HookBridgeTarget { nodeId: string; session: string; occupant: string | null; pane: string | null }

export interface HookBridgePreference {
  desired: boolean;
  actor: string;
  reason: string;
  changedAt: string;
  /** The occupant generation whose waiter last armed: proof that occupant was launched with the bridge's hooks. */
  armedGeneration: string | null;
  armedAt: string | null;
}

export interface HookBridgeMessage { outboxId: string; text: string; senderSession: string }
/** What the guard's admission was told about a send, kept with its queued row so a poll can ask the guard again. */
export type HookBridgeAdmission = AdmissionInput;

type Turn = "idle" | "user" | "woken" | "unknown";
interface Arm { armId: string; generation: string | null; hookEvent: string; armedAt: number; lastPollAt: number }
/** `wakePrompt`: a wake was handed over and Claude hasn't yet reported its input's prompt (UserPromptSubmit), which
 *  belongs to the turn the wake started. */
interface SeatState { arm: Arm | null; turn: Turn; turnSince: number; wakes: number; expiredAt: number | null; wakePrompt: boolean }

/** What the bridge recorded for a queued message, in its outbox row's guard_delivery. */
interface BridgeReceipt {
  channel: typeof HOOK_BRIDGE_CHANNEL;
  state: "queued" | "claimed" | "handed-to-hook" | "claimed-unacked" | "not-delivered";
  queuedAt: string;
  admission?: HookBridgeAdmission;
  /** An automatic delivery (a queue wake that wasn't sent explicitly): a rig's delivery drain holds it, as it holds the
   *  typed path's. A direct send isn't automatic, and passes a drain as a typed direct send does. */
  automatic?: boolean;
  armId?: string;
  batchId?: string;
  claimedAt?: string;
  hookEvent?: string;
  ackedAt?: string;
}
interface QueuedRow { outboxId: string; body: string; senderSession: string; sessionName: string; auditPointer: string | null; queuedAt: string;
  occupant: string | null; admission: HookBridgeAdmission | null; automatic: boolean }

export type HookBridgeEvent = Extract<RigEvent, { type: `transport.hook_bridge_${string}` }>;

/** How a queued message ended at the bridge, for the row that sent it (a queue wake's nudge record reads it). `typed`
 *  carries the typed fallback's own result. */
export interface HookBridgeEnd {
  outboxId: string;
  auditPointer: string | null;
  kind: "handed-to-hook" | "typed" | "not-delivered" | "claimed-unacked";
  result?: { ok: boolean; outcome?: string; verified?: boolean; sent?: boolean; inputPhase?: string; reason?: string; error?: string };
  reason?: string;
}

export class HookBridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A Claude executable's version from `<executable> --version`, or null. It runs off the daemon's event loop. */
function claudeVersion(executable: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(executable, ["--version"], { encoding: "utf8", timeout: 5000 }, (_error, stdout) => resolve(/(\d+\.\d+\.\d+)/.exec(`${stdout ?? ""}`)?.[1] ?? null));
    } catch { resolve(null); }
  });
}

/** Which file an executable names now (resolved on PATH when it's a bare name), with its size and change time, so a
 *  replaced Claude is read again; null when it can't be found. */
function executableStamp(executable: string): string | null {
  const candidates = isAbsolute(executable) || executable.includes("/") ? [executable]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, executable));
  for (const path of candidates) {
    try { const st = statSync(path); if (st.isFile()) return `${path}:${st.size}:${st.mtimeMs}:${st.ino}`; } catch { /* not here */ }
  }
  return null;
}
const atLeast = (version: string, min: string) => {
  const [a, b] = [version, min].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (a![i]! !== b![i]!) return a![i]! > b![i]!;
  return true;
};

export class HookBridge {
  private readonly seats = new Map<string, SeatState>();
  /** Each executable's version, by the file it named when read: a replaced Claude is read again. */
  private readonly versions = new Map<string, Promise<string | null>>();
  private readonly launchNotes = new Map<string, string>();
  private readonly now: () => number;
  /** Told how each queued message ended at the bridge; startup points a queue wake's end at its queue row. */
  onEnd?: (end: HookBridgeEnd) => void;
  /** Whether a queue wake still applies (QueueRepository's current-wake predicate, which the typed path also checks):
   *  set by the transport when the queue attaches. */
  wakeApplicable?: (entries: readonly QueueWakeFacts[]) => boolean;

  constructor(readonly db: Database.Database, private readonly deps: {
    now?: () => number;
    emit?: (event: HookBridgeEvent) => void;
    /** Whether the seat's typing guard would hold this send now (SeatDeliveryGuard.holdsInput). */
    holds?: (nodeId: string, admission: HookBridgeAdmission) => boolean;
    /** The Claude version an executable reports; defaults to running `<executable> --version`, off the event loop. */
    version?: (executable: string) => string | null | Promise<string | null>;
    /** What identifies the file an executable names now; a changed stamp reads the version again. */
    stamp?: (executable: string) => string | null;
    /** Runs `fn` under the seat's delivery lease (SeatDeliveryGuard.exclusive), the same owner typed sends take. */
    lease?: <T>(nodeId: string, fn: () => T) => Promise<T>;
    /** Whether the seat's rig is in a delivery drain (the queue's deliveryDrains.holds). */
    drained?: (sessionName: string) => boolean;
  } = {}) {
    this.now = deps.now ?? Date.now;
  }

  // -- The seat's preference ------------------------------------------------------------------------------------------

  preference(nodeId: string): HookBridgePreference | null {
    const row = this.db.prepare("SELECT desired, actor, reason, changed_at, armed_generation, armed_at FROM seat_hook_bridge WHERE node_id = ?")
      .get(nodeId) as { desired: number; actor: string; reason: string; changed_at: string; armed_generation: string | null; armed_at: string | null } | undefined;
    return row ? { desired: row.desired === 1, actor: row.actor, reason: row.reason, changedAt: row.changed_at,
      armedGeneration: row.armed_generation, armedAt: row.armed_at } : null;
  }

  /** Opt a seat in or out. It takes effect at the seat's next launch or restore: only a launch adds the hooks. A change
   *  from a terminal with no seat identity is recorded as unattributed. */
  setPreference(nodeId: string, desired: boolean, actor: string | null, reason: string): HookBridgePreference {
    if (!reason.trim()) throw new HookBridgeError("hook_bridge_reason_required", "A reason is required.");
    const who = actor?.trim() || UNATTRIBUTED_ACTOR;
    const at = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO seat_hook_bridge (node_id, desired, actor, reason, changed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET desired = excluded.desired, actor = excluded.actor, reason = excluded.reason, changed_at = excluded.changed_at`)
        .run(nodeId, desired ? 1 : 0, who, reason, at);
      this.db.prepare("INSERT INTO seat_hook_bridge_changes (node_id, desired, actor, reason, changed_at) VALUES (?, ?, ?, ?, ?)")
        .run(nodeId, desired ? 1 : 0, who, reason, at);
    })();
    return this.preference(nodeId)!;
  }

  async claudeVersionFor(executable = "claude"): Promise<string | null> {
    const key = `${executable}\0${(this.deps.stamp ?? executableStamp)(executable) ?? ""}`;
    if (!this.versions.has(key)) this.versions.set(key, Promise.resolve((this.deps.version ?? claudeVersion)(executable)).catch(() => null));
    const version = await this.versions.get(key)!;
    // An unreadable version (a timed-out probe under load, say) is read again at the next launch.
    if (version === null) this.versions.delete(key);
    return version;
  }

  /** Whether this Claude launch adds the bridge's hooks: the seat opted in, and its Claude is one with `asyncRewake`
   *  (HOOK_BRIDGE_MIN_CLAUDE or later). Otherwise the launch is unchanged and delivery stays typed; the status says why. */
  async launchWanted(nodeId: string, executable = "claude"): Promise<boolean> {
    this.launchNotes.delete(nodeId);
    if (this.preference(nodeId)?.desired !== true) return false;
    const version = await this.claudeVersionFor(executable);
    if (version && atLeast(version, HOOK_BRIDGE_MIN_CLAUDE)) return true;
    this.launchNotes.set(nodeId, version
      ? `Claude Code ${version} is older than ${HOOK_BRIDGE_MIN_CLAUDE}, the first with the bridge's asyncRewake hooks: launched without them, delivery stays typed.`
      : `Claude Code's version couldn't be read (${executable} --version): launched without the bridge's hooks, delivery stays typed.`);
    return false;
  }

  /** Whether a send to this occupant goes through its bridge: opted in, and this occupant's own waiter has armed. */
  routes(target: HookBridgeTarget): boolean {
    const pref = this.preference(target.nodeId);
    return pref?.desired === true && pref.armedGeneration !== null && pref.armedGeneration === target.occupant;
  }

  /** Whether the bridge can take a message now: a waiter polled within the bound and its seat is idle or its turn is
   *  within the turn bound; or no waiter polls and the seat is in a turn the bridge waits on, within the turn bound. */
  live(nodeId: string): boolean {
    const seat = this.seats.get(nodeId);
    if (!seat) return false;
    const now = this.now();
    const turnWithinBound = now - seat.turnSince < HOOK_BRIDGE_TURN_BOUND_MS;
    if (seat.arm && now - seat.arm.lastPollAt < HOOK_BRIDGE_LIVE_BOUND_MS && (seat.turn === "idle" || turnWithinBound)) return true;
    return (seat.turn === "woken" || seat.turn === "unknown") && turnWithinBound;
  }

  /** Why the bridge can't take a message now, for the fallback's warning. */
  unavailable(nodeId: string): string {
    const seat = this.seats.get(nodeId);
    if (!seat) return "its waiter hasn't armed since the daemon started";
    const now = this.now();
    if (seat.expiredAt !== null && !seat.arm) return `its waiter expired at ${new Date(seat.expiredAt).toISOString()} and no turn has re-armed it`;
    if (seat.arm && now - seat.arm.lastPollAt >= HOOK_BRIDGE_LIVE_BOUND_MS) return `its waiter hasn't polled for ${Math.round((now - seat.arm.lastPollAt) / 1000)} s`;
    if (seat.turn !== "idle" && now - seat.turnSince >= HOOK_BRIDGE_TURN_BOUND_MS) {
      return `the turn it's waiting on began ${Math.round((now - seat.turnSince) / 60_000)} min ago, past the ${HOOK_BRIDGE_TURN_BOUND_MS / 60_000}-minute bound, with no turn boundary since`;
    }
    return `no waiter has armed since a turn began ${Math.round((now - seat.turnSince) / 1000)} s ago`;
  }

  // -- The transport's side -----------------------------------------------------------------------------------------

  /** Queue a send for the seat's bridge: outbox rows in send order, bound to the occupant, with the admission the guard
   *  decided on, delivered at its next turn boundary. Called under the seat's guard lease. */
  deposit(target: HookBridgeTarget, sessionName: string, text: string, opts: { actorSession?: string | null; auditPointer?: string; urgent?: unknown;
    identityProvenance?: string | null; identityPrincipal?: string | null; admission?: HookBridgeAdmission; queueWake?: boolean; drainExempt?: boolean }, ids: string[]) {
    const outbox = new OutboxHandler(this.db);
    const queuedAt = new Date(this.now()).toISOString();
    const receipt: BridgeReceipt = { channel: HOOK_BRIDGE_CHANNEL, state: "queued", queuedAt, ...(opts.admission ? { admission: opts.admission } : {}),
      ...(opts.queueWake && !opts.drainExempt ? { automatic: true } : {}) };
    // An id already settled (delivered, failed, held elsewhere) isn't queued again, and isn't reported queued: null, and
    // nothing changed, so the send takes the path a reused id takes without the bridge.
    const settled = this.db.prepare("SELECT 1 FROM outbox_entries WHERE outbox_id = ? AND delivery_state NOT IN ('pending', 'sending')");
    if (ids.some((id) => settled.get(id))) return null;
    this.db.transaction(() => {
      for (const id of ids) {
        outbox.record({ outboxId: id, senderSession: opts.actorSession ?? "unknown", destinationSession: sessionName, body: text,
          urgency: opts.urgent ? "urgent" : "routine", auditPointer: opts.auditPointer, identityProvenance: opts.identityProvenance, identityPrincipal: opts.identityPrincipal });
        // A row already settled (delivered, failed, held elsewhere) is never queued again.
        this.db.prepare("UPDATE outbox_entries SET delivery_state = 'sending', guard_binding = ?, guard_delivery = ? WHERE outbox_id = ? AND delivery_state IN ('pending', 'sending')")
          .run(JSON.stringify(target), JSON.stringify(receipt), id);
      }
    })();
    return {
      ok: true as const, sessionName, outcome: "bridged" as const, sent: false, verified: false, inputPhase: "not_reached" as const, outboxIds: ids,
      warning: `Queued for ${sessionName}'s hook bridge: it is handed to the seat's context at its next turn boundary, as one model turn on the seat's own login. Handed over is not read or acted on; the seat's own reply or row says that.`,
    };
  }

  /** The seat's queued messages, oldest first. */
  queued(nodeId: string): QueuedRow[] {
    const rows = this.db.prepare(`SELECT outbox_id, body, sender_session, destination_session, audit_pointer, guard_binding, guard_delivery FROM outbox_entries
      WHERE delivery_state = 'sending' AND guard_binding IS NOT NULL AND json_extract(guard_binding, '$.nodeId') = ?
        AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'queued'
      ORDER BY ts_dispatched, rowid`).all(nodeId, HOOK_BRIDGE_CHANNEL) as Array<{ outbox_id: string; body: string; sender_session: string; destination_session: string;
        audit_pointer: string | null; guard_binding: string; guard_delivery: string }>;
    return rows.map((r) => {
      const receipt = JSON.parse(r.guard_delivery) as BridgeReceipt;
      return { outboxId: r.outbox_id, body: r.body, senderSession: r.sender_session, sessionName: r.destination_session, auditPointer: r.audit_pointer, queuedAt: receipt.queuedAt,
        occupant: (JSON.parse(r.guard_binding) as HookBridgeTarget).occupant ?? null, admission: receipt.admission ?? null, automatic: receipt.automatic === true };
    });
  }

  /** Whether a rig's delivery drain holds this queued row now: an automatic delivery to a seat whose rig is drained. A
   *  drain read that fails delivers and says so, as the drain's own admission does. */
  private drainHolds(row: QueuedRow): boolean {
    if (!row.automatic || !this.deps.drained) return false;
    try { return this.deps.drained(row.sessionName); } catch (error) {
      console.error(`[hook-bridge] ${row.sessionName}'s delivery drain couldn't be read; delivering:`, error);
      return false;
    }
  }

  /** An automatic wake whose queue row no longer wants it (claimed, closed, moved, superseded): the typed path refuses it
   *  (draft_wake_superseded), so the bridge ends it not delivered rather than hand it over. An explicit notice and a
   *  direct send aren't automatic, so this never applies to them. */
  private superseded(row: QueuedRow): boolean {
    if (!row.automatic || !this.wakeApplicable) return false;
    try { return !this.wakeApplicable([{ outboxId: row.outboxId, auditPointer: row.auditPointer, destinationSession: row.sessionName }]); }
    catch (error) {
      console.error(`[hook-bridge] ${row.sessionName}'s queue wake couldn't be read; delivering:`, error);
      return false;
    }
  }

  /** The seat's queued rows, oldest first, with superseded wakes ended (not delivered) and left out. */
  private current(nodeId: string): QueuedRow[] {
    return this.queued(nodeId).filter((row) => {
      if (!this.superseded(row)) return true;
      this.abandon(nodeId, row.sessionName, row.outboxId, "the queue wake no longer applies: its row was claimed, closed or moved on");
      return false;
    });
  }

  /** The queued messages a typed send may take now, oldest first: everything but what a delivery drain holds (and
   *  superseded wakes, which end). The rule the poll and the fallback both apply, for an on-demand sweep. */
  queuedForTyping(nodeId: string): string[] {
    return this.current(nodeId).filter((row) => !this.drainHolds(row)).map((row) => row.outboxId);
  }

  /** Checked again at the final handback, under the seat's lease, just before a typed fallback takes a row: whether a
   *  drain now holds it, or its wake no longer applies (then it's ended not delivered). Null to go ahead. */
  handbackRefusal(nodeId: string, outboxId: string): "drained" | "superseded" | null {
    const row = this.queued(nodeId).find((r) => r.outboxId === outboxId);
    if (!row) return null; // claimed or gone: the release decides
    if (this.superseded(row)) {
      this.abandon(nodeId, row.sessionName, outboxId, "the queue wake no longer applies: its row was claimed, closed or moved on");
      return "superseded";
    }
    return this.drainHolds(row) ? "drained" : null;
  }

  /** Why the bridge can't deliver this queued row to `generation` now, or null when it can. */
  private undeliverable(nodeId: string, row: QueuedRow, generation: string | null): string | null {
    if (this.preference(nodeId)?.desired !== true) return "the seat opted out of its hook bridge";
    if (row.occupant !== generation) return "it was queued for another occupant of the seat";
    if (row.admission && this.deps.holds?.(nodeId, row.admission)) return "the seat's typing guard holds it now";
    return null;
  }

  /** The queued messages the bridge can't deliver: rows it may never deliver (opted out, another occupant, held now) at
   *  once, and the rest once the seat has had no live arm for the bound. Oldest first per seat. */
  dueForFallback(): Array<{ nodeId: string; outboxIds: string[]; reason: string }> {
    const rows = this.db.prepare(`SELECT DISTINCT json_extract(guard_binding, '$.nodeId') AS node_id FROM outbox_entries
      WHERE delivery_state = 'sending' AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'queued'`)
      .all(HOOK_BRIDGE_CHANNEL) as Array<{ node_id: string }>;
    const due: Array<{ nodeId: string; outboxIds: string[]; reason: string }> = [];
    for (const { node_id: nodeId } of rows) {
      const generation = this.preference(nodeId)?.armedGeneration ?? null;
      const live = this.live(nodeId);
      const ids: string[] = [];
      let reason: string | null = null;
      for (const row of this.current(nodeId)) {
        // Held by the rig's delivery drain: not due, so not typed. What a drain doesn't hold (a direct send, an explicit
        // notice) passes it, in its own order, as on the typed path.
        if (this.drainHolds(row)) continue;
        const why = this.undeliverable(nodeId, row, generation);
        const stale = !live && this.now() - Date.parse(row.queuedAt) >= HOOK_BRIDGE_LIVE_BOUND_MS;
        if (!why && !stale) break; // keep send order: what's behind a deliverable row waits with it
        ids.push(row.outboxId);
        reason ??= why ?? this.unavailable(nodeId);
      }
      if (ids.length) due.push({ nodeId, outboxIds: ids, reason: reason! });
    }
    return due;
  }

  /** Hand one queued message to the typed send that is about to type it, under the seat's lease: the row stays `sending`
   *  under its own id, the typed send's now, so nothing else (the queue's drain, a poll) takes it meanwhile. True only
   *  when this call released it (it was still queued); false when the bridge claimed it first. */
  releaseForTyping(nodeId: string, sessionName: string, outboxId: string, reason: string): boolean {
    const released = this.db.prepare(`UPDATE outbox_entries SET guard_delivery = NULL
      WHERE outbox_id = ? AND delivery_state = 'sending' AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'queued'`)
      .run(outboxId, HOOK_BRIDGE_CHANNEL).changes === 1;
    if (released) this.deps.emit?.({ type: "transport.hook_bridge_fallback", nodeId, sessionName, outboxIds: [outboxId], reason });
    return released;
  }

  /** A queued message whose occupant is gone isn't typed into the seat's new one: it ends not delivered, and says why. */
  abandon(nodeId: string, sessionName: string, outboxId: string, reason: string): boolean {
    const ended = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'failed',
      guard_delivery = json_set(guard_delivery, '$.state', 'not-delivered', '$.reason', ?)
      WHERE outbox_id = ? AND delivery_state = 'sending' AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'queued'`)
      .run(reason, outboxId, HOOK_BRIDGE_CHANNEL).changes === 1;
    if (ended) {
      this.deps.emit?.({ type: "transport.hook_bridge_fallback", nodeId, sessionName, outboxIds: [outboxId], reason: `not delivered: ${reason}` });
      this.ended({ outboxId, kind: "not-delivered", reason });
    }
    return ended;
  }

  /** The typed fallback's result for a message the bridge handed back. */
  typedEnd(outboxId: string, result: NonNullable<HookBridgeEnd["result"]>): void {
    this.ended({ outboxId, kind: "typed", result });
  }

  private ended(end: Omit<HookBridgeEnd, "auditPointer">): void {
    if (!this.onEnd) return;
    const row = this.db.prepare("SELECT audit_pointer FROM outbox_entries WHERE outbox_id = ?").get(end.outboxId) as { audit_pointer: string | null } | undefined;
    try { this.onEnd({ ...end, auditPointer: row?.audit_pointer ?? null }); } catch { /* recording an end never fails delivery */ }
  }

  // -- The waiter's side --------------------------------------------------------------------------------------------

  /** A waiter arms at a turn boundary (SessionStart or Stop) or re-arms after the daemon restarted. A newer arm replaces
   *  the seat's previous one, whose waiter is told it was superseded at its next poll. A re-arm can't say whether a turn
   *  is running, so the turn reads unknown from then: within the turn bound. */
  arm(input: { nodeId: string; sessionName: string; generation: string | null; hookEvent: string; armId?: string }): { armId: string } {
    const armId = input.armId ?? `arm-${randomUUID()}`;
    const now = this.now();
    const seat = this.seat(input.nodeId);
    const boundary = input.hookEvent === "SessionStart" || input.hookEvent === "Stop";
    seat.arm = { armId, generation: input.generation, hookEvent: input.hookEvent, armedAt: now, lastPollAt: now };
    seat.turn = boundary ? "idle" : "unknown";
    seat.turnSince = now;
    seat.expiredAt = null;
    seat.wakePrompt = false;
    this.db.prepare("UPDATE seat_hook_bridge SET armed_generation = ?, armed_at = ? WHERE node_id = ?")
      .run(input.generation, new Date(now).toISOString(), input.nodeId);
    this.deps.emit?.({ type: "transport.hook_bridge_armed", nodeId: input.nodeId, sessionName: input.sessionName, armId, hookEvent: input.hookEvent, generation: input.generation });
    return { armId };
  }

  /** A person submitted a prompt: a turn is running, so the bridge holds messages until the turn's Stop re-arms (or the
   *  turn bound passes). Claude Code also reports the input a wake delivered as a prompt (2.1.322): that first one after a
   *  hand-over is the woken turn itself, which stays woken, so messages still wait for its end (#3270 round 9). */
  turnStarted(nodeId: string): void {
    const seat = this.seat(nodeId);
    if (seat.wakePrompt && seat.turn === "woken") { seat.wakePrompt = false; return; }
    seat.wakePrompt = false;
    seat.turn = "user";
    seat.turnSince = this.now();
  }

  /** A waiter's poll. Stop when the seat opted out; the batch this arm claimed but hasn't acked (its answer may have been
   *  lost) again; otherwise, at an idle turn boundary, claim the rows the bridge can deliver to this arm's occupant,
   *  oldest first, stopping at the first it can't (that one goes to typed delivery, and the rest keep their order). */
  poll(nodeId: string, armId: string): { action: "superseded" } | { action: "rearm" } | { action: "stop" } | { action: "wait" }
    | { action: "deliver"; batchId: string; messages: HookBridgeMessage[] } {
    const seat = this.seats.get(nodeId);
    if (!seat?.arm) return { action: "rearm" };
    if (seat.arm.armId !== armId) return { action: "superseded" };
    seat.arm.lastPollAt = this.now();
    if (this.preference(nodeId)?.desired !== true) return { action: "stop" };
    const again = this.claimedBy(nodeId, armId, seat.arm.generation);
    if (again) {
      // An operator's hold applied since the claim wins: the batch isn't handed out again, and since its first answer
      // may have reached the waiter, it isn't requeued either.
      const heldNow = again.rows.filter((r) => r.admission && this.deps.holds?.(nodeId, r.admission));
      if (!heldNow.length) return { action: "deliver", batchId: again.batchId, messages: again.messages };
      this.markUncertain(nodeId, again.sessionName, again.rows.map((r) => r.outboxId),
        "the seat's typing guard held it after its waiter took it; it may or may not have reached the seat, and the bridge doesn't resend it");
      return { action: "wait" };
    }
    if (seat.turn !== "idle") return { action: "wait" };
    const deliverable: QueuedRow[] = [];
    for (const row of this.current(nodeId)) {
      // A row the rig's delivery drain holds waits for the drain's end; what the drain doesn't hold passes it, in order.
      // One the bridge can't deliver goes to typed delivery, and what's behind it waits with it.
      if (this.drainHolds(row)) continue;
      if (this.undeliverable(nodeId, row, seat.arm.generation)) break;
      deliverable.push(row);
    }
    if (!deliverable.length) return { action: "wait" };
    const batchId = `batch-${randomUUID()}`;
    const claimedAt = new Date(this.now()).toISOString();
    const claim = this.db.prepare(`UPDATE outbox_entries SET guard_delivery = json_set(guard_delivery, '$.state', 'claimed', '$.armId', ?, '$.batchId', ?,
      '$.hookEvent', ?, '$.claimedAt', ?) WHERE outbox_id = ? AND delivery_state = 'sending' AND json_extract(guard_delivery, '$.state') = 'queued'`);
    const messages: HookBridgeMessage[] = [];
    this.db.transaction(() => {
      for (const m of deliverable) {
        if (claim.run(armId, batchId, seat.arm!.hookEvent, claimedAt, m.outboxId).changes !== 1) break;
        messages.push({ outboxId: m.outboxId, text: m.body, senderSession: m.senderSession });
      }
    })();
    return messages.length ? { action: "deliver", batchId, messages } : { action: "wait" };
  }

  /** The batch this seat's arm claimed for this occupant and hasn't acked, oldest first, or null. Scoped to the seat and
   *  occupant, so another seat naming the same arm id never gets it. */
  private claimedBy(nodeId: string, armId: string, generation: string | null): { batchId: string; sessionName: string; messages: HookBridgeMessage[];
    rows: Array<{ outboxId: string; admission: HookBridgeAdmission | null }> } | null {
    const rows = this.db.prepare(`SELECT outbox_id, body, sender_session, destination_session, guard_delivery, json_extract(guard_delivery, '$.batchId') AS batch_id FROM outbox_entries
      WHERE delivery_state = 'sending' AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'claimed'
        AND json_extract(guard_delivery, '$.armId') = ? AND json_extract(guard_binding, '$.nodeId') = ? AND json_extract(guard_binding, '$.occupant') IS ?
      ORDER BY ts_dispatched, rowid`).all(HOOK_BRIDGE_CHANNEL, armId, nodeId, generation) as Array<{ outbox_id: string; body: string; sender_session: string;
        destination_session: string; guard_delivery: string; batch_id: string }>;
    if (!rows.length) return null;
    const batchId = rows[0]!.batch_id;
    const batch = rows.filter((r) => r.batch_id === batchId);
    return { batchId, sessionName: batch[0]!.destination_session,
      messages: batch.map((r) => ({ outboxId: r.outbox_id, text: r.body, senderSession: r.sender_session })),
      rows: batch.map((r) => ({ outboxId: r.outbox_id, admission: (JSON.parse(r.guard_delivery) as BridgeReceipt).admission ?? null })) };
  }

  /** A waiter's poll, under the seat's delivery lease: it can't take a message while a typed send to the seat is under
   *  way, so a later message never reaches the seat before an earlier typed one. */
  pollUnderLease<R>(nodeId: string, armId: string, authorize?: () => R | null): Promise<ReturnType<HookBridge["poll"]> | { refused: R }> {
    // The caller's checks (its grant, the seat's occupant) are run again once the lease is held, right before the claim,
    // with nothing awaited in between: a poll that waited can't claim on authority it lost meanwhile.
    const claim = () => { const refused = authorize?.() ?? null; return refused !== null ? { refused } : this.poll(nodeId, armId); };
    return this.deps.lease ? this.deps.lease(nodeId, claim) : Promise.resolve(claim());
  }

  /** The waiter wrote a batch to its hook's output and is about to exit 2: each message was handed to Claude's hook. That
   *  isn't proof Claude read it, let alone acted on it: Claude Code reports nothing back. The turn the wake starts is one
   *  the bridge waits on. */
  ack(nodeId: string, sessionName: string, generation: string | null, armId: string, batchId: string): { outboxIds: string[] } {
    const ackedAt = new Date(this.now()).toISOString();
    const rows = this.db.prepare(`SELECT outbox_id FROM outbox_entries WHERE delivery_state = 'sending'
      AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'claimed'
      AND json_extract(guard_delivery, '$.batchId') = ? AND json_extract(guard_delivery, '$.armId') = ?
      AND json_extract(guard_binding, '$.nodeId') = ? AND json_extract(guard_binding, '$.occupant') IS ? ORDER BY ts_dispatched, rowid`)
      .all(HOOK_BRIDGE_CHANNEL, batchId, armId, nodeId, generation) as Array<{ outbox_id: string }>;
    if (!rows.length) return { outboxIds: [] };
    const done = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'delivered', delivered_at = ?,
      guard_delivery = json_set(guard_delivery, '$.state', 'handed-to-hook', '$.ackedAt', ?) WHERE outbox_id = ? AND delivery_state = 'sending'`);
    this.db.transaction(() => { for (const r of rows) done.run(ackedAt, ackedAt, r.outbox_id); })();
    const seat = this.seat(nodeId);
    const hookEvent = seat.arm?.hookEvent ?? "unknown";
    if (seat.arm?.armId === armId) seat.arm = null;
    seat.turn = "woken";
    seat.turnSince = this.now();
    seat.wakePrompt = true;
    seat.wakes += 1;
    const outboxIds = rows.map((r) => r.outbox_id);
    if (outboxIds.length) this.deps.emit?.({ type: "transport.hook_bridge_wake", nodeId, sessionName, armId, outboxIds, hookEvent });
    for (const id of outboxIds) this.ended({ outboxId: id, kind: "handed-to-hook" });
    return { outboxIds };
  }

  /** A waiter reached its own deadline before its hook's timeout: the seat has no live arm until a turn re-arms it. */
  expired(nodeId: string, sessionName: string, armId: string): void {
    const seat = this.seats.get(nodeId);
    if (seat?.arm?.armId !== armId) return;
    seat.arm = null;
    seat.expiredAt = this.now();
    this.deps.emit?.({ type: "transport.hook_bridge_expired", nodeId, sessionName, armId });
  }

  /** Claimed messages whose waiter is gone without an ack (its arm replaced, or not polled within the bound) may or may
   *  not have reached Claude: indeterminate, never resent by the bridge, and named in the seat's status and an event. Run
   *  by the sweep. */
  reconcileUnacked(): string[] {
    const rows = this.db.prepare(`SELECT outbox_id, destination_session, json_extract(guard_binding, '$.nodeId') AS node_id,
      json_extract(guard_delivery, '$.armId') AS arm_id, json_extract(guard_delivery, '$.claimedAt') AS claimed_at
      FROM outbox_entries WHERE delivery_state = 'sending' AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'claimed'`)
      .all(HOOK_BRIDGE_CHANNEL) as Array<{ outbox_id: string; destination_session: string; node_id: string; arm_id: string; claimed_at: string | null }>;
    const now = this.now();
    const stale = rows.filter((r) => {
      const arm = this.seats.get(r.node_id)?.arm;
      return arm?.armId !== r.arm_id || now - Math.max(arm.lastPollAt, Date.parse(r.claimed_at ?? "") || 0) >= HOOK_BRIDGE_LIVE_BOUND_MS;
    });
    for (const r of stale) this.markUncertain(r.node_id, r.destination_session, [r.outbox_id],
      "its waiter took it and stopped without saying it handed it to Claude's hook; it may or may not have reached the seat, and the bridge doesn't resend it");
    return stale.map((r) => r.outbox_id);
  }

  /** Claimed messages that may or may not have reached the seat: indeterminate (claimed-unacked), never resent by the
   *  bridge, named in the seat's status and an event. A queue wake's own recovery may still send it again, saying
   *  delivery may repeat: that's the queue's rule for an uncertain wake. */
  private markUncertain(nodeId: string, sessionName: string, outboxIds: string[], reason: string): void {
    const mark = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'indeterminate', guard_delivery = json_set(guard_delivery, '$.state', 'claimed-unacked')
      WHERE outbox_id = ? AND delivery_state = 'sending' AND json_extract(guard_delivery, '$.state') = 'claimed'`);
    const marked = this.db.transaction(() => outboxIds.filter((id) => mark.run(id).changes === 1))();
    if (marked.length) this.deps.emit?.({ type: "transport.hook_bridge_uncertain", nodeId, sessionName, outboxIds: marked, reason });
    for (const id of marked) this.ended({ outboxId: id, kind: "claimed-unacked", reason });
  }

  /** What `rig seat hook-bridge` shows. */
  status(nodeId: string, occupant: string | null) {
    const pref = this.preference(nodeId);
    const seat = this.seats.get(nodeId);
    const uncertain = this.db.prepare(`SELECT outbox_id FROM outbox_entries WHERE delivery_state = 'indeterminate' AND guard_binding IS NOT NULL
      AND json_extract(guard_binding, '$.nodeId') = ? AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'claimed-unacked'
      ORDER BY ts_dispatched DESC LIMIT 20`).all(nodeId, HOOK_BRIDGE_CHANNEL) as Array<{ outbox_id: string }>;
    const notDelivered = this.db.prepare(`SELECT outbox_id, json_extract(guard_delivery, '$.reason') AS reason FROM outbox_entries WHERE delivery_state = 'failed'
      AND guard_binding IS NOT NULL AND json_extract(guard_binding, '$.nodeId') = ? AND json_extract(guard_delivery, '$.channel') = ?
      AND json_extract(guard_delivery, '$.state') = 'not-delivered' ORDER BY ts_dispatched DESC LIMIT 20`).all(nodeId, HOOK_BRIDGE_CHANNEL) as Array<{ outbox_id: string; reason: string | null }>;
    return {
      preference: pref,
      effective: pref ? this.routes({ nodeId, session: "", occupant, pane: null }) : false,
      ...(this.launchNotes.has(nodeId) ? { launch: this.launchNotes.get(nodeId) }
        : pref?.desired && pref.armedGeneration !== occupant ? { note: "Opted in; it takes effect when this seat is next launched or restored." } : {}),
      live: this.live(nodeId),
      arm: seat?.arm ? { armId: seat.arm.armId, hookEvent: seat.arm.hookEvent, armedAt: new Date(seat.arm.armedAt).toISOString(),
        lastPollAt: new Date(seat.arm.lastPollAt).toISOString() } : null,
      turn: seat ? { state: seat.turn, since: new Date(seat.turnSince).toISOString() } : null,
      expiredAt: seat?.expiredAt ? new Date(seat.expiredAt).toISOString() : null,
      queued: this.queued(nodeId).length,
      uncertain: { outboxIds: uncertain.map((r) => r.outbox_id), note: "Taken by a waiter that stopped without saying it handed them to Claude's hook: they may or may not have reached the seat. The bridge never resends them; a queue wake's own recovery may, saying delivery may repeat." },
      notDelivered: { outboxIds: notDelivered.map((r) => r.outbox_id), reasons: Object.fromEntries(notDelivered.map((r) => [r.outbox_id, r.reason ?? ""])),
        note: "Queued for an occupant of the seat who has gone: not typed into the seat's current occupant. Their sender isn't told; a fresh send reaches the current occupant." },
      wakesSinceDaemonStart: seat?.wakes ?? 0,
      cost: "Each wake is one model turn on the seat's own login; a burst of messages to an idle seat can cost several.",
      bounds: { liveSeconds: HOOK_BRIDGE_LIVE_BOUND_MS / 1000, turnSeconds: HOOK_BRIDGE_TURN_BOUND_MS / 1000, hookTimeoutSeconds: HOOK_BRIDGE_TIMEOUT_SECONDS, minClaude: HOOK_BRIDGE_MIN_CLAUDE },
    };
  }

  private seat(nodeId: string): SeatState {
    let seat = this.seats.get(nodeId);
    if (!seat) { seat = { arm: null, turn: "unknown", turnSince: this.now(), wakes: 0, expiredAt: null, wakePrompt: false }; this.seats.set(nodeId, seat); }
    return seat;
  }
}
