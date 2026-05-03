import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { QueueTransitionLog } from "./queue-transition-log.js";
import {
  computeClosureRequiredAt,
  validateClosure,
  type ClosureReason,
} from "./hot-potato-enforcer.js";

export const QUEUE_STATES = [
  "pending",
  "in-progress",
  "done",
  "blocked",
  "failed",
  "denied",
  "canceled",
  "handed-off",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export const QUEUE_PRIORITIES = ["routine", "urgent", "critical"] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export interface QueueItem {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: QueueState;
  priority: QueuePriority;
  tier: string | null;
  tags: string[] | null;
  blockedOn: string | null;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  expiresAt: string | null;
  chainOfRecord: string[] | null;
  body: string;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
  closureRequiredAt: string | null;
  claimedAt: string | null;
  lastNudgeAttempt: string | null;
  lastNudgeResult: string | null;
  lastHeartbeat: string | null;
  resolution: string | null;
}

interface QueueItemRow {
  qitem_id: string;
  ts_created: string;
  ts_updated: string;
  source_session: string;
  destination_session: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string | null;
  blocked_on: string | null;
  handed_off_to: string | null;
  handed_off_from: string | null;
  expires_at: string | null;
  chain_of_record: string | null;
  body: string;
  closure_reason: string | null;
  closure_target: string | null;
  closure_required_at: string | null;
  claimed_at: string | null;
  last_nudge_attempt: string | null;
  last_nudge_result: string | null;
  last_heartbeat: string | null;
  resolution: string | null;
}

/**
 * Async transport contract — exists in this domain module so QueueRepository
 * can do durable+waking handoffs (Phase A contract: queue create / handoff /
 * handoff-and-complete are nudging by default unless caller opts out).
 *
 * The wired-in implementation is `SessionTransport` (packages/daemon/src/
 * domain/session-transport.ts), but the repository depends only on this
 * minimal shape so test code can supply a stub.
 */
export interface QueueNudgeTransport {
  send(
    sessionName: string,
    text: string,
    opts?: { verify?: boolean }
  ): Promise<{ ok: boolean; verified?: boolean; error?: string; reason?: string }>;
}

export interface QueueCreateInput {
  qitemId?: string;
  sourceSession: string;
  destinationSession: string;
  body: string;
  priority?: QueuePriority;
  tier?: string;
  tags?: string[];
  expiresAt?: string;
  chainOfRecord?: string[];
  /**
   * R1 fix (PL-004 Phase A revision): Phase A is durable + waking by default.
   * When true (or omitted), the repository nudges the destination after the
   * create transaction commits and persists last_nudge_attempt + last_nudge_result.
   * Operators opt out with `nudge: false` for cold-queue cases.
   */
  nudge?: boolean;
}

export interface QueueUpdateInput {
  qitemId: string;
  actorSession: string;
  state: QueueState;
  transitionNote?: string;
  closureReason?: string;
  closureTarget?: string;
}

export interface QueueHandoffInput {
  qitemId: string;
  fromSession: string;
  toSession: string;
  body?: string;
  transitionNote?: string;
  priority?: QueuePriority;
  tier?: string;
  tags?: string[];
  /** Default true; nudge the destination after the close+create transaction. */
  nudge?: boolean;
}

/**
 * Like {@link QueueHandoffInput} but the source qitem is closed as `done`
 * (terminal) instead of `handed-off` (intermediate). Use when the source seat
 * is fully complete with the work and the new qitem is the canonical
 * follow-on. Closure_reason is recorded as `handed_off_to` and the new qitem
 * is created in the same atomic transaction.
 */
export interface QueueHandoffAndCompleteInput extends QueueHandoffInput {}

export interface QueueClaimInput {
  qitemId: string;
  destinationSession: string;
}

export interface QueueListOptions {
  destinationSession?: string;
  sourceSession?: string;
  state?: QueueState | QueueState[];
  limit?: number;
}

export class QueueRepositoryError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

function newQitemId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `qitem-${ts}-${hex}`;
}

/**
 * L3 — Queue repository. Owns CRUD over `queue_items` plus the wired-in
 * append-only transition log and hot-potato strict-rejection contract.
 *
 * Pattern mirrors `chat-repository.ts` (single class, atomic transactions,
 * persist-event-then-notify). Cross-rig validation hook is `validateRig` —
 * Phase A wires no-op; Phase B can plug in the rig registry to reject
 * phantom-rig destinations. POC compatibility: `qitem_id` shape preserved.
 */
