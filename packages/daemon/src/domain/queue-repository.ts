import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import { loadHumanRegistry } from "./gateway/human-registry.js";
import { resolveExternal } from "./gateway/external-admission.js";
import type { PersistedEvent } from "./types.js";
import { QueueTransitionLog } from "./queue-transition-log.js";
import { WAKE_INTENT_PREFIX, type OutboxHandler } from "./outbox-handler.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";
import { getSelfHostId } from "./hosts/fanout-contract.js";
import { parseSessionName } from "./session-name.js";
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
  /** Present only on compact list rows so omitted content cannot be mistaken
   *  for an author-supplied empty value. Full reads never carry this marker. */
  fieldsElided?: Array<"body" | "summary" | "evidenceRef">;
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
    // (h): stampISO threads the nudge's compose time so the transport's delivered-latency calc can
    // measure the wait for a handoff nudge too (the real impl is SessionTransport, which accepts it).
    text: string,
    opts?: { verify?: boolean; stampISO?: string }
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
  /** P21 §4 era-stamp: the route passes `transport:v1` (sourceSession derived from the transport
   *  header chokepoint). Threaded onto the 'created' transition; absence = claimed-era. */
  identityProvenance?: string | null;
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
   * them. OPR.0.5.1 slice-51-06 D2: supplying them on a NON-park transition
   * is REJECTED (QueueRepositoryError "summary_evidence_not_persistable")
   * before any mutation — not silently ignored — so a caller never believes
   * unpersistable metadata was saved.
   */
  summary?: string | null;
  evidenceRef?: string | null;
  /** P21 §4 era-stamp: the route passes `transport:v1` (actorSession derived from the transport
   *  header chokepoint). Threaded onto the transition; absence = claimed-era. */
  identityProvenance?: string | null;
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
  /** P21 §4 era-stamp: the route passes `transport:v1` (fromSession derived from the transport
   *  header chokepoint). Threaded onto both the source-close and new-item transitions. */
  identityProvenance?: string | null;
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
  /** P21 §4 era-stamp: the route passes `transport:v1` (destinationSession derived from the
   *  transport header chokepoint). Threaded onto the claim transition; absence = claimed-era. */
  identityProvenance?: string | null;
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
// Reduced column set for compact list rows (body/summary/evidence_ref omitted →
// rowToItem backfills them empty). Shared by `list` and `findOverdue` (Slice 15)
// so the compact projection cannot drift between the two.
const COMPACT_QUEUE_COLUMNS =
  "qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, blocked_on, handed_off_to, handed_off_from, expires_at, closure_reason, closure_target, closure_required_at, claimed_at, last_nudge_attempt, last_nudge_result, last_heartbeat, resolution, target_repo";

/**
 * 51-09 increment 4 — stamp-at-write: the STORED `source_session` IS the origin
 * triple `<member>@<rig>@<selfHostId>`, matching the envelope's always-suffix
 * rule (the daemon receiving a create is the sender's host, so getSelfHostId()
 * is the sender's host — captured at write, correct even for a row later read
 * cross-host). FAIL-OPEN: when the self-id is not yet reconciled (getSelfHostId()
 * null) OR the value is not a bare `member@rig` (legacy / malformed / already
 * carries a host suffix), the value is left UNCHANGED (today's 2-part) — no new
 * failure mode, existing 2-part behavior preserved wherever no self-id exists.
 * One convention (stamp-at-write), so every read surface sees the triple with no
 * render-time logic.
 */
export function stampSelfHostSuffix(session: string): string;
export function stampSelfHostSuffix(session: undefined): undefined;
export function stampSelfHostSuffix(session: string | undefined): string | undefined;
export function stampSelfHostSuffix(session: string | undefined): string | undefined {
  if (session === undefined) return undefined;
  const selfId = getSelfHostId();
  if (!selfId) return session;
  if (session.split("@").length !== 2) return session; // not a bare member@rig — untouched
  return `${session}@${selfId}`;
}

/**
 * 51-09 increment 4b — additive TEACHING for the unknown_destination_rig refusal
 * (arch ruling c9964404, mechanism ii). 3-part destinations ALREADY refuse (BR-1:
 * member@rig@host greedy-folds to rig "rig@host", misses, rejects) — the code is
 * UNCHANGED (C1). When the rejected destination's greedy-parsed rig token CONTAINS
 * '@', return ADDITIVE structured fields (FR-7 precedent) teaching the out-of-band
 * path: the split echo + a hint naming `--host`. C4: a SELF-suffixed destination
 * names the self case and is NEVER auto-stripped/routed home (self-strip is option
 * (i), routed to arch). Returns undefined for 2-part / non-canonical tokens (the
 * refusal is byte-unchanged there). One helper, all four refusal sites (C2). Reads
 * the FR-8 parse contract; the parse family stays byte-identical (C3).
 */
