// Slice 13: delivery to an opted-in Claude seat through its launch-owned hook bridge. The seat's launch adds a
// SessionStart and a Stop hook with `asyncRewake` that each run one waiter for the seat, and a quick UserPromptSubmit
// marker. A waiter arms with the daemon, polls for the seat's queued messages, prints them and exits 2, which wakes
// Claude with them in its context at a turn boundary. OpenRig never types into the composer or a dialog on this path.
//
// The bridge is one branch inside the existing delivery owner (SessionTransport, under the seat's guard lease): the
// typing guard's hold and levels still decide first, and the queued messages are outbox rows in send order. A waiter's
// ack records a message as delivered into the seat's context, never as acted on. A seat whose bridge has no live arm
// (never armed, expired, its waiter gone) gets today's typed delivery after HOOK_BRIDGE_LIVE_BOUND_MS, with a warning.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { OutboxHandler } from "./outbox-handler.js";
import type { RigEvent } from "./types.js";

/** The hooks' `timeout` (seconds): past an hour idle, so a waiter stays armed through a long idle (7200 measured). */
export const HOOK_BRIDGE_TIMEOUT_SECONDS = 7200;
/** A waiter exits by itself this long before its hook timeout and reports that it expired. */
export const HOOK_BRIDGE_EXPIRE_MARGIN_SECONDS = 120;
/** A waiter that hasn't polled within this bound isn't live; a message queued for a bridge with no live arm is typed
 *  after this long. */
export const HOOK_BRIDGE_LIVE_BOUND_MS = 20_000;
/** A turn the bridge waits on with no waiter polling (one its own wake started, or one in progress when the daemon
 *  restarted) is waited on for at most this long before queued messages are typed. */
export const HOOK_BRIDGE_TURN_BOUND_MS = 15 * 60_000;
export const HOOK_BRIDGE_CHANNEL = "hook-bridge";

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

type Turn = "idle" | "user" | "woken" | "unknown";
interface Arm { armId: string; generation: string | null; hookEvent: string; armedAt: number; lastPollAt: number }
interface SeatState { arm: Arm | null; turn: Turn; turnSince: number; wakes: number; expiredAt: number | null }

/** What the bridge recorded for a queued message, in its outbox row's guard_delivery. */
interface BridgeReceipt {
  channel: typeof HOOK_BRIDGE_CHANNEL;
  state: "queued" | "claimed" | "delivered-to-context" | "claimed-unacked" | "typed-fallback";
  queuedAt: string;
  armId?: string;
  batchId?: string;
  hookEvent?: string;
  ackedAt?: string;
  fallbackReason?: string;
}

export type HookBridgeEvent = Extract<RigEvent, { type: `transport.hook_bridge_${string}` }>;

export class HookBridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class HookBridge {
  private readonly seats = new Map<string, SeatState>();
  private readonly now: () => number;

  constructor(readonly db: Database.Database, private readonly deps: { now?: () => number; emit?: (event: HookBridgeEvent) => void } = {}) {
    this.now = deps.now ?? Date.now;
  }

  // -- The seat's preference ------------------------------------------------------------------------------------------

  preference(nodeId: string): HookBridgePreference | null {
    const row = this.db.prepare("SELECT desired, actor, reason, changed_at, armed_generation, armed_at FROM seat_hook_bridge WHERE node_id = ?")
      .get(nodeId) as { desired: number; actor: string; reason: string; changed_at: string; armed_generation: string | null; armed_at: string | null } | undefined;
    return row ? { desired: row.desired === 1, actor: row.actor, reason: row.reason, changedAt: row.changed_at,
      armedGeneration: row.armed_generation, armedAt: row.armed_at } : null;
  }

