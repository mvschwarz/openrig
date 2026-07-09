import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import { QueueTransitionLog } from "./queue-transition-log.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";
import {
  computeClosureRequiredAt,
  validateClosure,
  type ClosureReason,
} from "./hot-potato-enforcer.js";
import { isHumanSeatSession, validateHumanPark, validateHumanRoute } from "./human-route-enforcer.js";

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

/** OPR.0.4.6.FS-1 (W2 P1): the queue's terminal state set, named ONCE. The
 *  archiver (queue-retention.ts) AND the inline closure guards below all consume
 *  THIS predicate, so a future terminal-state addition can never silently
 *  diverge the archiver from the queue (arch D3-REFINEMENT P1; widen-never-sibling).
 *  `['done','handed-off']` is the full terminal set — workflow step closures exit
 *  `handoff -> state=handed-off`, the highest-volume terminal class. The `satisfies`
 *  clause is the compile guard: removing a state from QUEUE_STATES fails here. */
export const TERMINAL_QUEUE_STATES = ["done", "handed-off"] as const satisfies readonly QueueState[];
export function isTerminalState(state: string): boolean {
  return (TERMINAL_QUEUE_STATES as readonly string[]).includes(state);
}

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
  /** OPR.0.4.1.18 — optional short human-readable summary (~1–2 sentences).
   *  NULL for pre-18 qitems + any an author omitted (the Story consumer
   *  degrades on null). The agent-speak `body` stays the source of truth. */
  summary: string | null;
  /** OPR.0.4.4.19 FR-5 — pointer to the durable artifact a human judges
   *  (convention C3). NULL for all non-human-routed items (BR-1); required
   *  at the domain write path only when the §5 predicate is true. */
  evidenceRef: string | null;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
  closureRequiredAt: string | null;
  claimedAt: string | null;
  lastNudgeAttempt: string | null;
  lastNudgeResult: string | null;
  lastHeartbeat: string | null;
  resolution: string | null;
  /** PL-007 Workspace Primitive — typed repo scope for the qitem. Validated
   *  by the route layer against the source rig's RigSpec.workspace.repos[].
   *  Null when the task is unambiguously the rig's default_repo or
   *  ambiguity is absent. Stored as a dedicated TEXT column (migration 038). */
  targetRepo: string | null;
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
  summary: string | null;
  evidence_ref: string | null;
  closure_reason: string | null;
  closure_target: string | null;
  closure_required_at: string | null;
  claimed_at: string | null;
  last_nudge_attempt: string | null;
  last_nudge_result: string | null;
  last_heartbeat: string | null;
  resolution: string | null;
  target_repo: string | null;
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
  /** PL-007 — typed repo scope for this qitem. Route validates against
   *  source rig's workspace.repos[]; unknown names rejected upstream. */
  targetRepo?: string | null;
  /** OPR.0.4.1.18 — optional ~1–2 sentence human-readable summary. Persisted
   *  when present; omitted → NULL → Story degrade. */
  summary?: string | null;
  /** OPR.0.4.4.19 FR-5 — optional durable-artifact pointer. Persisted when
   *  present; required at the domain layer only for human-routed items. */
  evidenceRef?: string | null;
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
  /**
   * OPR.0.4.6.WF3 FR-6 — set ONLY by the workflow domain's own write
   * paths (projector close, route close): they hold the frontier
   * invariant, so the close-path guard exempts them. Not a security
   * boundary — a correctness foot-gun guard (pm ruling: prevention).
   */
  viaWorkflowVerb?: boolean;
  transitionNote?: string;
  closureReason?: string;
  closureTarget?: string;
  /**
   * PL-004 Phase D extension: when set, persists the queue_items.handed_off_to
   * column. Used by workflow-projector for state=handed-off transitions so
   * the canonical "next owner" pointer is recoverable from queue state alone.
   * Optional to preserve backward compatibility with existing update() callers.
   */
  handedOffTo?: string;
  /**
   * PL-004 Phase D extension: when set, persists the queue_items.blocked_on
   * column. Used by workflow-projector for state=blocked transitions so the
   * blocker reference (qitem id, gate name) is recoverable from queue state.
   */
  blockedOn?: string;
  /**
   * OPR.0.4.4.19 FR-6 — park-time inputs. summary + evidence_ref are
   * updatable AT THE PARK MOMENT (state=blocked with a human-seat blocker),
   * not create-only: `rig queue block --summary --evidence-ref` persists
   * them onto the EXISTING item so the attention query + Packet 2 read
   * them. Ignored (not persisted) on non-park transitions to keep the
   * update surface tight.
   */
  summary?: string | null;
  evidenceRef?: string | null;
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
  /** PL-007 — typed repo scope for the new qitem. When omitted, the new
   *  qitem inherits the source's targetRepo. */
  targetRepo?: string | null;
  /** OPR.0.4.1.18 — optional ~1–2 sentence summary for the NEW qitem. NOT
   *  inherited from the source (a handoff authors its own summary); omitted
   *  → NULL → Story degrade. */
  summary?: string | null;
  /** OPR.0.4.4.19 FR-5 — optional durable-artifact pointer for the NEW qitem.
   *  NOT inherited from the source (same authorship semantics as summary). */
  evidenceRef?: string | null;
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
  /** PL-007 — filter qitems by target_repo. Exact match. */
  targetRepo?: string;
  limit?: number;
  asSession?: string;
  compact?: boolean;
  rig?: string;
  activeOnly?: boolean;
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