export function destinationRigTeaching(session: string): Record<string, unknown> | undefined {
  const parsed = parseSessionName(session);
  if (parsed.kind !== "canonical" || !parsed.rig.includes("@")) return undefined;
  const at = parsed.rig.lastIndexOf("@");
  const rig = parsed.rig.slice(0, at);
  const host = parsed.rig.slice(at + 1);
  const bare = `${parsed.member}@${rig}`;
  const selfId = getSelfHostId();
  const selfHost = !!selfId && host === selfId;
  return {
    destinationSplit: { member: parsed.member, rig, host },
    selfHost,
    hint: selfHost
      ? `the host suffix '@${host}' is THIS host — the host never rides in the session string; resend the destination as ${bare}`
      : `host does not ride in the session string; use --host ${host} with destination ${bare}`,
  };
}

/**
 * M1 A4b — entity-level teaching for an UNREGISTERED <local>@external destination (the
 * ENTITY half of proof-2; the DOMAIN half is the closed-set fall-through to
 * unknown_destination_rig, A1/A2). A row addressed to a valid @external domain whose
 * entity is not in the registry refuses LOUDLY with the structured teaching from the
 * gateway resolver (how to register + "not an agent seat"). Loads the registry only for
 * the (rare) @external refusal path. Undefined for non-@external / registered / scheme.
 */
export function externalAdmissionTeaching(session: string): Record<string, unknown> | undefined {
  const parsed = parseSessionName(session);
  if (parsed.kind !== "external") return undefined;
  const reg = loadHumanRegistry();
  const entities = reg.ok ? reg.entities.map((e) => ({ entityId: e.entityId, address: e.address })) : [];
  const res = resolveExternal(parsed.local, entities);
  if (res.kind !== "unregistered") return undefined; // registered/scheme were admitted upstream
  return { externalDomain: parsed.domain, unregisteredEntity: parsed.local, hint: res.error };
}

/** The refusal teaching for ANY rejected destination: the @external entity teaching
 *  (A4b) OR the host-suffix teaching (4b). One helper, all four refusal sites. */
export function destinationRefusalTeaching(session: string): Record<string, unknown> | undefined {
  return externalAdmissionTeaching(session) ?? destinationRigTeaching(session);
}

/**
 * MF6: does a transport error/reason string denote a TIMEOUT (ambiguous — the
 * send may have landed) rather than a definite failure? Used to classify a wake
 * delivery as `indeterminate` vs `failed`.
 */
function isWakeTimeoutSignal(s: string | undefined): boolean {
  return !!s && /timeout|timed\s*out|etimedout/i.test(s);
}