export class QueueRepository {
  readonly db: Database.Database;
  readonly transitionLog: QueueTransitionLog;
  private readonly eventBus: EventBus;
  private readonly validateRig: (sessionRef: string) => boolean;
  private transport: QueueNudgeTransport | undefined;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    opts?: {
      validateRig?: (sessionRef: string) => boolean;
      /**
       * R1 fix (PL-004 Phase A revision): durable+waking-by-default transport
       * for create / handoff / handoff-and-complete. When provided, the
       * repository nudges the destination after the corresponding transaction
       * commits and records last_nudge_attempt + last_nudge_result via
       * recordNudgeAttempt(). When absent, no nudge is issued (caller is in
       * a test or daemon-bootstrap path where transport is not yet wired).
       */
      transport?: QueueNudgeTransport;
    }
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.transitionLog = new QueueTransitionLog(db);
    this.validateRig = opts?.validateRig ?? (() => true);
    this.transport = opts?.transport;
  }

  /**
   * Attach the wake-path transport AFTER construction. Used by daemon
   * startup, where SessionTransport is constructed later in the dep graph
   * than QueueRepository (because SessionTransport needs agentActivityStore
   * which itself needs eventBus). Calling this is safe at any time; create /
   * handoff / handoff-and-complete will start nudging on the next call.
   */
  attachTransport(transport: QueueNudgeTransport): void {
    this.transport = transport;
  }

  /**
   * Issue a default nudge to the destination after a create / handoff /
   * handoff-and-complete commit. Records the result via recordNudgeAttempt.
   * Errors are caught and surfaced as nudge_result strings — they do not
   * unwind the underlying queue mutation.
   */
  private async maybeNudge(
    qitemId: string,
    destinationSession: string,
    nudgeOpt: boolean | undefined,
  ): Promise<void> {
    if (nudgeOpt === false) return;
    if (!this.transport) return;
    const text = `Queue handoff: ${qitemId} - check your queue.`;
    try {
      const res = await this.transport.send(destinationSession, text, { verify: true });
      const result = res.ok
        ? (res.verified ? "verified" : "sent-unverified")
        : `failed:${res.error ?? res.reason ?? "unknown"}`;
      this.recordNudgeAttempt(qitemId, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordNudgeAttempt(qitemId, `failed:${msg}`);
    }
  }

  async create(input: QueueCreateInput): Promise<QueueItem> {
    if (!this.validateRig(input.destinationSession)) {
      throw new QueueRepositoryError(
        "unknown_destination_rig",
        `destination_session ${input.destinationSession} references an unknown rig`
      );
    }

    const id = input.qitemId ?? newQitemId();
    const ts = new Date().toISOString();
    const priority = input.priority ?? "routine";
    const tier = input.tier ?? null;
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const chain = input.chainOfRecord ? JSON.stringify(input.chainOfRecord) : null;
    const expiresAt = input.expiresAt ?? null;

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, body
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          ts,
          ts,
          input.sourceSession,
          input.destinationSession,
          priority,
          tier,
          tags,
          expiresAt,
          chain,
          input.body
        );

      this.transitionLog.append({
        qitemId: id,
        state: "pending",
        actorSession: input.sourceSession,
        transitionNote: "created",
      });

      return this.eventBus.persistWithinTransaction({
        type: "queue.created",
        qitemId: id,
        sourceSession: input.sourceSession,
        destinationSession: input.destinationSession,
        priority,
        tier,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    await this.maybeNudge(id, input.destinationSession, input.nudge);
    return this.getByIdOrThrow(id);
  }

  /**
   * Transactional handoff: close the source qitem (state=done,
   * closure_reason=handed_off_to) and create a new qitem owned by `toSession`,
   * with `handed_off_from` recording the chain. One atomic transaction.
   */
  async handoff(input: QueueHandoffInput): Promise<{ closed: QueueItem; created: QueueItem }> {
    const source = this.getById(input.qitemId);
    if (!source) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`
      );
    }
    if (source.state === "done" || source.state === "handed-off") {
      throw new QueueRepositoryError(
        "qitem_already_terminal",
        `qitem ${input.qitemId} is already in terminal state ${source.state}`
      );
    }
    if (!this.validateRig(input.toSession)) {
      throw new QueueRepositoryError(
        "unknown_destination_rig",
        `to_session ${input.toSession} references an unknown rig`
      );
    }

    const newId = newQitemId();
    const ts = new Date().toISOString();
    const body = input.body ?? source.body;
    const priority = input.priority ?? source.priority;
    const tier = input.tier ?? source.tier;
    const tags = input.tags ? JSON.stringify(input.tags) : (source.tags ? JSON.stringify(source.tags) : null);
    const chain = JSON.stringify([...(source.chainOfRecord ?? []), source.qitemId]);

    const events: Array<{ name: string; payload: import("./types.js").RigEvent }> = [];

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'handed-off',
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?`
        )
        .run(ts, input.toSession, input.toSession, source.qitemId);

      this.transitionLog.append({
        qitemId: source.qitemId,
        state: "handed-off",
        actorSession: input.fromSession,
        transitionNote: input.transitionNote ?? `handed off to ${input.toSession}`,
        closureReason: "handed_off_to",
        closureTarget: input.toSession,
      });

      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, handed_off_from, chain_of_record, body
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newId,
          ts,
          ts,
          input.fromSession,
          input.toSession,
          priority,
          tier,
          tags,
          source.qitemId,
          chain,
          body
        );

      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff from ${source.qitemId}`,
      });

      const handoffEvent = this.eventBus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: source.qitemId,
        fromSession: input.fromSession,
        toSession: input.toSession,
        closureReason: "handed_off_to",
      });
      events.push({ name: "queue.handed_off", payload: handoffEvent });

      const createdEvent = this.eventBus.persistWithinTransaction({
        type: "queue.created",
        qitemId: newId,
        sourceSession: input.fromSession,
        destinationSession: input.toSession,
        priority,
        tier,
      });
      events.push({ name: "queue.created", payload: createdEvent });
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    await this.maybeNudge(newId, input.toSession, input.nudge);

    return {
      closed: this.getByIdOrThrow(source.qitemId),
      created: this.getByIdOrThrow(newId),
    };
  }

  /**
   * Variant of {@link handoff} that closes the source qitem as `done`
   * (terminal closure) instead of `handed-off` (intermediate). Same atomic
   * close+create, same chain_of_record semantics, same default-nudge behavior.
   * Use when the source seat is fully complete with the work — no follow-up
   * tracking needed against the source qitem.
   */
  async handoffAndComplete(input: QueueHandoffAndCompleteInput): Promise<{ closed: QueueItem; created: QueueItem }> {
    const source = this.getById(input.qitemId);
    if (!source) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`
      );
    }
    if (source.state === "done" || source.state === "handed-off") {
      throw new QueueRepositoryError(
        "qitem_already_terminal",
        `qitem ${input.qitemId} is already in terminal state ${source.state}`
      );
    }
    if (!this.validateRig(input.toSession)) {
      throw new QueueRepositoryError(
        "unknown_destination_rig",
        `to_session ${input.toSession} references an unknown rig`
      );
    }

    const newId = newQitemId();
    const ts = new Date().toISOString();
    const body = input.body ?? source.body;
    const priority = input.priority ?? source.priority;
    const tier = input.tier ?? source.tier;
    const tags = input.tags ? JSON.stringify(input.tags) : (source.tags ? JSON.stringify(source.tags) : null);
    const chain = JSON.stringify([...(source.chainOfRecord ?? []), source.qitemId]);

    const events: Array<{ name: string; payload: import("./types.js").RigEvent }> = [];

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'done',
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?`
        )
        .run(ts, input.toSession, input.toSession, source.qitemId);

      this.transitionLog.append({
        qitemId: source.qitemId,
        state: "done",
        actorSession: input.fromSession,
        transitionNote: input.transitionNote ?? `handoff-and-complete to ${input.toSession}`,
        closureReason: "handed_off_to",
        closureTarget: input.toSession,
      });

      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, handed_off_from, chain_of_record, body
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newId,
          ts,
          ts,
          input.fromSession,
          input.toSession,
          priority,
          tier,
          tags,
          source.qitemId,
          chain,
          body
        );

      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff-and-complete from ${source.qitemId}`,
      });

      const handoffEvent = this.eventBus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: source.qitemId,
        fromSession: input.fromSession,
        toSession: input.toSession,
        closureReason: "handed_off_to",
      });
      events.push({ name: "queue.handed_off", payload: handoffEvent });

      const createdEvent = this.eventBus.persistWithinTransaction({
        type: "queue.created",
        qitemId: newId,
        sourceSession: input.fromSession,
        destinationSession: input.toSession,
        priority,
        tier,
      });
      events.push({ name: "queue.created", payload: createdEvent });
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    await this.maybeNudge(newId, input.toSession, input.nudge);

    return {
      closed: this.getByIdOrThrow(source.qitemId),
      created: this.getByIdOrThrow(newId),
    };
  }

  /**
   * `whoami` — return the seat's queue position from the daemon's perspective.
   * Counts active qitems (pending + in-progress + blocked) destined for the
   * caller, lists the most recent active qitems, and reports counts for the
   * caller's outgoing source role too. Read-only; no mutations.
   *
   * Per PL-004 Phase A § Routes: GET /api/queue/whoami.
   */
  whoami(session: string, opts?: { recentLimit?: number }): {
    session: string;
    asDestination: { pending: number; inProgress: number; blocked: number; recent: QueueItem[] };
    asSource: { total: number };
  } {
    const limit = Math.max(1, Math.min(opts?.recentLimit ?? 25, 200));
    const countByState = (state: string): number => {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = ? AND state = ?`
        )
        .get(session, state) as { n: number };
      return row.n;
    };
    const recent = this.db
      .prepare(
        `SELECT * FROM queue_items
          WHERE destination_session = ?
            AND state IN ('pending','in-progress','blocked')
          ORDER BY ts_updated DESC
          LIMIT ?`
      )
      .all(session, limit) as QueueItemRow[];
    const sourceTotalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE source_session = ?`)
      .get(session) as { n: number };
    return {
      session,
      asDestination: {
        pending: countByState("pending"),
        inProgress: countByState("in-progress"),
        blocked: countByState("blocked"),
        recent: recent.map((r) => this.rowToItem(r)),
      },
      asSource: { total: sourceTotalRow.n },
    };
  }

  /**
   * Mark a qitem `in-progress` (claim). Computes closure_required_at from tier.
   */
  claim(input: QueueClaimInput): QueueItem {
    const qitem = this.getById(input.qitemId);
    if (!qitem) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`
      );
    }
    if (qitem.destinationSession !== input.destinationSession) {
      throw new QueueRepositoryError(
        "claim_destination_mismatch",
        `qitem ${input.qitemId} destination is ${qitem.destinationSession}, not ${input.destinationSession}`
      );
    }
    if (qitem.state !== "pending" && qitem.state !== "blocked") {
      throw new QueueRepositoryError(
        "qitem_not_claimable",
        `qitem ${input.qitemId} is in state ${qitem.state}; only pending/blocked are claimable`
      );
    }

    const ts = new Date().toISOString();
    const closureRequiredAt = computeClosureRequiredAt(ts, qitem.tier);

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'in-progress',
                 ts_updated = ?,
                 claimed_at = ?,
                 closure_required_at = ?
           WHERE qitem_id = ?`
        )
        .run(ts, ts, closureRequiredAt, input.qitemId);

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: "in-progress",
        actorSession: input.destinationSession,
        transitionNote: "claimed",
      });

      return this.eventBus.persistWithinTransaction({
        type: "queue.claimed",
        qitemId: input.qitemId,
        destinationSession: input.destinationSession,
        claimedAt: ts,
        closureRequiredAt,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(input.qitemId);
  }

  unclaim(qitemId: string, destinationSession: string, reason: string): QueueItem {
    const qitem = this.getById(qitemId);
    if (!qitem) {
      throw new QueueRepositoryError("qitem_not_found", `qitem ${qitemId} not found`);
    }
    if (qitem.state !== "in-progress") {
      throw new QueueRepositoryError(
        "qitem_not_in_progress",
        `qitem ${qitemId} is in state ${qitem.state}; only in-progress can be unclaimed`
      );
    }
    const ts = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'pending',
                 ts_updated = ?,
                 claimed_at = NULL,
                 closure_required_at = NULL
           WHERE qitem_id = ?`
        )
        .run(ts, qitemId);

      this.transitionLog.append({
        qitemId,
        state: "pending",
        actorSession: destinationSession,
        transitionNote: `unclaimed: ${reason}`,
      });

      return this.eventBus.persistWithinTransaction({
        type: "queue.unclaimed",
        qitemId,
        destinationSession,
        reason,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(qitemId);
  }

  /**
   * General state mutator. Routes through hot-potato strict-rejection on
   * `done` transitions. All transitions append to the log.
   */
  update(input: QueueUpdateInput): QueueItem {
    const qitem = this.getById(input.qitemId);
    if (!qitem) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`
      );
    }
    if (!isQueueState(input.state)) {
      throw new QueueRepositoryError(
        "invalid_state",
        `state=${input.state} not valid; valid: ${QUEUE_STATES.join(", ")}`
      );
    }

    const validation = validateClosure({
      state: input.state,
      closureReason: input.closureReason ?? null,
      closureTarget: input.closureTarget ?? null,
    });
    if (!validation.ok) {
      throw new QueueRepositoryError(validation.code, validation.message, {
        validReasons: "validReasons" in validation ? validation.validReasons : undefined,
      });
    }

    const ts = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = ?,
                 ts_updated = ?,
                 closure_reason = COALESCE(?, closure_reason),
                 closure_target = COALESCE(?, closure_target)
           WHERE qitem_id = ?`
        )
        .run(
          input.state,
          ts,
          validation.closureReason,
          validation.closureTarget,
          input.qitemId
        );

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: input.state,
        actorSession: input.actorSession,
        transitionNote: input.transitionNote,
        closureReason: validation.closureReason ?? undefined,
        closureTarget: validation.closureTarget ?? undefined,
      });
    });

    txn();
    return this.getByIdOrThrow(input.qitemId);
  }

  getById(qitemId: string): QueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as QueueItemRow | undefined;
    return row ? this.rowToItem(row) : null;
  }

  list(opts?: QueueListOptions): QueueItem[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.destinationSession) {
      conditions.push("destination_session = ?");
      params.push(opts.destinationSession);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }
    if (opts?.state) {
      const states = Array.isArray(opts.state) ? opts.state : [opts.state];
      const placeholders = states.map(() => "?").join(", ");
      conditions.push(`state IN (${placeholders})`);
      params.push(...states);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM queue_items ${where} ORDER BY ts_created DESC LIMIT ?`
      )
      .all(...params) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Find qitems whose `closure_required_at` is past now. Used by watchdog;
   * does NOT itself emit events — callers decide whether to nudge or escalate.
   */
  findOverdue(now?: string): QueueItem[] {
    const cutoff = now ?? new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM queue_items
          WHERE state = 'in-progress'
            AND closure_required_at IS NOT NULL
            AND closure_required_at <= ?`
      )
      .all(cutoff) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  recordNudgeAttempt(qitemId: string, result: string): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE queue_items
           SET last_nudge_attempt = ?, last_nudge_result = ?
         WHERE qitem_id = ?`
      )
      .run(ts, result, qitemId);
  }

  recordHeartbeat(qitemId: string): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE queue_items SET last_heartbeat = ? WHERE qitem_id = ?`
      )
      .run(ts, qitemId);
  }

  /**
   * Pod-fallback: redirect qitem to a fallback destination (e.g., when a seat
   * is unreachable). Emits qitem.fallback_routed; preserves chain_of_record.
   */
  routeToFallback(qitemId: string, fallbackDestination: string, reason: string): QueueItem {
    const qitem = this.getById(qitemId);
    if (!qitem) {
      throw new QueueRepositoryError("qitem_not_found", `qitem ${qitemId} not found`);
    }
    const ts = new Date().toISOString();
    const originalDestination = qitem.destinationSession;
    const newChain = JSON.stringify([...(qitem.chainOfRecord ?? []), `fallback-from:${originalDestination}`]);

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET destination_session = ?,
                 ts_updated = ?,
                 chain_of_record = ?,
                 resolution = ?
           WHERE qitem_id = ?`
        )
        .run(fallbackDestination, ts, newChain, `fallback: ${reason}`, qitemId);

      this.transitionLog.append({
        qitemId,
        state: qitem.state,
        actorSession: "system:queue-fallback",
        transitionNote: `fallback-routed: ${originalDestination} → ${fallbackDestination} (${reason})`,
      });

      return this.eventBus.persistWithinTransaction({
        type: "qitem.fallback_routed",
        qitemId,
        originalDestination,
        rerouteDestination: fallbackDestination,
        reason,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(qitemId);
  }

  private getByIdOrThrow(qitemId: string): QueueItem {
    const item = this.getById(qitemId);
    if (!item) {
      throw new QueueRepositoryError("qitem_not_found", `qitem ${qitemId} not found after write`);
    }
    return item;
  }

  private rowToItem(row: QueueItemRow): QueueItem {
    return {
      qitemId: row.qitem_id,
      tsCreated: row.ts_created,
      tsUpdated: row.ts_updated,
      sourceSession: row.source_session,
      destinationSession: row.destination_session,
      state: row.state as QueueState,
      priority: row.priority as QueuePriority,
      tier: row.tier,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      blockedOn: row.blocked_on,
      handedOffTo: row.handed_off_to,
      handedOffFrom: row.handed_off_from,
      expiresAt: row.expires_at,
      chainOfRecord: row.chain_of_record ? (JSON.parse(row.chain_of_record) as string[]) : null,
      body: row.body,
      closureReason: row.closure_reason as ClosureReason | null,
      closureTarget: row.closure_target,
      closureRequiredAt: row.closure_required_at,
      claimedAt: row.claimed_at,
      lastNudgeAttempt: row.last_nudge_attempt,
      lastNudgeResult: row.last_nudge_result,
      lastHeartbeat: row.last_heartbeat,
      resolution: row.resolution,
    };
  }
}

function isQueueState(value: string): value is QueueState {
  return (QUEUE_STATES as readonly string[]).includes(value);
}