/** OPR.0.4.6.WF5 (guard-named fix shape): exported so the workflow
 *  domain can PREALLOCATE a gate packet's id — the class-(c) exception
 *  identity tags need occurrence:<gatePacketId> ON the packet at create
 *  (one item, tagged in its own create — never a second item, never a
 *  post-create tag rewrite). The queue still mints ids for every caller
 *  that does not preallocate. */
export function newQitemId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `qitem-${ts}-${hex}`;
}

/**
 * OPR.0.4.6.MH3 Q-a: is this the SQLite PRIMARY KEY conflict on
 * queue_items.qitem_id? better-sqlite3 sets `.code` on its SqliteError; the
 * message check is a defensive twin so a driver-name change never silently
 * turns an idempotent absorb into a 500.
 */
export function isQitemPrimaryKeyConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code ?? "";
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return /UNIQUE constraint failed: queue_items\.qitem_id/.test(err.message);
}

/**
 * OPR.0.4.6.MH3 D-1 (FR-4/FR-5): the deterministic cross-host SUCCESSOR id.
 *
 * A cross-host handoff exposes no caller `--id`, so the successor's dedup
 * identity must come from the operation itself: the id is a PURE, STATELESS
 * function of (source qitemId, destination session, destination host). Same
 * arguments → same id on every re-drive, across daemon restarts, with zero
 * local state — so the origin-side PRIMARY KEY absorb (Q-a) converges every
 * interrupted-close re-drive. Source→successor is 1:1 by construction (a
 * closed source is terminal; nothing re-opens it). The `qitem-xh-` namespace
 * makes collision with organic `qitem-<ts>-<hex>` ids structurally impossible
 * (plan R-2). The compound key is JSON-encoded — no hand-rolled separators.
 *
 * n1 residual (arch-named, inherent to the ratified at-least-once/no-2PC
 * fence — NOT a dedup bug): a re-drive naming a DIFFERENT destination before
 * the source close lands is a NEW handoff decision and derives a DIFFERENT
 * id, so it cannot absorb the earlier successor — that earlier successor can
 * remain live on the target host. The chain_of_record + cross-host provenance
 * tags keep such an orphan visible/traceable; the source-close conflict check
 * surfaces the disagreement rather than overwriting it.
 */
export function deriveCrossHostSuccessorId(
  sourceQitemId: string,
  destinationSession: string,
  hostId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sourceQitemId, destinationSession, hostId]))
    .digest("hex")
    .slice(0, 16);
  return `qitem-xh-${digest}`;
}

/** PL-007 — defensive column probe. Older test fixtures bypass the
 *  canonical migration list, so target_repo may be absent. Mirrors
 *  the `hasNodeColumn` pattern in rig-repository.ts. */
function detectQueueColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db.prepare("PRAGMA table_info(queue_items)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
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
  /** PL-007 Workspace Primitive — true when migration 038 has applied the
   *  queue_items.target_repo column. Older test fixtures that bypass the
   *  canonical migration list don't have the column; INSERTs degrade to
   *  the pre-PL-007 statement and target_repo input is silently dropped.
   *  Production daemons always have the column (migration is in startup.ts). */
  private readonly hasTargetRepoColumn: boolean;
  private readonly hasSummaryColumn: boolean;
  private readonly hasEvidenceRefColumn: boolean;
  /** OPR.0.4.6.WF3 FR-6 — injected by startup (never imported): the
   *  workflow domain's is-live-frontier-packet predicate. */
  private readonly workflowFrontierPredicate:
    | ((qitemId: string) => { instanceId: string; workflowName: string } | null)
    | undefined;

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
      /**
       * OPR.0.4.6.WF3 FR-6 — the frontier close-path guard's INJECTED
       * predicate (the validateRig injection precedent: the queue is
       * the lower primitive and NEVER imports the workflow domain;
       * startup wires the workflow domain's exported predicate in).
       * Absent (tests, bootstrap, pre-workflow schemas) = zero new
       * behavior.
       */
      workflowFrontierPredicate?: (qitemId: string) => { instanceId: string; workflowName: string } | null;
    }
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.transitionLog = new QueueTransitionLog(db);
    this.validateRig = opts?.validateRig ?? (() => true);
    this.transport = opts?.transport;
    this.workflowFrontierPredicate = opts?.workflowFrontierPredicate;
    this.hasTargetRepoColumn = detectQueueColumn(db, "target_repo");
    this.hasSummaryColumn = detectQueueColumn(db, "summary");
    this.hasEvidenceRefColumn = detectQueueColumn(db, "evidence_ref");

    // OPR.0.3.2.20 — register the EXACT human-seat regex predicate as
    // a SQLite function so the attention query can apply the strict
    // check BEFORE LIMIT. LIKE / GLOB patterns are supersets that
    // would let malformed rows (e.g., 'human-@kernel' — empty name
    // segment) occupy the LIMIT window and hide valid attention items
    // behind them (guard re-verify-3 qitem-20260518193005 BLOCKER 1).
    // better-sqlite3 db.function is idempotent; safe to call once at
    // construction.
    // OPR.0.4.4.19: single-source regex — the SQL function delegates to the
    // human-route-enforcer's exported predicate so SQL-side and TS-side
    // checks cannot drift.
    db.function("is_human_seat_session", { deterministic: true }, (value: unknown) =>
      isHumanSeatSession(value) ? 1 : 0
    );
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
   *
   * Phase D extension point (orch-ratified): public so workflow-projector
   * can invoke after its outer transaction commits, completing the
   * createWithinTransaction()'s deferred post-commit side effects.
   *
   * V0.3.1 slice 23 queue-handoff-envelope: the nudge body
   * is now wrapped with the same From/To/---/body/---/↩ Reply envelope
   * that `rig send` uses. `sourceSession` is the seat that triggered
   * the create/handoff so the recipient pane shows where the nudge
   * came from + a reply hint. When undefined, the envelope falls back
   * to the canonical "<unknown sender>" marker (matches wrapPaneEnvelope).
   */
  async maybeNudge(
    qitemId: string,
    destinationSession: string,
    nudgeOpt: boolean | undefined,
    sourceSession?: string,
    bodyOverride?: string,
  ): Promise<void> {
    if (nudgeOpt === false) return;
    if (!this.transport) return;
    // OPR.0.4.4.19 FR-7: bodyOverride lets the resolve verb carry the
    // decision text to the parked owner; default stays the handoff nudge.
    const bareBody = bodyOverride ?? `Queue handoff: ${qitemId} - check your queue.`;
    const text = wrapPaneEnvelope(sourceSession, destinationSession, bareBody);
    try {
      const res = await this.transport.send(destinationSession, text, { verify: true });
      // OPR.0.3.2.21.FR-4(c) — wording rename: the prior literal
      // "sent-unverified" read as a failure even in the common case
      // (delivery confirmed but the synchronous ack window expired,
      // which is normal for codex seats mid-task). The new literal
      // "delivered-ack-pending" reads as healthy. The old "verified"
      // case is unchanged for backward-compat with any tooling that
      // already consumed the positive literal.
      const result = res.ok
        ? (res.verified ? "verified" : "delivered-ack-pending")
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

    const txn = this.db.transaction(() => this.createInTransactionalContext(input));
    let id: string;
    let persistedEvent: PersistedEvent;
    try {
      ({ qitemId: id, persistedEvent } = txn());
    } catch (err) {
      // OPR.0.4.6.MH3 Q-a (FR-5): at-least-once cross-host forwards retry with
      // the SAME minted qitemId, so a PK conflict on an EXISTING row is an
      // idempotent RE-DELIVERY when the identity fields match — return the
      // stored row (no second insert, no second event/nudge). A conflict whose
      // identity fields DIFFER (same id, different destination/source) is a
      // caller id-reuse bug — a structured error, never a silent overwrite.
      // Local (non-forwarded) creates that pass an explicit --id keep the same
      // safety for free.
      if (input.qitemId && isQitemPrimaryKeyConflict(err)) {
        const existing = this.getById(input.qitemId);
        if (existing) {
          if (
            existing.destinationSession === input.destinationSession &&
            existing.sourceSession === input.sourceSession
          ) {
            return existing;
          }
          throw new QueueRepositoryError(
            "qitem_id_reuse",
            `qitem ${input.qitemId} already exists with a different destination/source — id reuse is a caller bug, not an idempotent retry`,
            {
              qitemId: input.qitemId,
              existingDestination: existing.destinationSession,
              existingSource: existing.sourceSession,
            },
          );
        }
      }
      throw err;
    }
    this.eventBus.notifySubscribers(persistedEvent);
    await this.maybeNudge(id, input.destinationSession, input.nudge, input.sourceSession);
    return this.getByIdOrThrow(id);
  }

  /**
   * PL-004 Phase D extension point (orch-ratified per slice IMPL §
   * Driver Handoff Contract). Creates a queue item using the SAME
   * caller-managed db.transaction for transactional-scribe semantics
   * (workflow-projector folds step closure + next-qitem creation into
   * one atomic unit). Returns the persisted event AND qitem id so the
   * caller can defer notifySubscribers/maybeNudge until AFTER its
   * outer transaction commits.
   *
   * Caller MUST:
   *   1. Invoke this from inside a `db.transaction(() => {...})` block.
   *   2. After the outer txn commits, call:
   *        - eventBus.notifySubscribers(persistedEvent)
   *        - this.maybeNudge(qitemId, destinationSession, input.nudge)
   *   3. NOT call this from outside a transaction (will produce a
   *      half-state if the caller errors before committing).
   *
   * The split exists ONLY because notifySubscribers + maybeNudge are
   * post-commit side effects (subscribers should not see events for
   * data that may roll back; nudges should not fire for handoffs that
   * may roll back). For independent create()s that don't need to
   * compose with an outer transaction, use create() instead.
   */
  createWithinTransaction(input: QueueCreateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
    destinationSession: string;
    nudge: boolean | undefined;
  } {
    if (!this.validateRig(input.destinationSession)) {
      throw new QueueRepositoryError(
        "unknown_destination_rig",
        `destination_session ${input.destinationSession} references an unknown rig`
      );
    }
    const result = this.createInTransactionalContext(input);
    return {
      qitemId: result.qitemId,
      persistedEvent: result.persistedEvent,
      destinationSession: input.destinationSession,
      nudge: input.nudge,
    };
  }

  /**
   * Internal: insert + transition + emit event. Caller is responsible
   * for transaction wrapping (the public create() wraps; the public
   * createWithinTransaction() does not — caller's outer transaction
   * provides the atomic boundary).
   */
  private createInTransactionalContext(input: QueueCreateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
  } {
    // OPR.0.4.4.19 FR-4/FR-5 — human-routed items require summary +
    // evidence_ref at the domain write path (the validateClosure pattern).
    // The validator is a no-op for non-human-routed items (BR-1).
    const humanRoute = validateHumanRoute({
      tier: input.tier ?? null,
      destinationSession: input.destinationSession,
      summary: input.summary ?? null,
      evidenceRef: input.evidenceRef ?? null,
    });
    if (!humanRoute.ok) {
      throw new QueueRepositoryError(humanRoute.code, humanRoute.message, {
        missingFields: humanRoute.missingFields,
      });
    }
    const id = input.qitemId ?? newQitemId();
    const ts = new Date().toISOString();
    const priority = input.priority ?? "routine";
    const tier = input.tier ?? null;
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const chain = input.chainOfRecord ? JSON.stringify(input.chainOfRecord) : null;
    const expiresAt = input.expiresAt ?? null;
    const targetRepo = input.targetRepo ?? null;

    if (this.hasTargetRepoColumn) {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, body, target_repo
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, input.body, targetRepo);
    } else {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, body
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, input.body);
    }
    this.persistSummary(id, input.summary ?? null);
    this.persistEvidenceRef(id, input.evidenceRef ?? null);
    this.transitionLog.append({
      qitemId: id,
      state: "pending",
      actorSession: input.sourceSession,
      transitionNote: "created",
    });
    const persistedEvent = this.eventBus.persistWithinTransaction({
      type: "queue.created",
      qitemId: id,
      sourceSession: input.sourceSession,
      destinationSession: input.destinationSession,
      priority,
      tier,
      summary: input.summary ?? null,
    });
    return { qitemId: id, persistedEvent };
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
    if (isTerminalState(source.state)) {
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
    const targetRepo = input.targetRepo === undefined ? source.targetRepo : input.targetRepo;

    // OPR.0.4.4.19 FR-4/FR-5 — the handoff authors a NEW qitem; when that
    // new item is human-routed it requires its OWN summary + evidence_ref
    // (neither is inherited from the source — 044 semantics preserved).
    const humanRoute = validateHumanRoute({
      tier,
      destinationSession: input.toSession,
      summary: input.summary ?? null,
      evidenceRef: input.evidenceRef ?? null,
    });
    if (!humanRoute.ok) {
      throw new QueueRepositoryError(humanRoute.code, humanRoute.message, {
        missingFields: humanRoute.missingFields,
      });
    }

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

      if (this.hasTargetRepoColumn) {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body, target_repo
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body, targetRepo);
      } else {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body);
      }

      this.persistSummary(newId, input.summary ?? null);
      this.persistEvidenceRef(newId, input.evidenceRef ?? null);

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
        summary: source.summary ?? null,
      });
      events.push({ name: "queue.handed_off", payload: handoffEvent });

      const createdEvent = this.eventBus.persistWithinTransaction({
        type: "queue.created",
        qitemId: newId,
        sourceSession: input.fromSession,
        destinationSession: input.toSession,
        priority,
        tier,
        summary: input.summary ?? null,
      });
      events.push({ name: "queue.created", payload: createdEvent });
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    await this.maybeNudge(newId, input.toSession, input.nudge, input.fromSession);

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
    if (isTerminalState(source.state)) {
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
    const targetRepo = input.targetRepo === undefined ? source.targetRepo : input.targetRepo;

    // OPR.0.4.4.19 FR-4/FR-5 — same new-item enforcement as handoff().
    const humanRoute = validateHumanRoute({
      tier,
      destinationSession: input.toSession,
      summary: input.summary ?? null,
      evidenceRef: input.evidenceRef ?? null,
    });
    if (!humanRoute.ok) {
      throw new QueueRepositoryError(humanRoute.code, humanRoute.message, {
        missingFields: humanRoute.missingFields,
      });
    }

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

      if (this.hasTargetRepoColumn) {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body, target_repo
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body, targetRepo);
      } else {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body);
      }

      this.persistSummary(newId, input.summary ?? null);
      this.persistEvidenceRef(newId, input.evidenceRef ?? null);

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
        summary: source.summary ?? null,
      });
      events.push({ name: "queue.handed_off", payload: handoffEvent });

      const createdEvent = this.eventBus.persistWithinTransaction({
        type: "queue.created",
        qitemId: newId,
        sourceSession: input.fromSession,
        destinationSession: input.toSession,
        priority,
        tier,
        summary: input.summary ?? null,
      });
      events.push({ name: "queue.created", payload: createdEvent });
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    await this.maybeNudge(newId, input.toSession, input.nudge, input.fromSession);

    return {
      closed: this.getByIdOrThrow(source.qitemId),
      created: this.getByIdOrThrow(newId),
    };
  }

  /**
   * OPR.0.4.6.MH3 FR-4 (C2, arch Q-c): the LOCAL half of a cross-host
   * handoff — close the source row AFTER the successor-create was forwarded
   * to (and accepted by) the target host. The two sides live in two DBs, so
   * this is deliberately NOT the atomic close+create of {@link handoff}: the
   * boundary is bridged by message-passing (successor-create FIRST on the
   * origin host, this source-close SECOND — never the reverse, so a crash
   * between the two leaves a live duplicate the idempotent re-drive
   * converges, never a dropped potato).
   *
   * Re-drive semantics (FR-4/FR-5, the interrupted-close case):
   *   - source already terminal WITH a MATCHING closureTarget → idempotent
   *     absorb: return the stored row unchanged (`absorbed: true`) — no
   *     second close, no second event.
   *   - source already terminal with a MISMATCHED closureTarget → structured
   *     `cross_host_close_conflict` (someone else closed it meanwhile —
   *     surface, never overwrite).
   *   - otherwise → close exactly like the local handoff's close leg:
   *     `closure_reason=handed_off_to`; `closure_target` carries the OPAQUE
   *     three-part `<member@rig>@<host>` form (arch R1 — presence-checked
   *     display/audit metadata, NEVER parsed for routing); `handed_off_to`
   *     stays the two-part `member@rig` (BR-1 — session-string carriers
   *     never gain `@host`).
   */
  closeCrossHostHandoffSource(input: {
    qitemId: string;
    fromSession: string;
    /** Two-part `member@rig` destination — the session-string carrier (BR-1). */
    toSession: string;
    /** Opaque three-part `<member@rig>@<host>` closure target (arch R1). */
    closureTarget: string;
    /** `handed-off` for /handoff; `done` for /handoff-and-complete. */
    terminalState: "handed-off" | "done";
    transitionNote?: string;
  }): { item: QueueItem; absorbed: boolean } {
    const source = this.getById(input.qitemId);
    if (!source) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`
      );
    }
    if (isTerminalState(source.state)) {
      if (source.closureTarget === input.closureTarget) {
        return { item: source, absorbed: true };
      }
      throw new QueueRepositoryError(
        "cross_host_close_conflict",
        `qitem ${input.qitemId} is already closed toward ${source.closureTarget ?? "<no closure_target>"} — this re-drive names ${input.closureTarget}; surfacing the conflict, never overwriting`,
        {
          qitemId: input.qitemId,
          existingClosureTarget: source.closureTarget,
          attemptedClosureTarget: input.closureTarget,
        },
      );
    }

    const ts = new Date().toISOString();
    const events: Array<import("./types.js").RigEvent> = [];

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = ?,
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?`
        )
        .run(input.terminalState, ts, input.toSession, input.closureTarget, input.qitemId);

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: input.terminalState,
        actorSession: input.fromSession,
        // BR-1: the minted note carries the TWO-PART toSession only — the
        // host-qualified 3-part form is allowed in closure_target and nowhere
        // else, and transition_note is a durable carrier.
        transitionNote: input.transitionNote ?? `cross-host handoff to ${input.toSession}`,
        closureReason: "handed_off_to",
        closureTarget: input.closureTarget,
      });

      const handoffEvent = this.eventBus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: input.qitemId,
        fromSession: input.fromSession,
        // The event body is a session-string carrier — two-part only (BR-1).
        toSession: input.toSession,
        closureReason: "handed_off_to",
        summary: source.summary ?? null,
      });
      events.push(handoffEvent);
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e as PersistedEvent);
    }

    return { item: this.getByIdOrThrow(input.qitemId), absorbed: false };
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
        summary: qitem.summary ?? null,
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
        summary: qitem.summary ?? null,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(qitemId);
  }

  /**
   * General state mutator. Routes through hot-potato strict-rejection on
   * `done` transitions. All transitions append to the log.
   *
   * Phase B R2: emits queue.updated event atomically with the UPDATE +
   * transition log append, so the view-event-bridge can wake SSE consumers
   * on /api/views/:name/sse for normal state transitions (pending → blocked,
   * in-progress → done, closure, escalation). Phase A write semantics are
   * UNCHANGED — only an additional event emission inside the existing
   * transaction. This is an explicit narrow event-only extension to a
   * Phase A write surface so update-path mutations are visible to the
   * view bridge.
   */
  update(input: QueueUpdateInput): QueueItem {
    const txn = this.db.transaction(() => this.updateInTransactionalContext(input));
    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(input.qitemId);
  }

  /**
   * PL-004 Phase D extension point (orch-ratified per slice IMPL Driver
   * Handoff Contract / Guard R1 repair). Same closure validation +
   * UPDATE + transition log + queue.updated event as update(), but
   * runs inside the caller's outer db.transaction so it composes with
   * workflow-projector's transactional-scribe contract.
   *
   * Caller MUST:
   *   1. Invoke from inside a `db.transaction(() => {...})` block.
   *   2. After the outer txn commits, call:
   *        eventBus.notifySubscribers(persistedEvent)
   *   3. NOT call this from outside a transaction (will produce a
   *      half-state if the caller errors before committing).
   *
   * Closure validation runs at call time (before the UPDATE) so a
   * Phase A invariant violation (e.g., state=done without closure_reason)
   * throws before the workflow projector's outer transaction can commit
   * any partial state. The Phase A hot-potato strict-rejection rule
   * therefore applies to workflow projection unchanged.
   */
  updateWithinTransaction(input: QueueUpdateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
  } {
    const persistedEvent = this.updateInTransactionalContext(input);
    return { qitemId: input.qitemId, persistedEvent };
  }

  /**
   * Internal: closure validation + UPDATE + transition log + emit
   * queue.updated event. Caller is responsible for transaction wrapping
   * (the public update() wraps; the public updateWithinTransaction()
   * composes inside the caller's outer transaction).
   */
  private updateInTransactionalContext(input: QueueUpdateInput): PersistedEvent {
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

    // OPR.0.4.6.WF3 FR-6 — the frontier close-path guard (pm ruling:
    // PREVENTION over detection). A TERMINAL closure (done/handed-off)
    // of a LIVE workflow-frontier packet from a NON-workflow verb
    // would strand the instance: the frontier would reference a
    // closed packet and the workflow's own bookkeeping (trail,
    // rebind, events) would never happen. Reject LOUD with
    // what/why/fix naming the workflow verbs. The workflow domain's
    // own writers pass viaWorkflowVerb (they hold the invariant);
    // non-workflow qitems return null from the predicate — closure
    // behavior byte-identical (the zero-friction negative).
    const isTerminalClosure = isTerminalState(input.state);
    if (isTerminalClosure && !input.viaWorkflowVerb && this.workflowFrontierPredicate) {
      const binding = this.workflowFrontierPredicate(input.qitemId);
      if (binding) {
        throw new QueueRepositoryError(
          "workflow_frontier_packet",
          `qitem ${input.qitemId} is the LIVE frontier packet of workflow instance ${binding.instanceId} (${binding.workflowName}). Closing it out-of-band would strand the workflow. Use the workflow verbs instead: rig workflow project (advance) | rig workflow route (re-target the owner).`,
          { instanceId: binding.instanceId, workflowName: binding.workflowName, qitemId: input.qitemId },
        );
      }
    }

    // OPR.0.4.4.19 FR-6 — leg-1 park (state=blocked on a HUMAN-seat blocker):
    // enforce summary + evidence_ref at the park moment, evaluated on the
    // EFFECTIVE values (provided on this call, else already on the item) so
    // an item that carried them from create parks without re-entry. The
    // enforcement is here at the write path — the `rig queue block` verb and
    // raw `update --state blocked` hit the same validator (no verb-only
    // enforcement). Blocking on another qitem requires nothing new (BR-1).
    const effectiveBlockedOn = input.blockedOn ?? qitem.blockedOn;
    const isHumanPark = input.state === "blocked" && isHumanSeatSession(effectiveBlockedOn);
    let effectiveSummary = qitem.summary;
    let effectiveEvidenceRef = qitem.evidenceRef;
    if (isHumanPark) {
      effectiveSummary = input.summary ?? qitem.summary;
      effectiveEvidenceRef = input.evidenceRef ?? qitem.evidenceRef;
      const park = validateHumanPark({
        blockedOn: effectiveBlockedOn,
        summary: effectiveSummary,
        evidenceRef: effectiveEvidenceRef,
      });
      if (!park.ok) {
        throw new QueueRepositoryError(park.code, park.message, {
          missingFields: park.missingFields,
        });
      }
    }

    const ts = new Date().toISOString();
    const fromState = qitem.state;

    this.db
      .prepare(
        `UPDATE queue_items
           SET state = ?,
               ts_updated = ?,
               closure_reason = COALESCE(?, closure_reason),
               closure_target = COALESCE(?, closure_target),
               handed_off_to = COALESCE(?, handed_off_to),
               blocked_on = COALESCE(?, blocked_on)
         WHERE qitem_id = ?`
      )
      .run(
        input.state,
        ts,
        validation.closureReason,
        validation.closureTarget,
        input.handedOffTo ?? null,
        input.blockedOn ?? null,
        input.qitemId
      );

    // FR-6: park-time summary/evidence_ref are PERSISTED onto the existing
    // item (not merely validated-then-dropped) — visible to the attention
    // query and to Packet 2. Only the park path writes them.
    if (isHumanPark) {
      this.persistSummary(input.qitemId, input.summary ?? null);
      this.persistEvidenceRef(input.qitemId, input.evidenceRef ?? null);
    }

    this.transitionLog.append({
      qitemId: input.qitemId,
      state: input.state,
      actorSession: input.actorSession,
      transitionNote: input.transitionNote,
      closureReason: validation.closureReason ?? undefined,
      closureTarget: validation.closureTarget ?? undefined,
    });

    return this.eventBus.persistWithinTransaction({
      type: "queue.updated",
      qitemId: input.qitemId,
      fromState,
      toState: input.state,
      closureReason: validation.closureReason ?? null,
      closureTarget: validation.closureTarget ?? null,
      actorSession: input.actorSession,
      // FR-1 × FR-6: the event carries the summary as of THIS mutation
      // (park-time summary included) so surfaces refresh without a fetch.
      summary: effectiveSummary ?? null,
    });
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

    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    if (opts?.asSession) {
      conditions.push("(destination_session = ? OR source_session = ?)");
      params.push(opts.asSession, opts.asSession);
    }
    if (opts?.activeOnly && !opts?.state) {
      conditions.push("state IN ('pending', 'in-progress', 'blocked')");
    }
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
    if (opts?.targetRepo && this.hasTargetRepoColumn) {
      conditions.push("target_repo = ?");
      params.push(opts.targetRepo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const columns = opts?.compact
      ? "qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, blocked_on, handed_off_to, handed_off_from, expires_at, closure_reason, closure_target, closure_required_at, claimed_at, last_nudge_attempt, last_nudge_result, last_heartbeat, resolution, target_repo"
      : "*";
    const useActiveFirst = !!(opts?.rig || opts?.asSession || opts?.activeOnly);
    const orderBy = useActiveFirst
      ? "CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END, ts_created DESC"
      : "ts_created DESC";
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM queue_items ${where} ORDER BY ${orderBy} LIMIT ?`
      )
      .all(...params) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * OPR.0.3.2.20 — durable attention-class query.
   *
   * Returns OPEN attention-class qitems (the source of truth for the
   * For You Action-required + Approval lenses) by pushing the
   * attention predicate INTO the SQL WHERE clause so the LIMIT
   * applies AFTER attention filtering. This makes the result
   * window-INDEPENDENT by construction: an old human-gate item
   * cannot be evicted past LIMIT by routine open qitems even when
   * there are >>LIMIT of them. (Guard verdict qitem-20260518190827
   * BLOCKER 1 — the prior fetch-then-filter approach in the route
   * could still hide attention items behind ATTENTION_FETCH_BOUND
   * newer routine open qitems.)
   *
   * Attention predicate in SQL (mirror of mission-control read
   * layer + the route-level `isAttentionItem`):
   *   tier = 'human-gate'                              (approval)
   *   OR destination_session matches human-seat regex  (action-required)
   *
   * SQLite has no native regex; LIKE patterns are used as a
   * SUPER-SET (every regex match also matches one of the LIKE
   * patterns). Callers can refine in JS with isAttentionItem if
   * they need strict regex semantics — but for the LIMIT-pushdown
   * guarantee, the SQL superset is what matters: NO attention item
   * is filtered out by the SQL stage.
   *
   * Default open state set: pending|in-progress|blocked. Caller may
   * override via `state`.
   */
  listAttention(opts?: {
    limit?: number;
    state?: QueueState | QueueState[];
    destinationSession?: string;
    sourceSession?: string;
    targetRepo?: string;
  }): QueueItem[] {
    const limit = opts?.limit ?? 100;
    const states = opts?.state
      ? Array.isArray(opts.state) ? opts.state : [opts.state]
      : ["pending" as QueueState, "in-progress" as QueueState, "blocked" as QueueState];

    // Compose the WHERE clause: state-set + attention predicate +
    // optional scope filters (mirrors list() composition so
    // `attention=1` query params remain composable with
    // destinationSession/sourceSession/targetRepo — guard re-verify
    // qitem-20260518192210 BLOCKER 1).
    const statePlaceholders = states.map(() => "?").join(", ");
    // The attention predicate is EXACT in SQL (guard re-verify-3
    // qitem-20260518193005 BLOCKER 1): is_human_seat_session evaluates
    // the strict regex registered in the QueueRepository constructor.
    // Malformed rows that would have slipped through a LIKE superset
    // (e.g., 'human-@kernel' — empty name segment) are rejected at
    // the SQL stage, BEFORE LIMIT, so they cannot saturate the LIMIT
    // window and hide valid attention items.
    // OPR.0.4.4.19 FR-6 — the attention predicate gains the leg-1 park
    // clause: a qitem parked as state=blocked on a HUMAN-seat blocker is a
    // decision the human owes. Blocking on another qitem (today's shipped
    // usage) does NOT match — is_human_seat_session rejects qitem ids.
    const conditions: string[] = [
      `state IN (${statePlaceholders})`,
      `(
        tier = 'human-gate'
        OR is_human_seat_session(destination_session) = 1
        OR (state = 'blocked' AND is_human_seat_session(blocked_on) = 1)
      )`,
    ];
    const params: unknown[] = [...states];
    if (opts?.destinationSession) {
      conditions.push("destination_session = ?");
      params.push(opts.destinationSession);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }
    if (opts?.targetRepo && this.hasTargetRepoColumn) {
      conditions.push("target_repo = ?");
      params.push(opts.targetRepo);
    }
    params.push(limit);

    const sql = `
      SELECT * FROM queue_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY ts_created DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
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

  /** OPR.0.4.1.18 — persist the optional human-readable summary additively.
   *  Guarded by detectQueueColumn so fixtures on a pre-044 schema (no summary
   *  column) are unaffected; only writes when a value is present (NULL is the
   *  default and degrades in the Story consumer). Runs inside the caller's
   *  transaction (create / handoff / handoff-and-complete). */
  private persistSummary(qitemId: string, summary: string | null): void {
    if (this.hasSummaryColumn && summary !== null) {
      this.db.prepare("UPDATE queue_items SET summary = ? WHERE qitem_id = ?").run(summary, qitemId);
    }
  }

  /** OPR.0.4.4.19 FR-5 — persist the optional evidence_ref additively, same
   *  contract as persistSummary (pre-048 fixtures degrade; NULL default). */
  private persistEvidenceRef(qitemId: string, evidenceRef: string | null): void {
    if (this.hasEvidenceRefColumn && evidenceRef !== null) {
      this.db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(evidenceRef, qitemId);
    }
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
      body: row.body ?? "",
      // OPR.0.4.1.18: summary present only when migration 044 has applied;
      // legacy/minimal fixtures supply rows where summary is undefined → null.
      summary: row.summary ?? null,
      // OPR.0.4.4.19 FR-5: evidence_ref present only when migration 048 has
      // applied; legacy fixtures degrade to null.
      evidenceRef: row.evidence_ref ?? null,
      closureReason: row.closure_reason as ClosureReason | null,
      closureTarget: row.closure_target,
      closureRequiredAt: row.closure_required_at,
      claimedAt: row.claimed_at,
      lastNudgeAttempt: row.last_nudge_attempt,
      lastNudgeResult: row.last_nudge_result,
      lastHeartbeat: row.last_heartbeat,
      resolution: row.resolution,
      // PL-007: target_repo present only when migration 038 has applied;
      // older test fixtures supply legacy rows where target_repo is undefined.
      targetRepo: row.target_repo ?? null,
    };
  }
}

function isQueueState(value: string): value is QueueState {
  return (QUEUE_STATES as readonly string[]).includes(value);
}