  /** Opt a seat in or out. It takes effect at the seat's next launch or restore: only a launch adds the hooks. */
  setPreference(nodeId: string, desired: boolean, actor: string, reason: string): HookBridgePreference {
    if (!actor.trim() || !reason.trim()) throw new HookBridgeError("hook_bridge_attribution_required", "A sender identity and a reason are required.");
    const at = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO seat_hook_bridge (node_id, desired, actor, reason, changed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET desired = excluded.desired, actor = excluded.actor, reason = excluded.reason, changed_at = excluded.changed_at`)
        .run(nodeId, desired ? 1 : 0, actor, reason, at);
      this.db.prepare("INSERT INTO seat_hook_bridge_changes (node_id, desired, actor, reason, changed_at) VALUES (?, ?, ?, ?, ?)")
        .run(nodeId, desired ? 1 : 0, actor, reason, at);
    })();
    return this.preference(nodeId)!;
  }

  /** Whether the seat's next Claude launch adds the bridge's hooks. */
  launchWanted(nodeId: string): boolean {
    return this.preference(nodeId)?.desired === true;
  }

  /** Whether a send to this occupant goes through its bridge: opted in, and this occupant's own waiter has armed. */
  routes(target: HookBridgeTarget): boolean {
    const pref = this.preference(target.nodeId);
    return pref?.desired === true && pref.armedGeneration !== null && pref.armedGeneration === target.occupant;
  }

  /** Whether the bridge can take a message now: a waiter polled within the bound, or the seat is in a turn the bridge
   *  waits on (its own wake, or a person's turn while a waiter is still polling) for less than the turn bound. */
  live(nodeId: string): boolean {
    const seat = this.seats.get(nodeId);
    if (!seat) return false;
    const now = this.now();
    if (seat.arm && now - seat.arm.lastPollAt < HOOK_BRIDGE_LIVE_BOUND_MS) return true;
    return (seat.turn === "woken" || seat.turn === "unknown") && now - seat.turnSince < HOOK_BRIDGE_TURN_BOUND_MS;
  }

  /** Why the bridge can't take a message now, for the fallback's warning. */
  unavailable(nodeId: string): string {
    const seat = this.seats.get(nodeId);
    if (!seat) return "its waiter hasn't armed since the daemon started";
    if (seat.expiredAt !== null && !seat.arm) return `its waiter expired at ${new Date(seat.expiredAt).toISOString()} and no turn has re-armed it`;
    if (seat.arm) return `its waiter hasn't polled for ${Math.round((this.now() - seat.arm.lastPollAt) / 1000)} s`;
    return `no waiter has armed since a turn began ${Math.round((this.now() - seat.turnSince) / 1000)} s ago`;
  }

  // -- The transport's side -----------------------------------------------------------------------------------------

  /** Queue a send for the seat's bridge: outbox rows in send order, bound to the occupant, delivered at its next turn
   *  boundary. Called under the seat's guard lease. */
  deposit(target: HookBridgeTarget, sessionName: string, text: string, opts: { actorSession?: string | null; auditPointer?: string; urgent?: unknown;
    identityProvenance?: string | null; identityPrincipal?: string | null }, ids: string[]) {
    const outbox = new OutboxHandler(this.db);
    const queuedAt = new Date(this.now()).toISOString();
    const receipt: BridgeReceipt = { channel: HOOK_BRIDGE_CHANNEL, state: "queued", queuedAt };
    this.db.transaction(() => {
      for (const id of ids) {
        outbox.record({ outboxId: id, senderSession: opts.actorSession ?? "unknown", destinationSession: sessionName, body: text,
          urgency: opts.urgent ? "urgent" : "routine", auditPointer: opts.auditPointer, identityProvenance: opts.identityProvenance, identityPrincipal: opts.identityPrincipal });
        this.db.prepare("UPDATE outbox_entries SET delivery_state = 'sending', guard_binding = ?, guard_delivery = ? WHERE outbox_id = ?")
          .run(JSON.stringify(target), JSON.stringify(receipt), id);
      }
    })();
    return {
      ok: true as const, sessionName, outcome: "bridged" as const, sent: false, verified: false, inputPhase: "not_reached" as const, outboxIds: ids,
      warning: `Queued for ${sessionName}'s hook bridge: it reaches the seat's context at its next turn boundary, as one model turn on the seat's own login. Delivered into context is not acted on; the seat's own reply or row says that.`,
    };
  }

  /** The seat's queued messages, oldest first. */
  queued(nodeId: string): Array<{ outboxId: string; body: string; senderSession: string; queuedAt: string }> {
    const rows = this.db.prepare(`SELECT outbox_id, body, sender_session, guard_delivery FROM outbox_entries
      WHERE delivery_state = 'sending' AND guard_binding IS NOT NULL AND json_extract(guard_binding, '$.nodeId') = ?
        AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'queued'
      ORDER BY ts_dispatched, rowid`).all(nodeId, HOOK_BRIDGE_CHANNEL) as Array<{ outbox_id: string; body: string; sender_session: string; guard_delivery: string }>;
    return rows.map((r) => ({ outboxId: r.outbox_id, body: r.body, senderSession: r.sender_session, queuedAt: (JSON.parse(r.guard_delivery) as BridgeReceipt).queuedAt }));
  }

  /** The seats with queued messages the bridge can no longer deliver: no live arm, queued past the bound. */
  dueForFallback(): Array<{ nodeId: string; outboxIds: string[]; reason: string }> {
    const rows = this.db.prepare(`SELECT DISTINCT json_extract(guard_binding, '$.nodeId') AS node_id FROM outbox_entries
      WHERE delivery_state = 'sending' AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'queued'`)
      .all(HOOK_BRIDGE_CHANNEL) as Array<{ node_id: string }>;
    const due: Array<{ nodeId: string; outboxIds: string[]; reason: string }> = [];
    for (const { node_id: nodeId } of rows) {
      if (this.live(nodeId)) continue;
      const old = this.queued(nodeId).filter((m) => this.now() - Date.parse(m.queuedAt) >= HOOK_BRIDGE_LIVE_BOUND_MS);
      if (old.length) due.push({ nodeId, outboxIds: old.map((m) => m.outboxId), reason: this.unavailable(nodeId) });
    }
    return due;
  }

  /** Hand a queued message back for typed delivery: the row becomes an ordinary pending outbox row with the same id. */
  releaseForTyping(nodeId: string, sessionName: string, outboxIds: string[], reason: string): void {
    const fallback = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'pending', guard_delivery = NULL
      WHERE outbox_id = ? AND delivery_state = 'sending' AND json_extract(guard_delivery, '$.state') = 'queued'`);
    const released = outboxIds.filter((id) => fallback.run(id).changes === 1);
    if (released.length) this.deps.emit?.({ type: "transport.hook_bridge_fallback", nodeId, sessionName, outboxIds: released, reason });
  }

  // -- The waiter's side --------------------------------------------------------------------------------------------

  /** A waiter arms at a turn boundary (SessionStart or Stop) or re-arms after the daemon restarted. A newer arm replaces
   *  the seat's previous one, whose waiter is told it was superseded at its next poll. */
  arm(input: { nodeId: string; sessionName: string; generation: string | null; hookEvent: string; armId?: string }): { armId: string } {
    const armId = input.armId ?? `arm-${randomUUID()}`;
    const now = this.now();
    const seat = this.seat(input.nodeId);
    // A re-arm after a daemon restart doesn't say whether a turn is running: the bridge waits on it as unknown.
    const boundary = input.hookEvent === "SessionStart" || input.hookEvent === "Stop";
    seat.arm = { armId, generation: input.generation, hookEvent: input.hookEvent, armedAt: now, lastPollAt: now };
    seat.turn = boundary ? "idle" : "unknown";
    seat.turnSince = now;
    seat.expiredAt = null;
    this.db.prepare("UPDATE seat_hook_bridge SET armed_generation = ?, armed_at = ? WHERE node_id = ?")
      .run(input.generation, new Date(now).toISOString(), input.nodeId);
    this.deps.emit?.({ type: "transport.hook_bridge_armed", nodeId: input.nodeId, sessionName: input.sessionName, armId, hookEvent: input.hookEvent, generation: input.generation });
    return { armId };
  }

  /** A person submitted a prompt: a turn is running, so the bridge holds messages until the turn's Stop re-arms. */
  turnStarted(nodeId: string): void {
    const seat = this.seat(nodeId);
    seat.turn = "user";
    seat.turnSince = this.now();
  }

  /** A waiter's poll: deliver the seat's queued messages (claimed for this arm, oldest first), wait, or stop. */
  poll(nodeId: string, armId: string): { action: "superseded" } | { action: "rearm" } | { action: "wait" } | { action: "deliver"; batchId: string; messages: HookBridgeMessage[] } {
    const seat = this.seats.get(nodeId);
    if (!seat?.arm) return { action: "rearm" };
    if (seat.arm.armId !== armId) return { action: "superseded" };
    seat.arm.lastPollAt = this.now();
    if (seat.turn !== "idle") return { action: "wait" };
    const queued = this.queued(nodeId);
    if (!queued.length) return { action: "wait" };
    const batchId = `batch-${randomUUID()}`;
    const claim = this.db.prepare(`UPDATE outbox_entries SET guard_delivery = json_set(guard_delivery, '$.state', 'claimed', '$.armId', ?, '$.batchId', ?, '$.hookEvent', ?)
      WHERE outbox_id = ? AND delivery_state = 'sending' AND json_extract(guard_delivery, '$.state') = 'queued'`);
    const messages: HookBridgeMessage[] = [];
    this.db.transaction(() => {
      for (const m of queued) if (claim.run(armId, batchId, seat.arm!.hookEvent, m.outboxId).changes === 1) messages.push({ outboxId: m.outboxId, text: m.body, senderSession: m.senderSession });
    })();
    return messages.length ? { action: "deliver", batchId, messages } : { action: "wait" };
  }

  /** The waiter printed a batch and is about to exit 2: each message is delivered into the seat's context (not acted on),
   *  and the turn it starts is one the bridge waits on. */
  ack(nodeId: string, sessionName: string, armId: string, batchId: string): { outboxIds: string[] } {
    const ackedAt = new Date(this.now()).toISOString();
    const rows = this.db.prepare(`SELECT outbox_id FROM outbox_entries WHERE delivery_state = 'sending'
      AND json_extract(guard_delivery, '$.batchId') = ? AND json_extract(guard_delivery, '$.armId') = ? ORDER BY ts_dispatched, rowid`)
      .all(batchId, armId) as Array<{ outbox_id: string }>;
    const done = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'delivered', delivered_at = ?,
      guard_delivery = json_set(guard_delivery, '$.state', 'delivered-to-context', '$.ackedAt', ?) WHERE outbox_id = ? AND delivery_state = 'sending'`);
    this.db.transaction(() => { for (const r of rows) done.run(ackedAt, ackedAt, r.outbox_id); })();
    const seat = this.seat(nodeId);
    const hookEvent = seat.arm?.hookEvent ?? "unknown";
    if (seat.arm?.armId === armId) seat.arm = null;
    seat.turn = "woken";
    seat.turnSince = this.now();
    seat.wakes += 1;
    const outboxIds = rows.map((r) => r.outbox_id);
    if (outboxIds.length) this.deps.emit?.({ type: "transport.hook_bridge_wake", nodeId, sessionName, armId, outboxIds, hookEvent });
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

  /** Claimed messages whose arm is gone without an ack may or may not have reached the context: indeterminate, never
   *  resent. Run at startup and by the sweep. */
  reconcileUnacked(): string[] {
    const rows = this.db.prepare(`SELECT outbox_id, json_extract(guard_binding, '$.nodeId') AS node_id, json_extract(guard_delivery, '$.armId') AS arm_id
      FROM outbox_entries WHERE delivery_state = 'sending' AND json_extract(guard_delivery, '$.channel') = ? AND json_extract(guard_delivery, '$.state') = 'claimed'`)
      .all(HOOK_BRIDGE_CHANNEL) as Array<{ outbox_id: string; node_id: string; arm_id: string }>;
    const stale = rows.filter((r) => this.seats.get(r.node_id)?.arm?.armId !== r.arm_id);
    const mark = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'indeterminate', guard_delivery = json_set(guard_delivery, '$.state', 'claimed-unacked')
      WHERE outbox_id = ? AND delivery_state = 'sending'`);
    this.db.transaction(() => { for (const r of stale) mark.run(r.outbox_id); })();
    return stale.map((r) => r.outbox_id);
  }

  /** What `rig seat hook-bridge` shows. */
  status(nodeId: string, occupant: string | null) {
    const pref = this.preference(nodeId);
    const seat = this.seats.get(nodeId);
    return {
      preference: pref,
      effective: pref ? this.routes({ nodeId, session: "", occupant, pane: null }) : false,
      ...(pref?.desired && pref.armedGeneration !== occupant ? { note: "Opted in; it takes effect when this seat is next launched or restored." } : {}),
      live: this.live(nodeId),
      arm: seat?.arm ? { armId: seat.arm.armId, hookEvent: seat.arm.hookEvent, armedAt: new Date(seat.arm.armedAt).toISOString(),
        lastPollAt: new Date(seat.arm.lastPollAt).toISOString() } : null,
      turn: seat?.turn ?? null,
      expiredAt: seat?.expiredAt ? new Date(seat.expiredAt).toISOString() : null,
      queued: this.queued(nodeId).length,
      wakesSinceDaemonStart: seat?.wakes ?? 0,
      cost: "Each wake is one model turn on the seat's own login; a burst of messages to an idle seat can cost several.",
      bounds: { liveSeconds: HOOK_BRIDGE_LIVE_BOUND_MS / 1000, turnSeconds: HOOK_BRIDGE_TURN_BOUND_MS / 1000, hookTimeoutSeconds: HOOK_BRIDGE_TIMEOUT_SECONDS },
    };
  }

  private seat(nodeId: string): SeatState {
    let seat = this.seats.get(nodeId);
    if (!seat) { seat = { arm: null, turn: "unknown", turnSince: this.now(), wakes: 0, expiredAt: null }; this.seats.set(nodeId, seat); }
    return seat;
  }
}