export class QueueRepository {
  readonly db: Database.Database;
  readonly transitionLog: QueueTransitionLog;
  private readonly eventBus: EventBus;
  private readonly validateRig: (sessionRef: string) => boolean;
  private transport: QueueNudgeTransport | undefined;
  /** W1 (transactional closure): the durable wake-intent store. A terminal act
   *  (handoff / handoff-and-complete) stages an outbox intent row INSIDE its
   *  db.transaction so close + transition + intent commit as one act or none;
   *  the delivery drains from that committed intent afterward. Wired post-
   *  construction by startup (dep-graph ordering, like transport). Absent =
   *  test/bootstrap path with no durable-intent requirement (the wake still
   *  fires best-effort via maybeNudge, exactly as pre-W1). */
  private outbox: OutboxHandler | undefined;
  private resolveOccupantGeneration?: (sessionName: string) => string | null;
  /** PL-007 Workspace Primitive — true when migration 038 has applied the
   *  queue_items.target_repo column. Older test fixtures that bypass the
   *  canonical migration list don't have the column; INSERTs degrade to
   *  the pre-PL-007 statement and target_repo input is silently dropped.
   *  Production daemons always have the column (migration is in startup.ts). */
  private readonly hasTargetRepoColumn: boolean;
  private readonly hasSummaryColumn: boolean;
  private readonly hasEvidenceRefColumn: boolean;
  private readonly hasMintingGenColumn: boolean;
  private readonly hasClaimedGenColumn: boolean;
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
      /**
       * GHOST-STAGE (h): resolve the SOURCE seat's atom-B occupant generation-uuid so a handoff
       * nudge carries the composing generation on its Sent: line (the injected-predicate precedent —
       * the queue is the lower primitive and never imports the session domain; startup wires
       * SessionRegistry.currentOccupantGenerationForSession in). Absent ⇒ UNKNOWN ⇒ the gen suffix
       * is omitted (never forged).
       */
      resolveOccupantGeneration?: (sessionName: string) => string | null;
    }
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.transitionLog = new QueueTransitionLog(db);
    this.validateRig = opts?.validateRig ?? (() => true);
    this.transport = opts?.transport;
    this.workflowFrontierPredicate = opts?.workflowFrontierPredicate;
    this.resolveOccupantGeneration = opts?.resolveOccupantGeneration;
    this.hasTargetRepoColumn = detectQueueColumn(db, "target_repo");
    this.hasSummaryColumn = detectQueueColumn(db, "summary");
    this.hasEvidenceRefColumn = detectQueueColumn(db, "evidence_ref");
    // GHOST-STAGE (e/Class-B): generation stamps (migration 063). Defensive detect so a pre-063
    // harness degrades (writers skip the columns; the release predicate never matches unstamped rows).
    this.hasMintingGenColumn = detectQueueColumn(db, "minting_generation_uuid");
    this.hasClaimedGenColumn = detectQueueColumn(db, "claimed_by_generation_uuid");

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
   * W1 (transactional closure): attach the durable wake-intent store AFTER
   * construction (same dep-graph reason as {@link attachTransport}). Once
   * attached, handoff / handoff-and-complete stage an outbox intent row inside
   * their terminal transaction, so the close and its wake intent are one commit.
   */
  attachOutbox(outbox: OutboxHandler): void {
    // MF2: the wake intent must commit INSIDE the terminal transaction, which is
    // only true when the outbox writes on the SAME connection. An outbox backed by
    // a different DB would let the intent survive a rolled-back close (or vice
    // versa) — "neither one act nor none". Reject a split-DB outbox at wire time.
    if (outbox.db !== this.db) {
      throw new QueueRepositoryError(
        "outbox_db_mismatch",
        "attachOutbox requires an OutboxHandler bound to the SAME database connection as the queue repository — a split DB breaks the atomic close+intent seam",
      );
    }
    this.outbox = outbox;
  }

  /**
   * W1 (transactional closure) — the PUBLIC composable primitive (stage half).
   * Stage the durable WAKE INTENT for a successor qitem from INSIDE a terminal
   * act's `db.transaction` (the queue's own connection), so the intent commits
   * atomically with the close + transition. Public + composable so any
   * close+successor writer — handoff / handoff-and-complete today, Mission Control
   * / Workflow via the P34 follow-on — can call it within its own transaction (the
   * `createWithinTransaction` precedent), making that wiring pure EXTENSION, not
   * rework. Pair with {@link assertTerminalClosureHasIntent}, run as the LAST
   * statement of the same transaction.
   *
   * The pane nudge itself is a post-commit side effect (reversed-never — a pane
   * write inside the txn would make the transaction lie); what is durable is this
   * intent row, which the delivery drains afterward. Freezes the emitting envelope
   * (MF4); idempotent by a deterministic outbox id keyed on the successor.
   * `nudge:false` intends no wake ⇒ no intent. A missing outbox is enforced by the
   * guard (fail-closed, MF2), not silently skipped here.
   */
  stageWakeIntent(
    successorQitemId: string,
    fromSession: string,
    toSession: string,
    identityProvenance: string | null,
    nudge: boolean | undefined,
  ): void {
    // No wake intended (nudge:false) ⇒ no durable intent to make durable. The
    // W1-c guard is nudge-aware for the same reason: absence of an intent is a
    // defect only when a wake WAS intended.
    if (nudge === false) return;
    if (!this.outbox) return;
    // MF4: FREEZE the emitting envelope at stage time. Resolve the source occupant
    // generation and build the full pane envelope NOW, and store it verbatim as the
    // intent body. Delivery (immediate or crash-recovery) replays this exact text,
    // so a recovery after a tenure swap can never relabel the wake with the CURRENT
    // occupant's generation — it carries the generation that actually emitted it.
    const bareBody = `Queue handoff: ${successorQitemId} - check your queue.`;
    const stampISO = new Date().toISOString();
    const genUuid = this.resolveOccupantGeneration?.(fromSession) ?? undefined;
    const frozenEnvelope = wrapPaneEnvelope(fromSession, toSession, bareBody, getSelfHostId(), { stampISO, genUuid });
    this.outbox.record({
      outboxId: `${WAKE_INTENT_PREFIX}${successorQitemId}`,
      senderSession: fromSession,
      destinationSession: toSession,
      body: frozenEnvelope,
      auditPointer: successorQitemId,
      identityProvenance: identityProvenance ?? null,
    });
  }

  /**
   * W1-c (transactional closure): the runtime SEAM GUARD. Called as the LAST
   * statement inside a terminal act's db.transaction, it makes an
   * executed-but-unwoken close UNWRITABLE: if this transaction wrote a terminal
   * close AND a wake was intended, a durable wake intent for the successor MUST
   * exist in the same transaction. If it does not, throw — the whole act rolls
   * back at the seam, not at review.
   *
   * Nudge-aware: nudge:false intends no wake, so no intent is required. MF2:
   * fail-closed when a wake IS intended but no intent store is attached (the
   * guarantee is then impossible). PUBLIC composable primitive (guard half): any
   * close+successor writer runs this as the LAST statement of its own transaction
   * — handoff / handoff-and-complete today, Mission Control / Workflow via P34.
   */
  assertTerminalClosureHasIntent(
    sourceQitemId: string,
    successorQitemId: string,
    nudge: boolean | undefined,
  ): void {
    if (nudge === false) return; // no wake intended ⇒ no intent required
    // MF2: fail CLOSED. A nudge-intended terminal act with no intent store cannot
    // make its wake durable, so the guarantee is impossible — refuse the close
    // rather than silently produce an executed-but-unwoken item (the exact class
    // W1 makes unwritable). Production always attaches an outbox at startup.
    if (!this.outbox) {
      throw new QueueRepositoryError(
        "wake_intent_store_unavailable",
        "a nudge-intended terminal act requires an attached wake-intent store to make its wake durable — none attached (pass nudge:false for a wake-less close, or attach an outbox)",
      );
    }
    // Reads the txn-visible (uncommitted) state on this connection.
    const src = this.getById(sourceQitemId);
    if (!src || !isTerminalState(src.state)) return; // not a terminal close
    const intent = this.outbox.getById(`${WAKE_INTENT_PREFIX}${successorQitemId}`);
    if (!intent) {
      throw new QueueRepositoryError(
        "terminal_close_without_wake_intent",
        `terminal closure of ${sourceQitemId} committed without staging its wake intent for ${successorQitemId} — one act or none is violated`,
      );
    }
  }

  /**
   * W1-b: deliver ONE committed wake intent. MF3: CLAIM (pending→sending) before
   * the external send, then finalize (sending→outcome) after — so overlapping
   * drains send the wake exactly ONCE (the effect, not just the state), and a
   * second drain of an already-claimed/resolved intent skips. Returns what
   * happened for the drain's tally.
   *
   *   verified          → delivered
   *   ok, unverified    → indeterminate   (ambiguous; never silently delivered/failed)
   *   timeout (MF6)     → indeterminate   (may have landed — not a hard failure)
   *   other not-ok/throw→ failed          (visible terminal state)
   */
  private async deliverWakeIntent(
    outboxId: string,
  ): Promise<"delivered" | "indeterminate" | "failed" | "skipped"> {
    if (!this.outbox) return "skipped";
    if (!this.transport) return "skipped"; // no transport → stays pending for a later drain
    // MF3: CLAIM (pending→sending) BEFORE the external send so overlapping drains
    // cannot both send. A losing claim — the row is no longer `pending` (already
    // resolved, in-flight under another drainer, or claimed) — simply skips: no
    // send, no tally. This makes the external effect once, not merely the state.
    if (!this.outbox.claimForDelivery(outboxId)) return "skipped";
    const intent = this.outbox.getById(outboxId);
    if (!intent) return "skipped"; // unreachable post-claim; defensive
    // MF5 (defense in depth): only deliver a wake for a qitem that actually exists.
    // A wake intent whose target qitem is missing — a forgery that slipped the
    // route reservation, or a successor already swept — is finalized `failed`,
    // never sent as a real wake.
    if (!intent.auditPointer || !this.getById(intent.auditPointer)) {
      this.outbox.finalizeDelivery(outboxId, "failed");
      return "failed";
    }
    const qitemId = intent.auditPointer ?? outboxId;
    // MF4: send the FROZEN envelope stored on the intent verbatim (no re-resolution).
    const outcome = await this.performWakeSend(
      qitemId, intent.destinationSession, intent.senderSession, undefined, intent.body,
    );
    this.recordNudgeAttempt(qitemId, outcome.nudgeResult);
    const finalState = outcome.classified === "verified" ? "delivered" : outcome.classified;
    this.outbox.finalizeDelivery(outboxId, finalState);
    return finalState;
  }

  /**
   * W1-b: the post-commit delivery for a successor's wake, and the ONE shared
   * staged-intent delivery path. When the durable intent store is present
   * (production), deliver the just-committed intent — which CLAIMS and FINALIZES
   * the row, so a later recovery sweep cannot send it a second time. When it is
   * absent (test/bootstrap), fall back to the pre-W1 best-effort nudge so behavior
   * is unchanged where there is no intent to make durable. Called AFTER the
   * terminal transaction commits (reversed-never: a pane write must not join the
   * db transaction).
   *
   * PUBLIC as of P34: every terminal-closing writer that stages an intent must
   * deliver through THIS path rather than {@link maybeNudge}. `maybeNudge` sends
   * WITHOUT claiming or finalizing, so a staged intent would remain `pending` and
   * the startup recovery sweep would deliver the same wake AGAIN. One staged
   * intent, one delivery, one finalized row.
   *
   * P34 correction: the no-outbox fallback above was documented here but never
   * implemented — `deliverWakeIntent` simply returns "skipped" with no outbox
   * attached, so the nudge vanished SILENTLY (a skip is not an error, so nothing
   * surfaced it). The pre-W1 callers reached this path only after the MF2 guard
   * had already proven an outbox was attached, which is why it never showed. P34
   * routes writers here whose harnesses attach no outbox, so the fallback is now
   * real code rather than a promise in a comment.
   */
  async deliverWakeForSuccessor(
    successorQitemId: string,
    destinationSession: string,
    nudge: boolean | undefined,
    sourceSession?: string,
  ): Promise<void> {
    if (nudge === false) return;
    // No durable intent store ⇒ there is no intent to claim/finalize. Fall back to
    // the pre-W1 best-effort nudge so the wake still happens (the documented
    // contract), rather than silently skipping it.
    if (!this.outbox) {
      await this.maybeNudge(successorQitemId, destinationSession, nudge, sourceSession);
      return;
    }
    await this.deliverWakeIntent(`${WAKE_INTENT_PREFIX}${successorQitemId}`);
  }

  /**
   * W1-b: the startup-recovery sweep. Delivers wake intents a crash left
   * committed-but-undelivered (the terminal txn committed, the process died
   * before the post-commit deliver). Pages in bounded batches and TERMINATES on
   * a served short batch or on a no-progress round (a flapping transport marks
   * rows failed = visible, so it still progresses) — never a silent cap, never a
   * spin.
   *
   * MF6 (honest retry policy): the sweep retries ONLY `pending` rows — i.e. wake
   * intents a crash left committed-but-undelivered. Terminal `failed` and
   * `indeterminate` rows are NOT re-driven: a failed row would risk resurrecting
   * a dead wake and an indeterminate one may already have landed (double-send).
   * Both are left in a VISIBLE terminal state for out-of-band reconciliation. No
   * periodic timer (out of scope, ruled); a bounded retry of failed rows is the
   * NAMED residue, not a silent guarantee.
   */
  /**
   * BLOCKING 1 (guard re-seal): the recovery-boundary reconciliation, called ONCE
   * at startup (NOT inside the drain, which can be invoked concurrently). Moves any
   * abandoned `sending` wake intents — a prior crashed process's claims — to
   * `indeterminate`, WITHOUT re-sending: a claim left `sending` is ambiguous (the
   * send may or may not have landed). Kept SEPARATE from drainPendingWakeIntents so
   * an overlapping drain can never reconcile another drain's in-flight claim.
   * Returns the count reconciled.
   */
  reconcileAbandonedWakeIntents(): number {
    if (!this.outbox) return 0;
    return this.outbox.reconcileAbandonedSending(WAKE_INTENT_PREFIX);
  }

  async drainPendingWakeIntents(): Promise<{ delivered: number; indeterminate: number; failed: number }> {
    const tally = { delivered: 0, indeterminate: 0, failed: 0 };
    if (!this.outbox || !this.transport) return tally;
    const BATCH = 200;
    for (;;) {
      const pending = this.outbox.listPending(WAKE_INTENT_PREFIX, BATCH);
      if (pending.length === 0) break;
      let progressed = 0;
      for (const intent of pending) {
        const outcome = await this.deliverWakeIntent(intent.outboxId);
        if (outcome === "delivered") { tally.delivered++; progressed++; }
        else if (outcome === "indeterminate") { tally.indeterminate++; progressed++; }
        else if (outcome === "failed") { tally.failed++; progressed++; }
      }
      // Nothing left pending changed state this round (e.g. transport gone
      // mid-sweep) — stop rather than spin; the next daemon start retries.
      if (progressed === 0) break;
      if (pending.length < BATCH) break; // served short batch ⇒ drained
    }
    return tally;
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
   * came from + a reply hint. A queue nudge is the ONE non-refusable
   * sender — it has no seat to send an error back to — so when
   * `sourceSession` is undefined `wrapPaneEnvelope` applies its own
   * `<unknown sender>` fallback internally (`pane-envelope.ts`). After
   * A1 that is the SOLE definition of the marker in the tree (the CLI
   * copies were deleted, refused at the seat boundary instead); this
   * site holds no copy of its own.
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
    const outcome = await this.performWakeSend(qitemId, destinationSession, sourceSession, bodyOverride);
    this.recordNudgeAttempt(qitemId, outcome.nudgeResult);
  }

  /**
   * W1 (transactional closure): the shared wake-send CORE. Builds the pane
   * envelope, sends with verify, and CLASSIFIES the transport result into the W1
   * delivery vocabulary (verified | indeterminate | failed). It touches NO
   * persistence — callers decide what to record: {@link maybeNudge} records the
   * nudge attempt; {@link deliverWakeIntent} additionally CAS-marks the durable
   * intent row. Only ever called when `this.transport` is set (callers guard).
   *
   * The `indeterminate` classification is the ambiguous face: `res.ok && !res.verified`
   * — the delivery LANDED on the wire but its render could not be confirmed
   * (the "delivered-ack-pending" nudge literal). It is never promoted to
   * delivered nor demoted to failed.
   */
  private async performWakeSend(
    qitemId: string,
    destinationSession: string,
    sourceSession?: string,
    bodyOverride?: string,
    prebuiltText?: string,
  ): Promise<{ classified: "verified" | "indeterminate" | "failed"; nudgeResult: string }> {
    const stampISO = new Date().toISOString();
    let text: string;
    if (prebuiltText !== undefined) {
      // MF4: a durable wake intent carries its FROZEN envelope (generation resolved
      // at STAGE time). Deliver it verbatim — never rebuild — so a crash-recovery
      // after a tenure swap replays the emitting generation, not the current one.
      text = prebuiltText;
    } else {
      // OPR.0.4.4.19 FR-7: bodyOverride lets the resolve verb carry the
      // decision text to the parked owner; default stays the handoff nudge.
      const bareBody = bodyOverride ?? `Queue handoff: ${qitemId} - check your queue.`;
      // GHOST-STAGE (h): the single HG-5 baseline change deferred from g — the handoff nudge now carries
      // a Sent: stamp (so it renders byte-parically with a rig send) plus the SOURCE seat's occupant
      // generation (g's already-wired render, resolved here; absent=UNKNOWN=omit, never forged). The
      // stampISO also feeds the transport's delivered-latency flag so a nudge that waited on a busy /
      // mid-handover successor shows ' · delivered +Ns' for free.
      const genUuid = sourceSession
        ? (this.resolveOccupantGeneration?.(sourceSession) ?? undefined)
        : undefined;
      text = wrapPaneEnvelope(sourceSession, destinationSession, bareBody, getSelfHostId(), { stampISO, genUuid });
    }
    try {
      const res = await this.transport!.send(destinationSession, text, { verify: true, stampISO });
      // OPR.0.3.2.21.FR-4(c) — wording rename: the prior literal
      // "sent-unverified" read as a failure even in the common case
      // (delivery confirmed but the synchronous ack window expired,
      // which is normal for codex seats mid-task). The new literal
      // "delivered-ack-pending" reads as healthy. The old "verified"
      // case is unchanged for backward-compat with any tooling that
      // already consumed the positive literal.
      if (res.ok) {
        return res.verified
          ? { classified: "verified", nudgeResult: "verified" }
          : { classified: "indeterminate", nudgeResult: "delivered-ack-pending" };
      }
      // MF6: a TIMEOUT is ambiguous — the send may have landed but the ack window
      // expired — so it records `indeterminate` (never silently delivered, never a
      // hard `failed`). A definite non-timeout failure (unreachable, unknown
      // session) stays `failed`.
      const detail = res.error ?? res.reason ?? "unknown";
      if (isWakeTimeoutSignal(res.reason) || isWakeTimeoutSignal(res.error)) {
        return { classified: "indeterminate", nudgeResult: `indeterminate:${detail}` };
      }
      return { classified: "failed", nudgeResult: `failed:${detail}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A thrown timeout is equally ambiguous (see above).
      if (isWakeTimeoutSignal(msg)) {
        return { classified: "indeterminate", nudgeResult: `indeterminate:${msg}` };
      }
      return { classified: "failed", nudgeResult: `failed:${msg}` };
    }
  }

  async create(input: QueueCreateInput): Promise<QueueItem> {
    // 51-09 incr 4 — stamp the origin host onto the STORED sender identity once,
    // before validation/insert/idempotency, so the row's source_session IS the
    // triple (fail-open to 2-part when no self-id / not a bare member@rig).
    input = { ...input, sourceSession: stampSelfHostSuffix(input.sourceSession) };
    if (!this.validateRig(input.destinationSession)) {
      throw new QueueRepositoryError(
        "unknown_destination_rig",
        `destination_session ${input.destinationSession} references an unknown rig`,
        destinationRefusalTeaching(input.destinationSession),
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
        `destination_session ${input.destinationSession} references an unknown rig`,
        destinationRefusalTeaching(input.destinationSession),
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
    this.persistMintingGeneration(id, input.sourceSession);
    this.transitionLog.append({
      qitemId: id,
      state: "pending",
      actorSession: input.sourceSession,
      transitionNote: "created",
      identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
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
        `to_session ${input.toSession} references an unknown rig`,
        destinationRefusalTeaching(input.toSession),
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
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
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
      this.persistMintingGeneration(newId, input.fromSession);

      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff from ${source.qitemId}`,
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
      });

      // W1-a: the durable wake intent joins the SAME transaction as the close +
      // successor create. If this (or anything above) throws, the whole act rolls
      // back — one act or none.
      this.stageWakeIntent(newId, input.fromSession, input.toSession, input.identityProvenance ?? null, input.nudge);

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

      // W1-c: the seam guard — the LAST statement in the terminal txn. A close
      // that intended a wake cannot commit without its durable intent; a throw
      // here rolls the whole act back at the seam.
      this.assertTerminalClosureHasIntent(source.qitemId, newId, input.nudge);
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    // W1-b: deliver the just-committed wake intent (marking it), or the pre-W1
    // best-effort nudge when no intent store is attached. Post-commit only.
    await this.deliverWakeForSuccessor(newId, input.toSession, input.nudge, input.fromSession);

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
        `to_session ${input.toSession} references an unknown rig`,
        destinationRefusalTeaching(input.toSession),
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
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
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
      this.persistMintingGeneration(newId, input.fromSession);

      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff-and-complete from ${source.qitemId}`,
      });

      // W1-a: the durable wake intent joins the SAME transaction as the close +
      // successor create — one act or none (symmetric with handoff()).
      this.stageWakeIntent(newId, input.fromSession, input.toSession, input.identityProvenance ?? null, input.nudge);

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

      // W1-c: the seam guard — the LAST statement in the terminal txn. A close
      // that intended a wake cannot commit without its durable intent; a throw
      // here rolls the whole act back at the seam.
      this.assertTerminalClosureHasIntent(source.qitemId, newId, input.nudge);
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    // W1-b: deliver the just-committed wake intent (marking it), or the pre-W1
    // best-effort nudge when no intent store is attached. Post-commit only.
    await this.deliverWakeForSuccessor(newId, input.toSession, input.nudge, input.fromSession);

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

    // GHOST-STAGE (e/Class-B): stamp the CLAIMANT's occupant generation. THIS is the ghost
    // discriminator — under a handover the successor reuses the seat name, so a name-scoped release
    // would neutralize the successor's own claims; the retiring generation's claims are released by gen.
    const claimedByGeneration = this.hasClaimedGenColumn
      ? (this.resolveOccupantGeneration?.(input.destinationSession) ?? null)
      : null;

    const txn = this.db.transaction(() => {
      if (this.hasClaimedGenColumn) {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'in-progress', ts_updated = ?, claimed_at = ?, closure_required_at = ?,
                   claimed_by_generation_uuid = ?
             WHERE qitem_id = ?`
          )
          .run(ts, ts, closureRequiredAt, claimedByGeneration, input.qitemId);
      } else {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'in-progress', ts_updated = ?, claimed_at = ?, closure_required_at = ?
             WHERE qitem_id = ?`
          )
          .run(ts, ts, closureRequiredAt, input.qitemId);
      }

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: "in-progress",
        actorSession: input.destinationSession,
        transitionNote: "claimed",
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
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

  unclaim(qitemId: string, destinationSession: string, reason: string, identityProvenance?: string | null): QueueItem {
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
      // (e/Class-B): returning to pending releases the claim, so clear the claimant-generation stamp
      // (the item is now unclaimed; a fresh claimant will re-stamp its own generation).
      const clearGen = this.hasClaimedGenColumn ? ", claimed_by_generation_uuid = NULL" : "";
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'pending',
                 ts_updated = ?,
                 claimed_at = NULL,
                 closure_required_at = NULL${clearGen}
           WHERE qitem_id = ?`
        )
        .run(ts, qitemId);

      this.transitionLog.append({
        qitemId,
        state: "pending",
        actorSession: destinationSession,
        transitionNote: `unclaimed: ${reason}`,
        identityProvenance: identityProvenance ?? null, // P21 §4 era-stamp
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

    // OPR.0.5.1 slice-51-06 D2 — summary/evidence_ref are persist-able ONLY at a human-seat park
    // (see the FR-6 note below). Silently ignoring them on any other transition is a data-loss trap
    // (the operator believes the metadata was saved). HARD-REJECT before ANY UPDATE/log/event so the
    // caller learns immediately and nothing is half-applied. null/undefined = absent (allowed);
    // empty string = present (a deliberate value → rejected on a non-park transition).
    if (!isHumanPark) {
      const invalidFields: Array<"summary" | "evidenceRef"> = [];
      if (input.summary != null) invalidFields.push("summary");
      if (input.evidenceRef != null) invalidFields.push("evidenceRef");
      if (invalidFields.length > 0) {
        const flags = invalidFields.map((f) => (f === "summary" ? "--summary" : "--evidence-ref")).join(" / ");
        throw new QueueRepositoryError(
          "summary_evidence_not_persistable",
          `${invalidFields.join(" + ")} persist only on a human-seat park (state=blocked on a human seat); the '${input.state}' transition cannot store them. Remove ${flags}, or park the item (rig queue block --on <human-seat> --summary … --evidence-ref …).`,
          { invalidFields },
        );
      }
    }

    // SWEEP-a (shape f2576102) — closure/blocked-field COHERENCE, beside the reference
    // reject above: an incoherent field must never silently persist (worse than a drop —
    // the COALESCE below would write it). Admits-map, derived from LIVE schema use:
    //   closure_reason/closure_target → state "done", OR the PARK-RECORD form
    //     (state "blocked" with closureReason "blocked_on" — the workflow gate/park
    //     writers' established shape, workflow-runtime.ts:587/1013);
    //   blocked_on → state "blocked" only.
    const isParkRecord = input.state === "blocked" && input.closureReason === "blocked_on";
    // Third live form (found by the neighborhood suites): the transactional handoff
    // closes its source as state "handed-off" with closureReason "handed_off_to".
    const isHandoffClose = input.state === "handed-off" && input.closureReason === "handed_off_to";
    if (input.state !== "done" && !isParkRecord && !isHandoffClose && (input.closureReason != null || input.closureTarget != null)) {
      throw new QueueRepositoryError(
        "closure_fields_not_admitted",
        `closure_reason/closure_target persist only on state=done (or the blocked park-record form); the '${input.state}' transition cannot store them. Close the item (--state done --closure-reason …) or drop the flags.`,
        {},
      );
    }
    if (input.blockedOn != null && input.state !== "blocked") {
      throw new QueueRepositoryError(
        "blocked_on_not_admitted",
        `blocked_on persists only on state=blocked; the '${input.state}' transition cannot store it. Park the item (rig queue block --on …) or drop --blocked-on.`,
        {},
      );
    }

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
      identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
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
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS : "*";
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
    const items = rows.map((r) => this.rowToItem(r));
    return opts?.compact
      ? items.map((item) => ({
          ...item,
          fieldsElided: ["body", "summary", "evidenceRef"],
        }))
      : items;
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
   *
   * Slice 15 (finding 2): optionally rig-scoped, limited, and compact — mirroring
   * `list` — so `rig queue overdue` is bounded and body-free by default instead of
   * dumping every rig's full qitem bodies to a single caller. No args = the prior
   * behavior (all overdue, full rows) for the watchdog.
   */
  findOverdue(opts?: { now?: string; rig?: string; limit?: number; compact?: boolean }): QueueItem[] {
    const cutoff = opts?.now ?? new Date().toISOString();
    const conditions = ["state = 'in-progress'", "closure_required_at IS NOT NULL", "closure_required_at <= ?"];
    const params: unknown[] = [cutoff];
    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS : "*";
    let sql = `SELECT ${columns} FROM queue_items WHERE ${conditions.join(" AND ")} ORDER BY closure_required_at ASC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
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

  /** GHOST-STAGE (e/Class-B) — persist the MINTING occupant-generation additively (same degrade
   *  contract as persistSummary; NULL when unresolved/pre-063). Forensic provenance of the creator;
   *  the RELEASE discriminator is claimed_by_generation_uuid (stamped at claim), not this. */
  private persistMintingGeneration(qitemId: string, sourceSession: string): void {
    if (!this.hasMintingGenColumn) return;
    const gen = this.resolveOccupantGeneration?.(sourceSession) ?? null;
    if (gen === null) return;
    this.db.prepare("UPDATE queue_items SET minting_generation_uuid = ? WHERE qitem_id = ?").run(gen, qitemId);
  }

  /**
   * GHOST-STAGE (e/Class-B) — at a seat swap, RELEASE (never hard-drop) every in-progress item CLAIMED
   * by the RETIRING generation back to pending: the role work is durable and the successor re-claims it;
   * only the retiree's stale claim is the ghost. Gen-scoped via claimed_by_generation_uuid (NOT the seat
   * name — the successor shares it, so a name-scoped release would steal the successor's own claims). A
   * NULL/empty generation never matches (UNKNOWN != retired). Clears the claim stamp + claimed_at and
   * appends an audit transition per item. Returns the count released. Pre-063 dbs no-op.
   */
  releaseClaimsByGeneration(retiringGeneration: string): number {
    if (!this.hasClaimedGenColumn || !retiringGeneration) return 0;
    const rows = this.db
      .prepare(`SELECT qitem_id FROM queue_items WHERE state = 'in-progress' AND claimed_by_generation_uuid = ?`)
      .all(retiringGeneration) as Array<{ qitem_id: string }>;
    if (rows.length === 0) return 0;
    const ts = new Date().toISOString();
    const txn = this.db.transaction(() => {
      for (const { qitem_id } of rows) {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'pending', ts_updated = ?, claimed_at = NULL, closure_required_at = NULL,
                   claimed_by_generation_uuid = NULL
             WHERE qitem_id = ?`
          )
          .run(ts, qitem_id);
        this.transitionLog.append({
          qitemId: qitem_id,
          state: "pending",
          actorSession: "system",
          transitionNote: "released: claimant generation retired (seat handover)",
        });
      }
    });
    txn();
    return rows.length;
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
