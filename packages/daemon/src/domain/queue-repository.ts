import { readWakeLadderBackstop } from "./queue-wake-ladder.js";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import { loadHumanRegistry, resolveRegisteredHumanAddress, type LoadResult } from "./gateway/human-registry.js";
import { resolveExternal } from "./gateway/external-admission.js";
import type { PersistedEvent } from "./types.js";
import { QueueTransitionLog, type OwnerNotificationLevel, type QueueTransition, type RecentQueueTransitionScope } from "./queue-transition-log.js";
import { WAKE_INTENT_PREFIX, type OutboxHandler } from "./outbox-handler.js";
import { derivePickup, type PickupReceipt } from "./queue-pickup.js";
import { lastMeaningfulTransition, readWaitingView, type WaitingView, type WaitingActivityReader } from "./queue-waiting.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";
import { getSelfHostId } from "./hosts/fanout-contract.js";
import { parseSessionName, isHumanSeatSessionRef } from "./session-name.js";
import { parseReplyToChoice, formatReplyToChoice, describeReplyToFallback, REPLY_TO_CHOICE_ACTOR, type ReplyToChoice } from "./reply-to-choice.js";
import { classifyDestination } from "./gateway/destination-resolver.js";
import {
  computeClosureRequiredAt,
  validateClosure,
  type ClosureReason,
} from "./hot-potato-enforcer.js";
import { isHumanSeatSession, validateHumanPark, validateHumanRoute } from "./human-route-enforcer.js";
import {
  QueueWakeRepository,
  USAGE_LIMIT_BLOCKER_TAG,
  type ParkWakeStatus,
} from "./queue-wake-repository.js";
import { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import { armQueueWait, backOffQueueWait, refreshQueueWaits, evaluateQueueWait, retargetQueueWait, isQueueWait } from "./queue-wait-backoff.js";
import { parseHumanQuestions, unansweredQuestions, type HumanQuestion, type HumanAnswers, type RecordHumanAnswerResult } from "./human-questions.js";

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

/** 0.5.1-53 — the ACTIVE (still-progressing) states. A blocker is "live" iff active; any other
 *  state (done/handed-off/canceled/denied/failed) means the block will never lift. This is DISTINCT
 *  from the archiver's TERMINAL_QUEUE_STATES (done/handed-off) — a narrower concept — so it is named
 *  separately and derived from QUEUE_STATES (the `satisfies` guard fails if a state is removed). */
export const ACTIVE_QUEUE_STATES = ["pending", "in-progress", "blocked"] as const satisfies readonly QueueState[];
export function isBlockerLive(state: string): boolean {
  return (ACTIVE_QUEUE_STATES as readonly string[]).includes(state);
}

/** #96 — a Slack reply routes to the item that owns the thread root, so a later update may
 *  share that thread only while no reply there could answer a human decision. Deliberately
 *  BROADER than what makeHumanReplyResolver resolves today (it errs toward posting top-level): any
 *  active human-destined decision, or a row blocked on any human-class seat right now. A
 *  resolved park returns to in-progress; blocked_on alone (which the resolve verb documents
 *  keeping as provenance) is never a live gate. */
export function hasLiveHumanGate(item: {
  humanIntent?: string | null;
  state: string;
  destinationSession: string;
  blockedOn: string | null;
}): boolean {
  if (item.humanIntent === "update") return false;
  if (item.state === "blocked" && item.blockedOn && isHumanSeatSessionRef(item.blockedOn)) return true;
  return isBlockerLive(item.state) && isHumanSeatSessionRef(item.destinationSession);
}

const AUTO_UNPARK_WAKE_TAG = "queue:auto-unpark:blocker";
const AUTO_UNPARK_BLOCKER_TAG_PREFIX = "queue:auto-unpark:blocker-ref:";

/** 0.5.1-53 Atom 1a — typed non-qitem gate blocker prefixes. A park may be gated on a fold / auth /
 *  external condition that is NOT a qitem and NOT a human seat; these prefixes make such a gate a
 *  first-class, compact-visible, downstream-classifiable blocker (the ruling detail rides a transition). */
export const TYPED_GATE_BLOCKER_PREFIXES = ["fold:", "auth:", "external:"] as const;
export function typedGateBlockerPrefix(value: string): string | null {
  return TYPED_GATE_BLOCKER_PREFIXES.find((p) => value.startsWith(p)) ?? null;
}
/** A well-formed typed gate blocker: a recognized prefix AND a non-empty gate body. */
export function isTypedGateBlocker(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const p = typedGateBlockerPrefix(value);
  return p != null && value.slice(p.length).trim().length > 0;
}

/**
 * 0.5.1-54 DR-1 (classifier fold, PM ruling qitem-20260811163927-74493d76) — classify a create-path
 * nudge FAILURE so the surfaced count becomes ACTIONABLE (constraint iii). Two classes:
 *   - "permanent-topology": the destination is not resolvable on THIS daemon (the nudge can never
 *     succeed here — a local-registry lookup reporting "not found" for a seat that lives on another
 *     daemon). Retrying is a guaranteed-permanent failure repeated on a schedule → NOT retryable;
 *     these belong to the ADDRESSING family, not to retry machinery. (The live corpus: 9/10 strands.)
 *   - "transient": a live, resolvable seat that refused THIS attempt (busy at an interactive prompt) or
 *     the attempt timed out — the only class a future bounded re-attempt (DR-2, held n=1) would touch.
 *   - "unknown": a failure whose text matches NEITHER known pattern. NOT silently defaulted to transient
 *     (ship-block ruling qitem-20260811170941-5eadb968): defaulting would assert "a live seat refused
 *     this attempt" for a string that only means "did not match the permanent pattern" — two different
 *     claims. An unknown must read as unknown (the same rule the ACTIVITY hookless=unknown ruling names);
 *     a default that collapses unknown into a known class is the exact sin, mirrored.
 * Returns null when `lastNudgeResult` is not a recorded failure (`failed:%`).
 *
 * Each class is a POSITIVE match — there is no default class. DR-2 (retry) stays HELD at n=1; this is
 * READ-side labeling only, making the strand's nature legible (addressing-fix vs retry vs triage-the-unknown).
 */
export function classifyNudgeFailure(lastNudgeResult: string | null | undefined): "permanent-topology" | "transient" | "unknown" | null {
  if (typeof lastNudgeResult !== "string" || !lastNudgeResult.startsWith("failed:")) return null;
  // permanent-topology: local-registry "not found" — the destination is not resolvable on THIS daemon.
  if (/\bnot found\b/i.test(lastNudgeResult)) return "permanent-topology";
  // transient: a live seat refused this attempt (busy at a prompt) or the attempt timed out.
  if (/interactive prompt|\btimed?\s?out\b/i.test(lastNudgeResult)) return "transient";
  // unknown: matched neither — do NOT collapse into transient. Honest label > convenient default.
  return "unknown";
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
  /** OPR.0.5.6.14 — the delivery LEDGER verdict for gateway-routed rows
   *  (posted / transport-failed / never-posted), derived from the row's own
   *  transitions. Pane-bound rows carry null — the field never lies about a
   *  class it does not govern. Populated on getById and findUndelivered. */
  deliveryOutcome?: "posted" | "transport-failed" | "never-posted" | null;
  /** The undelivered surface's class for ledger-derived entries (the route
   *  prefers this over the nudge-literal regex when present). */
  deliveryFailureClass?: string;
  /** Exact gateway receipt/error evidence for an undelivered ledger verdict. */
  deliveryFailureDetail?: string;
  tags: string[] | null;
  blockedOn: string | null;
  /** S04 — the DERIVED pickup receipt (unclaimed/working/stalled-after-claim/parked/terminal).
   *  Never stored: computed at projection time from state + claimed_at + the transition log
   *  + heartbeat; a closed row is terminal, never stalled. */
  pickup?: PickupReceipt;
  waiting?: WaitingView;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  expiresAt: string | null;
  chainOfRecord: string[] | null;
  body: string;
  /** Explicit human delivery intent; null/omitted preserves legacy decisions. */
  humanIntent?: "decision" | "update" | null;
  /** One authored supplemental thread reply; the body remains a complete brief. */
  humanDetail?: string | null;
  /** #96 — the earlier qitem whose Slack thread this update posts into; null = own root. */
  replyTo?: string | null;
  /** #96 — set on full reads of a replyTo row: why delivery posted top-level instead
   *  (e.g. `root-missing`), or null when it threaded / has not been delivered. */
  replyToFallback?: string | null;
  /** #193 — structured questions on a decision (clickable options in Slack). */
  humanQuestions?: HumanQuestion[] | null;
  /** #193 — answers recorded from clicks, questionId → optionId; null until the first click. */
  humanAnswers?: HumanAnswers | null;
  /** Short human-readable subject; null for callers that omit it. */
  summary: string | null;
  /** OPR.0.4.4.19 FR-5 — pointer to the durable artifact a human judges
   *  (convention C3). NULL for all non-human-routed items (BR-1); required
   *  at the domain write path only when the §5 predicate is true. */
  evidenceRef: string | null;
  /** Present only on compact list rows so omitted content cannot be mistaken
   *  for an author-supplied empty value. Full reads never carry this marker. */
  fieldsElided?: Array<"body" | "summary" | "evidenceRef" | "humanDetail" | "waiting">;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
  /** Reporting only: local absence never proves a foreign successor is missing.
   * A matching local row suppresses it; this is not a continuing-custody check. */
  handoffAdvisory?: {
    status: "unverified";
    target: string;
    reason: "no-live-local-successor";
    message: string;
  };
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
  human_intent?: "decision" | "update" | null;
  human_detail?: string | null;
  reply_to?: string | null;
  human_questions?: string | null;
  human_answers?: string | null;
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
  deliveryTarget?(session: string): import("./seat-delivery-guard.js").GuardTarget | null;
  retentionTarget?(session: string): import("./seat-delivery-guard.js").GuardTarget | null;
  send(
    sessionName: string,
    // (h): stampISO threads the nudge's compose time so the transport's delivered-latency calc can
    // measure the wait for a handoff nudge too (the real impl is SessionTransport, which accepts it).
    text: string,
    opts?: { verify?: boolean; stampISO?: string; actorSession?: string; committedOutboxIds?: string[]; deliveryId?: string; auditPointer?: string }
  ): Promise<{ ok: boolean; verified?: boolean; error?: string; reason?: string; outcome?: string }>;
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
  /** 0.5.1-53 Atom 2b — supersession back-link. When this qitem is the SUCCESSOR of a
   *  cancel-and-replace (the original recorded state=canceled + closure_reason=superseded +
   *  closure_target=<this>), handedOffFrom records the original so the successor is traversable
   *  back to what it replaced — the same lineage primitive handoff-and-complete already sets,
   *  now reachable from the raw create path so a supersession is not an unlinked orphan pair. */
  handedOffFrom?: string | null;
  /** PL-007 — typed repo scope for this qitem. Route validates against
   *  source rig's workspace.repos[]; unknown names rejected upstream. */
  targetRepo?: string | null;
  /** Explicit human delivery intent; omission preserves legacy decisions. */
  humanIntent?: "decision" | "update" | null;
  /** Explicit supplemental thread content, never an automatic split of the primary body. */
  humanDetail?: string | null;
  /** #96 — post this update into the named earlier qitem's Slack thread. Updates only; if
   *  that thread can't be used (e.g. a live human gate, see hasLiveHumanGate), it posts
   *  top-level and the row records why. */
  replyTo?: string | null;
  /** #193 — 1–4 structured questions; accepted only with humanIntent "decision". */
  humanQuestions?: HumanQuestion[] | null;
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
  state?: QueueState;
  /** Explicit acknowledgment for a deliberate terminal → active repair. */
  reopen?: boolean;
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
  /** OPR.0.5.5.03 — park continuation. Exactly one explicit wake form may
   *  accompany a blocked transition; a live qitem blocker is inferred. */
  wakeWatchdogId?: string;
  wakeAfterSeconds?: number;
  /** Internal opt-in to repeating, event-first park reminders. Evidence is
   * compared structurally; an acknowledgment note is never progress. */
  wakeMaxSeconds?: number;
  wakeProgressEvidence?: Record<string, unknown>;
  /** Internal caller-supplied text for an atomic timer. Public queue routes do
   *  not expose this; workflow projection uses it to re-present the exact
   *  occurrence-bound continuation action instead of a generic reminder. */
  wakeMessage?: string;
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
  /** System-owned ceremony kind. Never exposed as a free-form route field. */
  ownerNotificationKind?: "human-decision-resolved";
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
  /** Exact tag selection before the result bound (used by diagnostic occurrences). */
  tag?: string;
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

function detectTable(db: Database.Database, tableName: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
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
 * Stamp-at-FORWARD only (founder root invariant 2026-08-27, superseding 51-09 incr 4
 * stamp-at-write): a LOCAL write never calls this — local rows store the bare
 * member@rig. The cross-host forwarding routes (routes/queue.ts) call it so the
 * forwarding daemon stamps ITS OWN id as the origin before the remote create; the
 * remote's not-bare guard then stores the received triple verbatim (origin never
 * forged). FAIL-OPEN: no reconciled self-id, or a value that is not a bare
 * member@rig (already a triple / malformed), passes through unchanged.
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
export function externalAdmissionTeaching(
  session: string,
  loadRegistry: () => LoadResult = loadHumanRegistry,
): Record<string, unknown> | undefined {
  const parsed = parseSessionName(session);
  if (parsed.kind !== "external") return undefined;
  if (resolveExternal(parsed.local, []).kind === "scheme") return undefined;
  const reg = loadRegistry();
  if (!reg.ok) {
    return {
      externalDomain: parsed.domain,
      registryLoadError: true,
      registryError: reg.error,
      ...(/projection/i.test(reg.error) ? { registryProjectionError: true } : {}),
      hint:
        `human registry admission is unavailable because the registry/projection failed to load: ${reg.error}. ` +
        "Repair the existing registry projection from its fragments; do not re-add the human or downgrade the destination to an agent seat.",
    };
  }
  const entities = reg.entities.map((e) => ({ entityId: e.entityId, address: e.address }));
  const res = resolveExternal(parsed.local, entities);
  if (res.kind !== "unregistered") return undefined; // registered/scheme were admitted upstream
  return { externalDomain: parsed.domain, unregisteredEntity: parsed.local, hint: res.error };
}

/** The refusal teaching for ANY rejected destination: the @external entity teaching
 *  (A4b) OR the host-suffix teaching (4b). One helper, all four refusal sites. */
export function destinationRefusalTeaching(
  session: string,
  loadRegistry: () => LoadResult = loadHumanRegistry,
): Record<string, unknown> | undefined {
  return externalAdmissionTeaching(session, loadRegistry) ?? destinationRigTeaching(session);
}

function destinationValidationError(
  field: "destination_session" | "to_session",
  session: string,
  loadRegistry: () => LoadResult,
): QueueRepositoryError {
  const teaching = destinationRefusalTeaching(session, loadRegistry);
  if (teaching?.registryLoadError === true) {
    return new QueueRepositoryError(
      "human_registry_unavailable",
      `${field} ${session} cannot be admitted because the human registry failed to load: ${String(teaching.registryError)}`,
      teaching,
    );
  }
  return new QueueRepositoryError(
    "unknown_destination_rig",
    `${field} ${session} references an unknown rig`,
    teaching,
  );
}

/**
 * MF6: does a transport error/reason string denote a TIMEOUT (ambiguous — the
 * send may have landed) rather than a definite failure? Used to classify a wake
 * delivery as `indeterminate` vs `failed`.
 */
function isWakeTimeoutSignal(s: string | undefined): boolean {
  return !!s && /timeout|timed\s*out|etimedout/i.test(s);
}

export interface QueueDestinationAdvisory {
  code: "unmatched_destination_seat";
  destinationSession: string;
  availableDestinations: string[];
  message: string;
}

export class QueueRepository {
  readonly db: Database.Database;
  readonly transitionLog: QueueTransitionLog;
  private readonly eventBus: EventBus;
  readonly destinationAdvisory: (sessionRef: string) => QueueDestinationAdvisory | null;
  private readonly validateRig: (sessionRef: string) => boolean;
  private transport: QueueNudgeTransport | undefined;
  /** W1 (transactional closure): the durable wake-intent store. A terminal act
   *  (handoff / handoff-and-complete) stages an outbox intent row INSIDE its
   *  db.transaction so close + transition + intent commit as one act or none;
   *  the delivery drains from that committed intent afterward. Wired post-
   *  construction by startup (dep-graph ordering, like transport).
   *
   *  ABSENT = the test/bootstrap path, and what that means differs by caller —
   *  it is NOT a blanket best-effort fallback:
   *   • a nudge-intended TERMINAL close+successor act FAILS CLOSED (MF2):
   *     {@link assertTerminalClosureHasIntent} throws `wake_intent_store_unavailable`
   *     rather than produce an executed-but-unwoken item (pass `nudge:false` for a
   *     wake-less close);
   *   • {@link deliverWakeForSuccessor} — and only it — falls back to the pre-W1
   *     best-effort {@link maybeNudge} when no store is attached (P34 made that
   *     fallback real code rather than a promise in a comment). */
  private outbox: OutboxHandler | undefined;
  private resolveOccupantGeneration?: (sessionName: string) => string | null;
  private readonly wakeRepo: QueueWakeRepository;
  private watchdogJobsRepo: WatchdogJobsRepository | undefined;
  /** PL-007 Workspace Primitive — true when migration 038 has applied the
   *  queue_items.target_repo column. Older test fixtures that bypass the
   *  canonical migration list don't have the column; INSERTs degrade to
   *  the pre-PL-007 statement and target_repo input is silently dropped.
   *  Production daemons always have the column (migration is in startup.ts). */
  private readonly hasTargetRepoColumn: boolean;
  private readonly hasSummaryColumn: boolean;
  private readonly hasHumanIntentColumn: boolean;
  private readonly hasReplyToColumn: boolean;
  private readonly hasHumanQuestionsColumn: boolean;
  private readonly hasEvidenceRefColumn: boolean;
  private readonly hasMintingGenColumn: boolean;
  private readonly hasClaimedGenColumn: boolean;
  private readonly hasQueueTransitionsTable: boolean;
  private readonly hasTransitionProvenanceColumn: boolean;
  private readonly hasOwnerNotificationColumns: boolean;
  private readonly loadHumanRegistryFn: () => LoadResult;
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
      destinationAdvisory?: (sessionRef: string) => QueueDestinationAdvisory | null;
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
      loadHumanRegistry?: () => LoadResult;
    }
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.transitionLog = new QueueTransitionLog(db);
    this.wakeRepo = new QueueWakeRepository(db);
    this.validateRig = opts?.validateRig ?? (() => true);
    this.destinationAdvisory = opts?.destinationAdvisory ?? (() => null);
    this.transport = opts?.transport;
    this.workflowFrontierPredicate = opts?.workflowFrontierPredicate;
    this.resolveOccupantGeneration = opts?.resolveOccupantGeneration;
    this.loadHumanRegistryFn = opts?.loadHumanRegistry ?? (() => loadHumanRegistry());
    this.hasTargetRepoColumn = detectQueueColumn(db, "target_repo");
    this.hasSummaryColumn = detectQueueColumn(db, "summary");
    this.hasHumanIntentColumn = detectQueueColumn(db, "human_intent");
    this.hasReplyToColumn = detectQueueColumn(db, "reply_to");
    this.hasHumanQuestionsColumn = detectQueueColumn(db, "human_questions");
    this.hasEvidenceRefColumn = detectQueueColumn(db, "evidence_ref");
    this.hasQueueTransitionsTable = detectTable(db, "queue_transitions");
    const transitionColumns = this.hasQueueTransitionsTable
      ? new Set((db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((column) => column.name))
      : new Set<string>();
    this.hasTransitionProvenanceColumn = transitionColumns.has("identity_provenance");
    this.hasOwnerNotificationColumns = transitionColumns.has("owner_notification_kind")
      && transitionColumns.has("owner_notification_level");
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
    // session-name's canonical predicate (legacy and external) so SQL-side and TS-side
    // checks cannot drift.
    db.function("is_human_seat_session", { deterministic: true }, (value: unknown) =>
      typeof value === "string" && isHumanSeatSessionRef(value) ? 1 : 0
    );
  }

  /** Startup attaches the generation-aware shared repository. Isolated domain
   *  fixtures fall back to a repository on this same SQLite connection. */
  attachWatchdogJobsRepository(repo: WatchdogJobsRepository): void {
    this.watchdogJobsRepo = repo;
  }

  /** Startup wires this after queue/watchdog composition. Tests may also call
   * it after reconstruction; it only reconciles queue-owned repeating timers. */
  reconcileWaitReminders(changedQitem?: string, proofChanged = false): void {
    refreshQueueWaits(this.db, this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db), changedQitem, proofChanged);
  }

  startWaitReminders(): () => void {
    this.reconcileWaitReminders();
    return this.eventBus.subscribe((event) => {
      if (event.type.startsWith("queue.") && "qitemId" in event && typeof event.qitemId === "string") {
        this.reconcileWaitReminders(event.qitemId);
      } else if (event.type === "proof.judged" || event.type === "proof.sources_changed") {
        this.reconcileWaitReminders(undefined, true);
      }
    });
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

  /** The one transition-write classifier. It consumes structured state/action facts only. */
  private classifyOwnerNotification(input: {
    action: "create" | "update";
    destinationSession: string;
    previousState?: QueueState;
    previousBlockedOn?: string | null;
    nextState: QueueState;
    nextBlockedOn?: string | null;
    explicitKind?: QueueUpdateInput["ownerNotificationKind"];
    humanIntent?: "decision" | "update" | null;
  }): { kind: string; level: OwnerNotificationLevel } | null {
    if (input.explicitKind === "human-decision-resolved") {
      return { kind: input.explicitKind, level: "NOTICE" };
    }
    const registry = this.loadHumanRegistryFn();
    if (!registry.ok) return null;
    const blockedHuman = resolveRegisteredHumanAddress(input.nextBlockedOn, registry.entities);
    const previousBlockedHuman = resolveRegisteredHumanAddress(input.previousBlockedOn, registry.entities);
    const enteredHumanPark = input.nextState === "blocked" && blockedHuman !== null &&
      (input.previousState !== "blocked" || previousBlockedHuman !== blockedHuman);
    if (enteredHumanPark) return { kind: "human-required", level: "ALERT" };

    const destinationHuman = resolveRegisteredHumanAddress(input.destinationSession, registry.entities);
    if (input.action === "create" && destinationHuman !== null) {
      return input.humanIntent === "update"
        ? { kind: "human-update", level: "NOTICE" }
        : { kind: "human-required", level: "ALERT" };
    }
    return null;
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
    this.recordWakeIntent({
      outboxId: `${WAKE_INTENT_PREFIX}${successorQitemId}`,
      auditPointer: successorQitemId,
      fromSession,
      toSession,
      identityProvenance,
      bareBody: `Queue handoff: ${successorQitemId} - check your queue.`,
      tags: this.getById(successorQitemId)?.handedOffFrom
        ? [`queue:return:${this.getByIdOrThrow(successorQitemId).handedOffFrom}`] : undefined,
    });
  }

  private recordWakeIntent(input: {
    outboxId: string;
    auditPointer: string;
    fromSession: string;
    toSession: string;
    identityProvenance: string | null;
    bareBody: string;
    tags?: string[];
  }): string | null {
    if (!this.outbox) return null;
    // MF4: freeze the emitting envelope at stage time. Delivery and crash
    // recovery replay these exact bytes without re-resolving the occupant.
    const stampISO = new Date().toISOString();
    const genUuid = this.resolveOccupantGeneration?.(input.fromSession) ?? undefined;
    const frozenEnvelope = wrapPaneEnvelope(
      input.fromSession,
      input.toSession,
      input.bareBody,
      { stampISO, genUuid },
    );
    const record = {
      outboxId: input.outboxId, senderSession: input.fromSession, destinationSession: input.toSession,
      body: frozenEnvelope, tags: input.tags, auditPointer: input.auditPointer, identityProvenance: input.identityProvenance,
    };
    const target = this.transport?.retentionTarget?.(input.toSession);
    if (target) this.outbox.retain(record, target);
    else {
      this.outbox.record(record);
      const binding = this.transport?.deliveryTarget?.(input.toSession);
      if (binding) this.db.prepare("UPDATE outbox_entries SET guard_binding=? WHERE outbox_id=? AND guard_binding IS NULL")
        .run(JSON.stringify(binding), input.outboxId);
    }
    return input.outboxId;
  }

  private stageAutoUnparkWakeIntent(input: {
    qitemId: string;
    destinationSession: string;
    fromSession: string;
    identityProvenance: string | null;
    blockerQitemId: string;
    resumeTransitionId: number;
  }): string | null {
    return this.recordWakeIntent({
      outboxId: `${WAKE_INTENT_PREFIX}blocker-${input.resumeTransitionId}`,
      auditPointer: input.qitemId,
      fromSession: input.fromSession,
      toSession: input.destinationSession,
      identityProvenance: input.identityProvenance,
      bareBody: `Blocker ${input.blockerQitemId} resolved; parked qitem ${input.qitemId} is pending. Resume the recorded continuation and update the row.`,
      tags: [AUTO_UNPARK_WAKE_TAG, `${AUTO_UNPARK_BLOCKER_TAG_PREFIX}${input.blockerQitemId}`, `queue:return:${input.blockerQitemId}`],
    });
  }

  private deliverWakeIntentAfterCommit(outboxId: string): void {
    queueMicrotask(() => {
      void this.deliverWakeIntent(outboxId).catch((err) => {
        console.error(`Auto-unpark wake delivery failed for ${outboxId}:`, err);
      });
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
  ): Promise<"delivered" | "indeterminate" | "failed" | "skipped" | "retained"> {
    if (!this.outbox) return "skipped";
    if (!this.transport) return "skipped"; // no transport → stays pending for a later drain
    const alreadyHeld = this.outbox.getById(outboxId);
    if (alreadyHeld?.deliveryState === "retained" || alreadyHeld?.deliveryState === "retired") {
      if (alreadyHeld.auditPointer) this.recordNudgeAttempt(alreadyHeld.auditPointer, "retained:typing_guard");
      return "retained";
    }
    // MF3: CLAIM (pending→sending) BEFORE the external send so overlapping drains
    // cannot both send. A losing claim — the row is no longer `pending` (already
    // resolved, in-flight under another drainer, or claimed) — simply skips: no
    // send, no tally. This makes the external effect once, not merely the state.
    // Claim the exact return's arrival + dependent resumes atomically. Each
    // original frozen intent and audit pointer survives; only transport coalesces.
    let superseded = false;
    const actionable = (entry: import("./outbox-handler.js").OutboxEntry): boolean => {
      const row = entry.auditPointer ? this.db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(entry.auditPointer) as { state: string } | undefined : undefined;
      let current = row?.state === "pending";
      const resumePrefix = `${WAKE_INTENT_PREFIX}blocker-`;
      if (current && entry.outboxId.startsWith(resumePrefix)) {
        const expected = Number(entry.outboxId.slice(resumePrefix.length));
        const latest = this.db.prepare(`SELECT transition_id FROM (
          SELECT transition_id, state, LAG(state) OVER (ORDER BY transition_id) AS previous_state
          FROM queue_transitions WHERE qitem_id = ?)
          WHERE state = 'pending' AND previous_state IS NOT 'pending' ORDER BY transition_id DESC LIMIT 1`)
          .get(entry.auditPointer) as { transition_id: number } | undefined;
        current = expected === latest?.transition_id;
      }
      if (!current) {
        // Existing failed state means the requested old delivery was refused;
        // the explicit tag distinguishes supersession from a transport attempt.
        // Do not stamp last_nudge_result or delivered_at: neither happened.
        const changed = this.db.prepare("UPDATE outbox_entries SET delivery_state = 'failed', tags = ? WHERE outbox_id = ? AND delivery_state = 'pending'")
          .run(JSON.stringify([...(entry.tags ?? []), "queue:wake-superseded"]), entry.outboxId);
        superseded ||= changed.changes > 0;
      }
      return current;
    };
    const group = this.db.transaction(() => {
      const candidate = this.outbox!.getById(outboxId);
      if (!candidate || candidate.deliveryState !== "pending" || !actionable(candidate)) return [];
      if (!this.outbox!.claimForDelivery(outboxId)) return [];
      const first = this.outbox!.getById(outboxId)!;
      const intents = [first];
      const correlation = first.tags?.find(tag => tag.startsWith("queue:return:"));
      if (correlation) {
        const peers = this.db.prepare(`SELECT outbox_id FROM outbox_entries
          WHERE delivery_state = 'pending' AND destination_session = ? AND substr(outbox_id, 1, ?) = ?
          AND EXISTS (SELECT 1 FROM json_each(outbox_entries.tags) WHERE value = ?)
          ORDER BY outbox_id`).all(first.destinationSession, WAKE_INTENT_PREFIX.length, WAKE_INTENT_PREFIX, correlation) as Array<{ outbox_id: string }>;
        for (const peer of peers) if (actionable(this.outbox!.getById(peer.outbox_id)!) && this.outbox!.claimForDelivery(peer.outbox_id)) intents.push(this.outbox!.getById(peer.outbox_id)!);
      }
      return intents;
    })();
    const intent = group[0];
    if (!intent) return superseded ? "failed" : "skipped";
    // Only deliver a wake for a qitem that actually exists. A wake intent whose
    // target qitem is missing — a caller-recorded id under this prefix (the route
    // no longer refuses those), or a successor already swept — is finalized
    // `failed`, never sent as a real wake.
    if (!intent.auditPointer || !this.getById(intent.auditPointer)) {
      this.outbox.finalizeDelivery(outboxId, "failed");
      return "failed";
    }
    const qitemId = intent.auditPointer ?? outboxId;
    // MF4: send the FROZEN envelope stored on the intent verbatim (no re-resolution).
    const outcome = await this.performWakeSend(
      qitemId, intent.destinationSession, intent.senderSession, undefined, group.map(entry => entry.body).join("\n"), group.map(entry => entry.outboxId),
    );
    const finalState = outcome.classified === "verified" ? "delivered" : outcome.classified;
    for (const member of group) {
      const intent = member;
      const qitemId = intent.auditPointer!;
      const blockerRef = intent.tags?.includes(AUTO_UNPARK_WAKE_TAG)
        ? intent.tags
            .find((tag) => tag.startsWith(AUTO_UNPARK_BLOCKER_TAG_PREFIX))
            ?.slice(AUTO_UNPARK_BLOCKER_TAG_PREFIX.length)
        : undefined;
      const wakeEvent = this.db.transaction(() => {
        this.recordNudgeAttempt(qitemId, outcome.nudgeResult);
        this.outbox!.finalizeDelivery(intent.outboxId, finalState);
        if (!blockerRef) return null;

        const item = this.getByIdOrThrow(qitemId);
        const transition = this.transitionLog.append({
          qitemId,
          state: item.state,
          actorSession: "queue@system",
          transitionNote: `blocker ${blockerRef} wake attempted; delivery=${outcome.nudgeResult}`,
        });
        this.wakeRepo.record({
          transitionId: transition.transitionId,
          qitemId,
          phase: "fired",
          kind: "blocker",
          ref: blockerRef,
          deliveryStatus: outcome.nudgeResult,
        });
        return this.eventBus.persistWithinTransaction({
          type: "queue.updated",
          qitemId,
          fromState: item.state,
          toState: item.state,
          closureReason: null,
          closureTarget: null,
          actorSession: "queue@system",
          summary: item.summary ?? null,
        });
      })();
      if (wakeEvent) this.eventBus.notifySubscribers(wakeEvent);
    }
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

  async drainPendingWakeIntents(): Promise<{ delivered: number; indeterminate: number; failed: number; retained: number }> {
    const tally = { delivered: 0, indeterminate: 0, failed: 0, retained: 0 };
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
        else if (outcome === "retained") { tally.retained++; progressed++; }
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
    committedOutboxIds?: string[],
  ): Promise<{ classified: "verified" | "indeterminate" | "failed" | "retained"; nudgeResult: string }> {
    // DEFECT FIX qitem-20260827065907-b9ae334c (S1-class, 3 live specimens): a virtual
    // @external destination has NO pane — the queue row ITSELF is the gateway
    // subsystem's input (the Slack connector polls human-destined rows and its own
    // ledger is the delivery record). Falling through to tmux here recorded
    // "failed: … tmux reports no session" while the founder verifiably received the
    // message, and that failed: literal poisoned the undelivered surface.
    // OPR.0.5.6.14 — the inline @external branch became THE ONE RESOLVER SEAM
    // (gateway/destination-resolver.ts): pane-bound keeps terminal transport;
    // gateway-routable (@external AND registry-resolved aliases like the
    // paneless human-*@kernel virtual identities — the live 4-row specimen
    // class) is GATEWAY-OWNED (tmux never consulted; the connector's row-poll
    // is the dispatch and its ledger the delivery record); neither is an
    // honest structured teaching refusal (tmux is not consulted for an
    // address it can never hold). Classified indeterminate for gateway
    // (landed with the owning subsystem; render unconfirmable here) — never
    // verified, never failed.
    const destClass = classifyDestination(destinationSession, {
      entities: (() => {
        const loaded = this.loadHumanRegistryFn();
        return loaded.ok ? loaded.entities : null;
      })(),
      hasTerminalTransport: (dest) => this.hasTerminalTransport(dest),
    });
    if (destClass.class === "gateway-routable") {
      const resolvedNote = destClass.via === "registry-alias" && destClass.resolvedHuman
        ? ` — the human registry resolves it to registered human '${destClass.resolvedHuman}'`
        : "";
      return {
        classified: "indeterminate",
        nudgeResult:
          `gateway-owned: '${destinationSession}' is a virtual ${destClass.via === "registry-alias" ? "paneless human" : "@external"} destination${resolvedNote} — delivery rides the gateway subsystem (Slack connector), whose own ledger is the delivery record; tmux was not consulted (it can never hold this address class)`,
      };
    }
    if (destClass.class === "unroutable") {
      return { classified: "failed", nudgeResult: destClass.teaching };
    }
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
      text = wrapPaneEnvelope(sourceSession, destinationSession, bareBody, { stampISO, genUuid });
    }
    const deliveryId = `guard-nudge-${qitemId}-${createHash("sha256").update(JSON.stringify([sourceSession, destinationSession, bodyOverride ?? null])).digest("hex")}`;
    const held = !committedOutboxIds ? this.outbox?.getById(deliveryId) : null;
    if (held?.deliveryState === "retained" || held?.deliveryState === "retired") {
      // Same logical nudge reuses its original frozen envelope, not a new timestamp.
      text = held.body;
    }
    try {
      const res = await this.transport!.send(destinationSession, text, { verify: true, stampISO, actorSession: sourceSession, committedOutboxIds, deliveryId: committedOutboxIds ? undefined : deliveryId, auditPointer: qitemId });
      // OPR.0.3.2.21.FR-4(c) — wording rename: the prior literal
      // "sent-unverified" read as a failure even in the common case
      // (delivery confirmed but the synchronous ack window expired,
      // which is normal for codex seats mid-task). The new literal
      // "delivered-ack-pending" reads as healthy. The old "verified"
      // case is unchanged for backward-compat with any tooling that
      // already consumed the positive literal.
      if (res.outcome === "retained") return { classified: "retained", nudgeResult: "retained:typing_guard" };
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

  async create(input: QueueCreateInput): Promise<QueueItem & {
    /** Response-only: the retry's changed body was not written. Never stored on the row. */
    createWarning?: { code: "qitem_body_not_saved"; message: string };
  }> {
    // FOUNDER ROOT INVARIANT (2026-08-27, supersedes 51-09 incr 4 / ruling cb19867f Q2):
    // a LOCAL write stores the bare transport identity — no self-host suffix inside one
    // instance. Host identity is added only at the cross-host forwarding boundary
    // (routes/queue.ts stamp-at-FORWARD), and a genuine origin triple arriving from a
    // forward is stored verbatim (never re-stamped, never stripped).
    if (!this.validateRig(input.destinationSession)) {
      throw destinationValidationError("destination_session", input.destinationSession, this.loadHumanRegistryFn);
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
            // Keep retry compatibility, but never imply that an absorbed,
            // different body was saved. Decide at the actual PK conflict,
            // rather than comparing a fresh create's post-nudge readback.
            if (existing.body !== input.body) {
              return {
                ...existing,
                createWarning: {
                  code: "qitem_body_not_saved",
                  message: `qitem ${input.qitemId} already exists with a different body. The supplied body was not saved; the existing row is returned unchanged. No new work or delivery was created.`,
                },
              };
            }
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
      throw destinationValidationError("destination_session", input.destinationSession, this.loadHumanRegistryFn);
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
    if (input.humanIntent != null && input.humanIntent !== "decision" && input.humanIntent !== "update") {
      throw new QueueRepositoryError("invalid_human_notification", "humanIntent must be decision or update; omission retains legacy decision behavior.");
    }
    if (input.humanDetail != null && (typeof input.humanDetail !== "string" || !input.humanDetail.trim())) {
      throw new QueueRepositoryError("invalid_human_notification", "humanDetail must be nonempty supplemental text or omitted.");
    }
    if (input.humanIntent != null || input.humanDetail != null) {
      if (!isHumanSeatSessionRef(input.destinationSession)) {
        throw new QueueRepositoryError("invalid_human_notification", "humanIntent/humanDetail require a human destination; agent continuation belongs in its own qitem.");
      }
      if (!this.hasHumanIntentColumn) throw new QueueRepositoryError("invalid_human_notification", "Human notification fields require the current queue schema; they were not saved.");
    }
    if (input.replyTo != null) this.validateReplyTo(input.replyTo, input.humanIntent);
    let humanQuestions: HumanQuestion[] | null = null;
    if (input.humanQuestions != null) {
      if (!isHumanSeatSessionRef(input.destinationSession)) {
        throw new QueueRepositoryError("invalid_human_questions", "humanQuestions require a human destination: only a human can click the options.");
      }
      // Omitted intent is a decision (legacy behavior), so it may carry questions too.
      if (input.humanIntent === "update") {
        throw new QueueRepositoryError("invalid_human_questions", "humanQuestions are refused on an update: they ask the human to decide. Use humanIntent decision.");
      }
      const parsed = parseHumanQuestions(input.humanQuestions);
      if (!parsed.ok) throw new QueueRepositoryError("invalid_human_questions", parsed.error);
      if (!this.hasHumanQuestionsColumn) throw new QueueRepositoryError("invalid_human_questions", "humanQuestions require the current queue schema; they were not saved.");
      humanQuestions = parsed.questions;
    }
    const id = input.qitemId ?? newQitemId();
    const ts = new Date().toISOString();
    const priority = input.priority ?? "routine";
    const tier = input.tier ?? null;
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const chain = input.chainOfRecord ? JSON.stringify(input.chainOfRecord) : null;
    const expiresAt = input.expiresAt ?? null;
    const targetRepo = input.targetRepo ?? null;
    // 0.5.1-53 Atom 2b — supersession back-link (successor -> the row it replaced). Absent for a normal create.
    const handedOffFrom = input.handedOffFrom ?? null;

    if (this.hasTargetRepoColumn) {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, handed_off_from, body, target_repo
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, handedOffFrom, input.body, targetRepo);
    } else {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, handed_off_from, body
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, handedOffFrom, input.body);
    }
    this.persistSummary(id, input.summary ?? null);
    this.persistEvidenceRef(id, input.evidenceRef ?? null);
    if (this.hasHumanIntentColumn) {
      this.db.prepare("UPDATE queue_items SET human_intent = ?, human_detail = ? WHERE qitem_id = ?")
        .run(input.humanIntent ?? null, input.humanDetail ?? null, id);
    }
    if (input.replyTo != null) {
      this.db.prepare("UPDATE queue_items SET reply_to = ? WHERE qitem_id = ?").run(input.replyTo, id);
    }
    if (humanQuestions) {
      this.db.prepare("UPDATE queue_items SET human_questions = ? WHERE qitem_id = ?").run(JSON.stringify(humanQuestions), id);
    }
    this.persistMintingGeneration(id, input.sourceSession);
    const notification = this.classifyOwnerNotification({
      action: "create",
      humanIntent: input.humanIntent,
      destinationSession: input.destinationSession,
      nextState: "pending",
    });
    this.transitionLog.append({
      qitemId: id,
      state: "pending",
      actorSession: input.sourceSession,
      transitionNote: "created",
      identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
      ownerNotificationKind: notification?.kind,
      ownerNotificationLevel: notification?.level,
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

  private validateReplyTo(replyTo: string, humanIntent: QueueCreateInput["humanIntent"]): void {
    if (humanIntent !== "update") {
      throw new QueueRepositoryError("reply_to_requires_update", "replyTo is accepted only with humanIntent update; a decision keeps its own thread so its reply stays unambiguous.");
    }
    if (!this.hasReplyToColumn) throw new QueueRepositoryError("invalid_human_notification", "replyTo requires the current queue schema; it was not saved.");
    if (!this.getById(replyTo)) throw new QueueRepositoryError("reply_to_not_found", `replyTo names no qitem on this host: ${replyTo}.`);
    // An item with a live human gate or no usable root is not refused here: delivery posts
    // the update top-level and records why (deriveReplyToChoice in slack-subsystem).
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
      throw destinationValidationError("to_session", input.toSession, this.loadHumanRegistryFn);
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

      // OPR.0.5.8.1 S1b — THE ROUTE THE FOUNDING SPECIMEN TOOK. Row b7a70333 went
      // handed-off at 10:02:03Z and its timer still fired at 10:18:07Z, because
      // handoff() is its own transaction and never passes through update().
      this.retireParkGeneratedTimer(source.qitemId, "park_ended:handed-off");

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

      const successorNotification = this.classifyOwnerNotification({
        action: "create",
        destinationSession: input.toSession,
        nextState: "pending",
      });
      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff from ${source.qitemId}`,
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
        ownerNotificationKind: successorNotification?.kind,
        ownerNotificationLevel: successorNotification?.level,
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

      // OPR.0.5.6.26 — a handed-off blocker actuates its attached rows through the one
      // propagation site, with the update path's exact effect set.
      for (const dependentEvent of this.propagateBlockerCompletion({
        qitemId: source.qitemId,
        terminalState: "handed-off",
        actorSession: input.fromSession,
        identityProvenance: input.identityProvenance ?? null,
        ts,
      })) {
        events.push({ name: "queue.updated", payload: dependentEvent });
      }

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
      throw destinationValidationError("to_session", input.toSession, this.loadHumanRegistryFn);
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

      // OPR.0.5.8.1 S1b — same structural bypass as handoff(): own transaction,
      // never routes through update().
      this.retireParkGeneratedTimer(source.qitemId, "park_ended:done");

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

      const successorNotification = this.classifyOwnerNotification({
        action: "create",
        destinationSession: input.toSession,
        nextState: "pending",
      });
      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff-and-complete from ${source.qitemId}`,
        ownerNotificationKind: successorNotification?.kind,
        ownerNotificationLevel: successorNotification?.level,
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

      // OPR.0.5.6.26 — a done-via-handoff-and-complete blocker actuates its attached rows through the one
      // propagation site, with the update path's exact effect set (the confirmed R-2 prediction).
      for (const dependentEvent of this.propagateBlockerCompletion({
        qitemId: source.qitemId,
        terminalState: "done",
        actorSession: input.fromSession,
        identityProvenance: input.identityProvenance ?? null,
        ts,
      })) {
        events.push({ name: "queue.updated", payload: dependentEvent });
      }

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
   *     `closure_reason=handed_off_to`; `closure_target` carries the
   *     host-qualified successor key `<qitem-id>@<host>` (custody metadata,
   *     never a local lookup key); `handed_off_to`
   *     stays the two-part `member@rig` (BR-1 — session-string carriers
   *     never gain `@host`).
   */
  closeCrossHostHandoffSource(input: {
    qitemId: string;
    fromSession: string;
    /** Two-part `member@rig` destination — the session-string carrier (BR-1). */
    toSession: string;
    /** Host-qualified successor `<qitem-id>@<host>` closure target. */
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
        // host-qualified successor key is allowed in closure_target and nowhere
        // else, and transition_note is a durable carrier.
        transitionNote: input.transitionNote ?? `cross-host handoff to ${input.toSession}`,
        closureReason: "handed_off_to",
        closureTarget: input.closureTarget,
      });

      // OPR.0.5.8.1 S1b — third member of the handoff family, same bypass.
      this.retireParkGeneratedTimer(input.qitemId, `park_ended:${input.terminalState}`);

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

      // OPR.0.5.6.26 (R2 B-1) — the cross-host terminal close is the third
      // handoff-family caller of the one propagation site: attached rows actuate
      // with the update path's exact effect set, at this close's actual terminal
      // state. Absorbed redrives return above this transaction and never re-run it.
      for (const dependentEvent of this.propagateBlockerCompletion({
        qitemId: input.qitemId,
        terminalState: input.terminalState,
        actorSession: input.fromSession,
        identityProvenance: null,
        ts,
      })) {
        events.push(dependentEvent);
      }
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
   * Every in-progress row destined for `session`, UNBOUNDED and single-state.
   *
   * `whoami`'s `recent` is a display projection: it is capped (default 25, max 200) and
   * mixes pending/in-progress/blocked. Anything that must reason about how many batons a
   * seat truly holds — in particular a refusal that fires on ambiguity — cannot read it,
   * because a second in-progress row sitting past the cap is invisible and the refusal
   * silently degrades into a confident answer. This is that authoritative input.
   */
  listInProgressForDestination(session: string): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM queue_items WHERE destination_session = ? AND state = 'in-progress'`
      )
      .all(session) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r));
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
                   claimed_by_generation_uuid = ?, blocked_on = NULL
             WHERE qitem_id = ?`
          )
          .run(ts, ts, closureRequiredAt, claimedByGeneration, input.qitemId);
      } else {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'in-progress', ts_updated = ?, claimed_at = ?, closure_required_at = ?, blocked_on = NULL
             WHERE qitem_id = ?`
          )
          .run(ts, ts, closureRequiredAt, input.qitemId);
      }

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: "in-progress",
        actorSession: input.destinationSession,
        transitionNote: "claimed",
        // Preserve the former gate as an audit pointer without marking a closure
        // or changing the note execution-view uses to exclude claim activity.
        closureTarget: qitem.state === "blocked" ? qitem.blockedOn ?? undefined : undefined,
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
      });

      // OPR.0.5.8.1 S1b — CLAIM-RESUME. A blocked row is claimable ("only
      // pending/blocked are claimable"), so claiming is a real exit from a park
      // and it writes state directly rather than through update(). This is the
      // very transition the story contract named, and my first repair pinned it
      // through `update()` — a different spelling of the same outcome, which is
      // why it looked covered.
      this.retireParkGeneratedTimer(input.qitemId, "park_ended:claimed");

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
    const result = txn();
    for (const event of result.persistedEvents) this.eventBus.notifySubscribers(event);
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
    persistedEvents: PersistedEvent[];
  } {
    const result = this.updateInTransactionalContext(input);
    return { qitemId: input.qitemId, ...result };
  }

  /** Internal read-only audit pointer for non-state receipts. Never search past a state write. */
  retainedClaimBlocker(qitemId: string): string | undefined {
    const latest = this.transitionLog.listForQitem(qitemId).at(-1);
    // Explicit state writes do not carry this non-closure audit pointer. Do not
    // search past one, even if an older claim still records a gate in history.
    return latest?.state === "in-progress" && latest.closureReason === null
      ? latest.closureTarget ?? undefined
      : undefined;
  }

  /**
   * Internal: closure validation + UPDATE + transition log + emit
   * queue.updated event. Caller is responsible for transaction wrapping
   * (the public update() wraps; the public updateWithinTransaction()
   * composes inside the caller's outer transaction).
   */
  private updateInTransactionalContext(input: QueueUpdateInput): {
    persistedEvent: PersistedEvent;
    persistedEvents: PersistedEvent[];
  } {
    const qitem = this.getById(input.qitemId);
    if (!qitem) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`
      );
    }
    const hasNote = typeof input.transitionNote === "string" && input.transitionNote.trim().length > 0;
    const isGuardedTerminal = (["done", "canceled", "handed-off"] as const).includes(
      qitem.state as "done" | "canceled" | "handed-off",
    );
    const isStatePreservingAppend = input.state === undefined || (isGuardedTerminal && input.state === qitem.state);

    if (isStatePreservingAppend) {
      if (input.state === undefined && !hasNote) {
        throw new QueueRepositoryError(
          "state_or_note_required",
          "queue update requires --state or a non-empty --note; nothing was written",
        );
      }
      const disallowed = input.reopen === true
        || input.closureReason != null
        || input.closureTarget != null
        || input.handedOffTo != null
        || input.blockedOn != null
        || input.wakeWatchdogId != null
        || input.wakeAfterSeconds != null
        || input.wakeMaxSeconds != null
        || input.wakeProgressEvidence != null
        || input.wakeMessage != null
        || input.summary != null
        || input.evidenceRef != null;
      if (disallowed) {
        throw new QueueRepositoryError(
          "note_append_fields_not_admitted",
          "a state-preserving note append accepts only --note (and an optional same --state); state-write fields were supplied, so nothing was written",
        );
      }

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: qitem.state,
        actorSession: input.actorSession,
        transitionNote: input.transitionNote,
        // A note-only append does not clear the claim's retained park gate.
        // Carry its audit pointer so a later state write can end this chain.
        closureTarget: qitem.state === "in-progress" ? this.retainedClaimBlocker(input.qitemId) : undefined,
        identityProvenance: input.identityProvenance ?? null,
      });
      const persistedEvent = this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId: input.qitemId,
        fromState: qitem.state,
        toState: qitem.state,
        closureReason: null,
        closureTarget: null,
        actorSession: input.actorSession,
        summary: qitem.summary ?? null,
      });
      return { persistedEvent, persistedEvents: [persistedEvent] };
    }
    if (!isQueueState(input.state)) {
      throw new QueueRepositoryError(
        "invalid_state",
        `state=${input.state} not valid; valid: ${QUEUE_STATES.join(", ")}`
      );
    }
    if ((input.wakeWatchdogId != null || input.wakeAfterSeconds != null) && input.state !== "blocked") {
      throw new QueueRepositoryError(
        "wake_not_admitted",
        "a park wake persists only with state=blocked; park the row or drop the wake option",
      );
    }
    if (input.wakeWatchdogId != null && input.wakeAfterSeconds != null) {
      throw new QueueRepositoryError(
        "wake_ambiguous",
        "choose one explicit park wake: an existing watchdog id or an atomic timer",
      );
    }
    if (input.wakeAfterSeconds != null && (!Number.isInteger(input.wakeAfterSeconds) || input.wakeAfterSeconds <= 0)) {
      throw new QueueRepositoryError(
        "wake_after_invalid",
        `wakeAfterSeconds must be a positive integer (got ${input.wakeAfterSeconds})`,
      );
    }
    if (input.wakeMessage != null && input.wakeAfterSeconds == null) {
      throw new QueueRepositoryError(
        "wake_message_not_admitted",
        "wakeMessage is internal timer content and requires wakeAfterSeconds",
      );
    }
    if (input.wakeMaxSeconds != null && (input.wakeAfterSeconds == null || !Number.isInteger(input.wakeMaxSeconds) || input.wakeMaxSeconds < input.wakeAfterSeconds)) {
      throw new QueueRepositoryError("wake_max_invalid", "wakeMaxSeconds requires an initial delay and must be an integer at least as large");
    }
    if (input.wakeMessage != null && input.wakeMessage.trim().length === 0) {
      throw new QueueRepositoryError(
        "wake_message_invalid",
        "wakeMessage must be non-empty when supplied",
      );
    }

    const isReopen = isGuardedTerminal && input.state !== qitem.state;
    if (isReopen && !input.reopen) {
      throw new QueueRepositoryError(
        "terminal_reopen_requires_ack",
        `qitem ${input.qitemId} is currently '${qitem.state}'; state='${input.state}' would reopen a terminal row. Re-run deliberately with --reopen --note <reason>.`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (isReopen && !isBlockerLive(input.state)) {
      throw new QueueRepositoryError(
        "terminal_reopen_target_invalid",
        `qitem ${input.qitemId} is currently '${qitem.state}'; --reopen requires an active target state (pending, in-progress, or blocked), not '${input.state}'.`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (isReopen && !hasNote) {
      throw new QueueRepositoryError(
        "reopen_note_required",
        `qitem ${input.qitemId} is currently '${qitem.state}'; deliberate reopen requires --note <reason> so the repair is auditable.`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (input.reopen && !isReopen) {
      throw new QueueRepositoryError(
        "reopen_not_applicable",
        `--reopen applies only when moving a terminal row to an active state; qitem ${input.qitemId} is currently '${qitem.state}'.`,
        { currentState: qitem.state, requestedState: input.state },
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
    // A claimed item has no current gate, but re-parking without --blocked-on
    // retains the previous park's gate, as it did before claim cleared the row.
    const previousClaimBlocker = input.state === "blocked" && qitem.state === "in-progress"
      && input.blockedOn == null && qitem.blockedOn == null
      ? this.retainedClaimBlocker(input.qitemId)
      : null;
    const effectiveBlockedOn = input.blockedOn ?? qitem.blockedOn ?? previousClaimBlocker ?? null;
    if (input.state === "blocked" && effectiveBlockedOn && this.getById(effectiveBlockedOn)?.humanIntent === "update") {
      throw new QueueRepositoryError("invalid_human_notification", "An informational update is not an approval dependency. Create a separate decision request if a human decision is needed.");
    }
    if (qitem.humanIntent === "update" && input.state === "blocked" && isHumanSeatSessionRef(effectiveBlockedOn ?? "")) {
      throw new QueueRepositoryError("invalid_human_notification", "An informational delivery cannot become a human approval park; author a separate decision request.");
    }
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
    // 0.5.1-53 Atom 2a — FOURTH admitted form: the supersession-cancel. A row corrected by
    // cancel-and-replace records state=canceled + closureReason=superseded + closureTarget=<successor>,
    // so superseded is distinguishable from abandoned (a plain cancel keeps closureReason=null).
    const isSupersedeCancel = input.state === "canceled" && input.closureReason === "superseded";
    if (input.state !== "done" && !isParkRecord && !isHandoffClose && !isSupersedeCancel && (input.closureReason != null || input.closureTarget != null)) {
      throw new QueueRepositoryError(
        "closure_fields_not_admitted",
        `closure_reason/closure_target persist only on state=done, the blocked park-record form, the handoff close, or the superseded cancel; the '${input.state}' transition cannot store them. Close the item (--state done --closure-reason …) or drop the flags.`,
        {},
      );
    }
    // A supersession must name WHAT replaced this row — fail LOUD before any write (never a silent
    // no-op leaving a stale row, the dead-signal class), symmetric with handed_off_to's target rule.
    if (isSupersedeCancel && !input.closureTarget) {
      throw new QueueRepositoryError(
        "missing_closure_target",
        `closure_reason=superseded requires closure_target (the successor qitem that replaced this row).`,
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

    // 0.5.1-53 Atom 1b(ii) + 1a — blocker validation at the park moment. Non-human blocker kinds:
    //   qitem-ref ("qitem-…")        → must EXIST and be LIVE (1b-ii); a ghost or dead blocker never lifts.
    //   typed gate (fold:/auth:/…)   → first-class (1a), but a bare prefix with no gate body is malformed
    //                                   (a typo must not masquerade as a gate).
    //   anything else (legacy gate-name) → left as-is; out of this slice.
    // Human-seat parks (isHumanPark) enforce their own FR-6 contract above.
    if (input.state === "blocked" && !isHumanPark && typeof effectiveBlockedOn === "string") {
      if (effectiveBlockedOn.startsWith("qitem-")) {
        const blocker = this.getById(effectiveBlockedOn);
        if (!blocker) {
          throw new QueueRepositoryError(
            "blocker_not_found",
            `blocked_on names a qitem that does not exist on this daemon: ${effectiveBlockedOn}. A qitem absent from this daemon cannot be a live blocker here. If it is stored on another host, use a typed gate such as external:<host>/<id> with --wake-watchdog or --wake-after.`,
            // F1 (error-honesty): the rejected value is named rejectedBlocker — an error payload
            // never carries the success-shaped blockedOn field (the field-filtered-misread class).
            { rejectedBlocker: effectiveBlockedOn },
          );
        }
        if (!isBlockerLive(blocker.state)) {
          throw new QueueRepositoryError(
            "blocker_not_live",
            `blocked_on names a resolved qitem: ${effectiveBlockedOn} is '${blocker.state}'. A park must name a LIVE blocker — parking on a completed/closed row is a dead-blocker park that never self-clears.`,
            { rejectedBlocker: effectiveBlockedOn, blockerState: blocker.state },
          );
        }
      } else {
        const typedPrefix = typedGateBlockerPrefix(effectiveBlockedOn);
        if (typedPrefix && !isTypedGateBlocker(effectiveBlockedOn)) {
          throw new QueueRepositoryError(
            "blocker_malformed",
            `blocked_on '${effectiveBlockedOn}' is a bare '${typedPrefix}' prefix with no gate body. A typed gate blocker must name its gate (e.g. fold:one-home+attestation).`,
            { rejectedBlocker: effectiveBlockedOn },
          );
        }
      }
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

    let parkWake: { kind: "watchdog" | "timer" | "blocker"; ref: string } | null = null;
    const jobsRepo = this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db);
    if (input.wakeWatchdogId != null) {
      const job = jobsRepo.getById(input.wakeWatchdogId);
      if (!job || job.state !== "active") {
        throw new QueueRepositoryError(
          "wake_watchdog_not_live",
          `watchdog ${input.wakeWatchdogId} is not an active job; attach a live watchdog or arm an atomic timer`,
          { wakeWatchdogId: input.wakeWatchdogId },
        );
      }
      if (job.targetSession !== qitem.destinationSession) {
        throw new QueueRepositoryError(
          "wake_watchdog_target_mismatch",
          `watchdog ${job.jobId} targets ${job.targetSession}, not parked owner ${qitem.destinationSession}`,
          { wakeWatchdogId: job.jobId, targetSession: job.targetSession, destinationSession: qitem.destinationSession },
        );
      }
      parkWake = { kind: "watchdog", ref: job.jobId };
    } else if (input.wakeAfterSeconds != null && input.wakeMaxSeconds != null) {
      if (effectiveBlockedOn === input.qitemId) {
        throw new QueueRepositoryError("wake_self_blocker", "a repeating wait must name an upstream blocker, not its own packet");
      }
      const oldWake = this.wakeRepo.getStatus(input.qitemId);
      const job = armQueueWait(this.db, jobsRepo, {
        // Reusing a shared job would rewrite the attachment's schedule and packet.
        previousJobId: oldWake?.kind === "timer" && this.wakeRepo.findLiveQitemsByAttachedWatchdog(oldWake.ref).length === 0
          ? oldWake.ref : undefined,
        qitemId: input.qitemId, blocker: effectiveBlockedOn,
        evidence: input.wakeProgressEvidence,
        initialSeconds: input.wakeAfterSeconds, maxSeconds: input.wakeMaxSeconds,
        message: input.wakeMessage ?? `Resume parked qitem ${input.qitemId} and inspect current evidence.`,
        owner: qitem.destinationSession, actor: input.actorSession,
      });
      parkWake = { kind: "timer", ref: job.jobId };
    } else if (input.wakeAfterSeconds != null) {
      const job = jobsRepo.register({
        policy: "periodic-reminder",
        specYaml: [
          "policy: periodic-reminder",
          "target:",
          `  session: ${JSON.stringify(qitem.destinationSession)}`,
          `message: ${JSON.stringify(input.wakeMessage ?? `Wake timer fired for parked qitem ${qitem.qitemId}. Resume the recorded continuation and update the row.`)}`,
          "",
        ].join("\n"),
        targetSession: qitem.destinationSession,
        intervalSeconds: input.wakeAfterSeconds,
        registeredBySession: input.actorSession,
      });
      // OPR.0.5.8.1 S1 — start the interval at registration for EVERY explicit
      // `--wake-after` timer, not only provider-limit ones.
      //
      // `isDue` treats a job with no `last_evaluation_at` as due immediately, so
      // an unseeded timer fires on the scheduler's very first pass regardless of
      // its interval: measured at 0.69s for a requested 20m and 0.77s for a
      // requested 2h. The duration was never lost — `interval_seconds` held 1200
      // and 7200 correctly — it simply was not the thing being measured against.
      //
      // S16 introduced this seeding for provider-limit parks only and recorded
      // the narrow scope as deliberate. Widening it is the whole repair: the
      // mechanism is unchanged and already proven by the provider-limit path, so
      // this adds no scheduler and no per-wake bookkeeping.
      jobsRepo.recordEvaluation(job.jobId, job.registeredAt, false);
      parkWake = { kind: "timer", ref: job.jobId };
    } else if (input.state === "blocked" && effectiveBlockedOn?.startsWith("qitem-")) {
      parkWake = { kind: "blocker", ref: effectiveBlockedOn };
    }

    const ts = new Date().toISOString();
    const fromState = qitem.state;

    // 0.5.1-53 Atom 1b(i) — clear-on-exit. blocked_on is set EXPLICITLY, not COALESCE'd:
    // a row keeps its blocker ONLY while `state=blocked` (effectiveBlockedOn = the new
    // blocker, else the one it already carried), and any exit from blocked CLEARS it to
    // NULL. The prior `COALESCE(?, blocked_on)` preserved the blocker on every non-blocked
    // transition, leaving dead blockers that nothing audits (the root-cause strand).
    const nextBlockedOn = input.state === "blocked" ? effectiveBlockedOn : null;
    const notification = this.classifyOwnerNotification({
      action: "update",
      destinationSession: qitem.destinationSession,
      previousState: qitem.state,
      previousBlockedOn: qitem.blockedOn,
      nextState: input.state,
      nextBlockedOn,
      explicitKind: input.ownerNotificationKind,
    });

    this.db
      .prepare(
        `UPDATE queue_items
           SET state = ?,
               ts_updated = ?,
               closure_reason = COALESCE(?, closure_reason),
               closure_target = COALESCE(?, closure_target),
               handed_off_to = COALESCE(?, handed_off_to),
               blocked_on = ?
         WHERE qitem_id = ?`
      )
      .run(
        input.state,
        ts,
        validation.closureReason,
        validation.closureTarget,
        input.handedOffTo ?? null,
        nextBlockedOn,
        input.qitemId
      );

    // FR-6: park-time summary/evidence_ref are PERSISTED onto the existing
    // item (not merely validated-then-dropped) — visible to the attention
    // query and to Packet 2. Only the park path writes them.
    if (isHumanPark) {
      this.persistSummary(input.qitemId, input.summary ?? null);
      this.persistEvidenceRef(input.qitemId, input.evidenceRef ?? null);
    }

    const transition = this.transitionLog.append({
      qitemId: input.qitemId,
      state: input.state,
      actorSession: input.actorSession,
      transitionNote: isReopen ? `reopen acknowledged: ${input.transitionNote}` : input.transitionNote,
      closureReason: validation.closureReason ?? undefined,
      closureTarget: validation.closureTarget ?? undefined,
      identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
      ownerNotificationKind: notification?.kind,
      ownerNotificationLevel: notification?.level,
    });
    if (parkWake) {
      // OPR.0.5.8.1 S1b addendum — A NEW PARK EPISODE SUPERSEDES THE OLD.
      // Re-parking (blocked -> blocked with a fresh --wake-after) used to arm a
      // second job while the first stayed active, leaving two live timers on one
      // row: the third repeat-fire route, alongside the never-stopped fire and
      // the row-outliving timer.
      //
      // Read BEFORE recording the new armed row: getStatus returns the most
      // recent armed wake, so after the record below it would return the one we
      // are arming now rather than the one being superseded.
      //
      // Deliberately not gated on the previous state. The live+timer test is the
      // real safety, and leaving it ungated also cleans up a stale park-generated
      // timer left by any path that did not unpark cleanly. It cannot over-reach:
      // a job already terminal fails `live`, and an operator's attached watchdog
      // fails the kind test.
      if (this.wakeRepo.getStatus(input.qitemId)?.ref !== parkWake.ref) {
        this.retireParkGeneratedTimer(input.qitemId, "park_superseded");
      }
      this.wakeRepo.record({
        transitionId: transition.transitionId,
        qitemId: input.qitemId,
        phase: "armed",
        kind: parkWake.kind,
        ref: parkWake.ref,
        deliveryStatus: null,
      });
    } else if (fromState === "blocked" && input.state !== "blocked") {
      // OPR.0.5.8.1 S1b — a park-generated timer is bound to the PARK EPISODE.
      // Leaving `blocked` ends it, so a wake can never arrive telling a seat to
      // resume a row that is no longer parked. Specimen: job
      // 01M1E6F3QG41N76Y1CDX48P766 fired at 10:18:07Z for a row that went
      // handed-off at 10:02:03Z — sixteen minutes terminal, and the wake still
      // said "resume the recorded continuation".
      //
      // Stopping AT THE TRANSITION rather than checking row state at fire time,
      // because the fire path delivers before it consults the queue at all:
      // `recordWatchdogWakeAttempt` runs after delivery and merely returns early
      // when the row is gone, so a check there would audit a wake that had
      // already been sent.
      //
      // ONLY kind === "timer" is stopped. Those jobs are generated by this park
      // and owned by it. A watchdog the operator attached with --wake-watchdog
      // (kind "watchdog") is theirs, may target other rows, and must survive.
      this.retireParkGeneratedTimer(input.qitemId, `park_ended:${input.state}`);
    }

    // 0.5.1-53 Atom 1b(iii) — propagate-completion. blocked_on PROMISES "A waits until B completes";
    // that promise never fired on this runtime (rows sat blocked on done/canceled blockers for days).
    // When THIS qitem reaches a terminal state, auto-unpark every row parked on it (blocked_on = this,
    // state='blocked') to pending, clear its (now-resolved) blocker, log the transition, and emit an
    // event so watchers/sweeps see the unblock without a fetch.
    const dependentEvents: PersistedEvent[] = !isBlockerLive(input.state)
      ? this.propagateBlockerCompletion({
          qitemId: input.qitemId,
          terminalState: input.state,
          actorSession: input.actorSession,
          identityProvenance: input.identityProvenance ?? null,
          ts,
        })
      : [];

    const persistedEvent = this.eventBus.persistWithinTransaction({
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
    return { persistedEvent, persistedEvents: [...dependentEvents, persistedEvent] };
  }

  /** OPR.0.5.6.26 — THE ONE PROPAGATION SITE. blocked_on promises "A waits until B
   *  completes"; every terminal closure of a blocker actuates the attached rows'
   *  auto-unpark through THIS helper — the update path and the handoff family both
   *  call it inside their own transactions. The class this unifies away was
   *  per-code-path: the handoff verbs wrote terminal states via direct SQL and the
   *  promise never fired for them. Never a second copy of this logic. */
  /**
   * OPR.0.5.8.1 S1b — retire the timer a park generated for this row.
   *
   * THE SINGLE PLACE THIS DECISION IS MADE. `queue_items.state` is written by
   * SIX methods, not one, and the first version of this repair only hooked the
   * generic `updateInTransactionalContext`. Every other writer silently kept the
   * timer alive — including `handoff()`, which is the exact route that produced
   * the motivating specimen (review50-r2 found that one; enumerating the rest
   * found `claim()` and `propagateBlockerCompletion()` too, and `claim()` is the
   * "claim-resume" the story contract named explicitly).
   *
   * Callers must invoke this inside their own state-transition transaction, so a
   * row can never be observed out of its park with a live park timer.
   *
   * Only park-GENERATED timers are retired. A watchdog the operator attached with
   * `--wake-watchdog` is theirs, may target other rows, and always survives.
   * Non-live jobs are left alone, so calling this twice is harmless.
   */
  private retireParkGeneratedTimer(qitemId: string, reason: string): void {
    const armed = this.wakeRepo.getStatus(qitemId);
    if (armed?.kind !== "timer" || !armed.live) return;
    // An explicit --wake-watchdog attachment gives another continuation custody
    // of this same job. The timer row's exit cannot cancel that attachment.
    if (this.wakeRepo.findLiveQitemsByAttachedWatchdog(armed.ref).length > 0) return;
    (this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db)).markTerminal(armed.ref, reason);
  }

  private propagateBlockerCompletion(input: {
    qitemId: string;
    terminalState: string;
    actorSession: string;
    identityProvenance: string | null;
    ts: string;
  }): PersistedEvent[] {
    const dependentEvents: PersistedEvent[] = [];
    const blockedRows = this.db
      .prepare("SELECT qitem_id, destination_session FROM queue_items WHERE blocked_on = ? AND state = 'blocked'")
      .all(input.qitemId) as Array<{ qitem_id: string; destination_session: string }>;
    for (const r of blockedRows) {
      const closed = this.getById(input.qitemId);
      const successors = input.terminalState === "handed-off" ? this.db.prepare(
        "SELECT qitem_id FROM queue_items WHERE handed_off_from = ? AND destination_session = ?",
      ).all(input.qitemId, closed?.handedOffTo ?? "") as Array<{ qitem_id: string }> : [];
      const successor = successors.length === 1 ? this.getById(successors[0]!.qitem_id) : null;
      if (successor && isBlockerLive(successor.state) && successor.destinationSession !== r.destination_session) {
        // Onward custody is a changed blocker. Returning to the waiting owner
        // below is the result arrival that actually resumes its continuation.
        const oldWake = this.wakeRepo.getStatus(r.qitem_id);
        this.db.prepare("UPDATE queue_items SET blocked_on = ?, ts_updated = ? WHERE qitem_id = ?")
          .run(successor.qitemId, input.ts, r.qitem_id);
        const rebound = this.transitionLog.append({ qitemId: r.qitem_id, state: "blocked", actorSession: input.actorSession,
          transitionNote: `blocker custody moved from ${input.qitemId} to ${successor.qitemId}`,
          identityProvenance: input.identityProvenance });
        const jobs = this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db);
        const retainedTimer = oldWake?.kind === "timer" && retargetQueueWait(this.db, jobs, oldWake.ref, successor.qitemId);
        if (!retainedTimer) this.retireParkGeneratedTimer(r.qitem_id, "blocker_custody_moved");
        this.wakeRepo.record({ transitionId: rebound.transitionId, qitemId: r.qitem_id, phase: "armed",
          kind: retainedTimer ? "timer" : "blocker", ref: retainedTimer ? oldWake!.ref : successor.qitemId, deliveryStatus: null });
        const event = this.eventBus.persistWithinTransaction({ type: "queue.updated", qitemId: r.qitem_id,
          fromState: "blocked", toState: "blocked", closureReason: null, closureTarget: null,
          actorSession: input.actorSession, summary: this.getById(r.qitem_id)?.summary ?? null });
        this.eventBus.registerPersistedWithinActiveEnvelope(event);
        dependentEvents.push(event);
        continue;
      }
      this.db
        .prepare("UPDATE queue_items SET state = 'pending', blocked_on = NULL, ts_updated = ? WHERE qitem_id = ?")
        .run(input.ts, r.qitem_id);
      const resumeTransition = this.transitionLog.append({
        qitemId: r.qitem_id,
        state: "pending",
        actorSession: input.actorSession,
        transitionNote: `auto-unparked: blocker ${input.qitemId} reached terminal state '${input.terminalState}'`,
      });

      // OPR.0.5.8.1 S1b — AUTO-UNPARK. A row parked with `--on X --wake-after 20m`
      // carries BOTH a blocker and a timer; when X completes this unparks the row
      // directly, so without this the blocker did its job and the timer still fired
      // afterwards at a row that was no longer parked.
      this.retireParkGeneratedTimer(r.qitem_id, "park_ended:auto-unparked");
      const wakeIntentId = this.stageAutoUnparkWakeIntent({
        qitemId: r.qitem_id,
        destinationSession: r.destination_session,
        fromSession: input.actorSession,
        identityProvenance: input.identityProvenance,
        blockerQitemId: input.qitemId,
        resumeTransitionId: resumeTransition.transitionId,
      });
      if (wakeIntentId) this.deliverWakeIntentAfterCommit(wakeIntentId);
      const dependentEvent = this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId: r.qitem_id,
        fromState: "blocked",
        toState: "pending",
        closureReason: null,
        closureTarget: null,
        actorSession: input.actorSession,
        summary: this.getById(r.qitem_id)?.summary ?? null,
      });
      this.eventBus.registerPersistedWithinActiveEnvelope(dependentEvent);
      dependentEvents.push(dependentEvent);
    }
    return dependentEvents;
  }

  getParkWakeStatus(qitemId: string): ParkWakeStatus | null {
    return this.wakeRepo.getStatus(qitemId);
  }

  /** Park timers a seat swap keeps: each is still its blocked row's current wake and still targets the
   *  row's owner (see QueueWakeRepository.currentParkTimerIds). */
  currentParkTimerIds(): string[] {
    return this.wakeRepo.currentParkTimerIds();
  }

  /** Generated jobs end when neither their original park nor an unfired
   *  attachment still owns them. Standalone operator jobs keep their lifecycle. */
  resolveWatchdogPreDeliveryTerminalReason(jobId: string): string | null {
    const targets = this.wakeRepo.findQitemsByGeneratedTimer(jobId);
    if (targets.length === 0 || this.wakeRepo.findCurrentQitemsByGeneratedTimer(jobId).length > 0) return null;
    if (this.wakeRepo.findLiveQitemsByAttachedWatchdog(jobId).length > 0) return null;
    return "park_timer_target_terminal";
  }

  listTransitions(qitemId: string): Array<ReturnType<QueueTransitionLog["listForQitem"]>[number] & { wake?: ReturnType<QueueWakeRepository["getForTransition"]> }> {
    return this.transitionLog.listForQitem(qitemId).map((transition) => {
      const wake = this.wakeRepo.getForTransition(transition.transitionId);
      return wake ? { ...transition, wake } : transition;
    });
  }

  /** Read-only scope-aware RECENT projection. Normalization and its hard cap
   * live with the append-only transition log; the repository owns the public
   * queue-domain door. */
  listRecentTransitions(scope: RecentQueueTransitionScope | string, limit = 20): ReturnType<QueueTransitionLog["listRecent"]> {
    return this.transitionLog.listRecent(typeof scope === "string" ? { kind: "rig", rig: scope } : scope, limit);
  }

  /** Called by the watchdog engine after the delivery attempt is durably
   *  audited. The queue transition records that attempt independently of
   *  whether the HELD row's owner consumed it. */
  recordWatchdogWakeAttempt(jobId: string, deliveryStatus: string): void {
    const bindings = this.wakeRepo.findBlockedQitemsByWatchdog(jobId);
    if (bindings.length === 0) return;
    // Both receipt ownership and timer lifecycle follow the current park.
    const targets = this.wakeRepo.findBlockedQitemsByWatchdog(jobId, true);
    const recordFired = ({ qitemId, kind }: (typeof targets)[number]): PersistedEvent => {
      const transition = this.transitionLog.append({
        qitemId,
        state: "blocked",
        actorSession: "watchdog@system",
        transitionNote: deliveryStatus === "retained"
          ? `park wake retained: watchdog ${jobId}; not delivered; blocked work unchanged`
          : `park wake fired: watchdog ${jobId}; delivery=${deliveryStatus}; awaiting owner consumption`,
      });
      this.wakeRepo.record({
        transitionId: transition.transitionId,
        qitemId,
        phase: "fired",
        kind,
        ref: jobId,
        deliveryStatus,
      });
      return this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId,
        fromState: "blocked",
        toState: "blocked",
        closureReason: null,
        closureTarget: null,
        actorSession: "watchdog@system",
        summary: this.getById(qitemId)?.summary ?? null,
      });
    };
    const usageLimitBlockers = targets.filter(({ qitemId }) =>
      this.getById(qitemId)?.tags?.includes(USAGE_LIMIT_BLOCKER_TAG),
    );
    // OPR.0.5.8.1 S1b — a park-generated timer is ONE-SHOT. `periodic-reminder`
    // repeats every intervalSeconds forever, so an unstopped park timer wakes its
    // owner again at +2 intervals, +3, indefinitely.
    //
    // The provider-limit path below already ends its job after firing; that
    // behaviour is UNCHANGED by this repair and pinned as unchanged. This widens
    // the same act to ordinary park timers, without their blocker resolution —
    // resolving the blocker is a provider-limit outcome, not a timer one.
    const parkGeneratedTimer = this.wakeRepo.findCurrentQitemsByGeneratedTimer(jobId).length > 0;
    const events = this.db.transaction(() => {
      const firedEvents = targets.map(recordFired);
      if (deliveryStatus === "retained") return firedEvents;
      if (usageLimitBlockers.length === 0) {
        if (parkGeneratedTimer && !backOffQueueWait(this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db), jobId, deliveryStatus)) {
          (this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db)).markTerminal(
            jobId,
            "park_timer_fired_once",
          );
        }
        return firedEvents;
      }

      (this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db)).markTerminal(
        jobId,
        "usage_limit_expiry_fired",
      );
      const resolutionEvents = usageLimitBlockers.flatMap(({ qitemId }) =>
        this.updateInTransactionalContext({
          qitemId,
          actorSession: "watchdog@system",
          state: "done",
          closureReason: "no-follow-on",
          transitionNote: `provider-limit timer ${jobId} reached its expiry; resolving the shared blocker once`,
        }).persistedEvents,
      );
      return [...firedEvents, ...resolutionEvents];
    })();
    for (const event of events) this.eventBus.notifySubscribers(event);
  }

  /**
   * #193 — record one clicked answer on a pending decision that carries structured questions.
   * Only the decision's own human may answer, and only while it is pending. A click may change
   * an earlier answer until the set is complete; from then on the answers are FINAL, and any
   * further click returns them unchanged so the caller can retry the continuation (reply row +
   * resolve) with exactly what the seat will read. Anything else is not-applicable (a forged
   * id, a stranger, a decision already resolved), never an error the socket must retry.
   */
  recordHumanAnswer(input: { qitemId: string; actorSession: string; questionId: string; optionId: string }): RecordHumanAnswerResult {
    if (!this.hasHumanQuestionsColumn) return { status: "not-applicable", reason: "schema" };
    return this.db.transaction(() => {
      const item = this.getById(input.qitemId);
      if (!item?.humanQuestions?.length) return { status: "not-applicable" as const, reason: "no-questions" };
      if (item.state !== "pending") return { status: "not-applicable" as const, reason: `state-${item.state}` };
      if (item.destinationSession !== input.actorSession) return { status: "not-applicable" as const, reason: "not-the-asked-human" };
      const question = item.humanQuestions.find((q) => q.id === input.questionId);
      if (!question?.options.some((o) => o.id === input.optionId)) return { status: "not-applicable" as const, reason: "unknown-option" };
      const recorded = item.humanAnswers ?? {};
      if (unansweredQuestions(item.humanQuestions, recorded).length === 0) {
        return { status: "recorded" as const, answers: recorded, complete: true, questions: item.humanQuestions };
      }
      const answers: HumanAnswers = { ...(item.humanAnswers ?? {}), [input.questionId]: input.optionId };
      this.db.prepare("UPDATE queue_items SET human_answers = ? WHERE qitem_id = ?").run(JSON.stringify(answers), input.qitemId);
      const complete = unansweredQuestions(item.humanQuestions, answers).length === 0;
      return { status: "recorded" as const, answers, complete, questions: item.humanQuestions };
    })();
  }

  getById(qitemId: string): QueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as QueueItemRow | undefined;
    if (!row) return null;
    const item = this.rowToItem(row);
    // OPR.0.5.6.14 — the row FACE answers "did it reach them" in one read for
    // gateway-routed rows; null for pane-bound (absence-governed, no key lies).
    const ledger = this.deliveryOutcomeFor(item.qitemId);
    return {
      ...item,
      deliveryOutcome: ledger?.outcome ?? null,
      ...(ledger && ledger.outcome !== "posted" ? { deliveryFailureDetail: ledger.detail } : {}),
      ...(item.replyTo ? { replyToFallback: this.replyToFallbackFor(item.qitemId) } : {}),
    };
  }

  /** #96 — the thread choice the daemon recorded before this replyTo update's first post;
   *  null = not yet chosen. Only an in-process daemon write counts: any HTTP write carries an
   *  identity provenance (and its actor is caller-asserted), so a note from there could forge
   *  a thread and is ignored. */
  replyToChoiceFor(qitemId: string): ReplyToChoice | null {
    for (const t of this.transitionLog.listForQitem(qitemId).reverse()) {
      if (t.actorSession !== REPLY_TO_CHOICE_ACTOR || t.identityProvenance !== null) continue;
      const choice = parseReplyToChoice(t.transitionNote ?? "");
      if (choice) return choice;
    }
    return null;
  }

  /** #96 — whether some update recorded this Slack root as the thread it posts into. Such a
   *  root is shared: its owner's next decision must not reuse it (see slack-subsystem). */
  isReplyToThread(threadTs: string): boolean {
    if (!this.hasQueueTransitionsTable) return false;
    // Same trust rule as replyToChoiceFor: a pre-provenance schema reads every row as null.
    const provenance = this.hasTransitionProvenanceColumn ? " AND identity_provenance IS NULL" : "";
    return this.db.prepare(
      `SELECT 1 FROM queue_transitions WHERE transition_note = ? AND actor_session = ?${provenance} LIMIT 1`,
    ).get(formatReplyToChoice({ kind: "thread", threadTs }), REPLY_TO_CHOICE_ACTOR) !== undefined;
  }

  private replyToFallbackFor(qitemId: string): string | null {
    const choice = this.replyToChoiceFor(qitemId);
    return choice?.kind === "fallback" ? describeReplyToFallback(choice) : null;
  }

  list(opts?: QueueListOptions): QueueItem[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.tag) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)");
      params.push(opts.tag);
    }

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
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS + (this.hasHumanIntentColumn ? ", human_intent" : "") : "*";
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
    const items = rows.map((r) => {
      const item = this.rowToItem(r, !opts?.compact);
      const ledger = this.deliveryOutcomeFor(item.qitemId);
      return {
        ...item,
        deliveryOutcome: ledger?.outcome ?? null,
        ...(ledger && ledger.outcome !== "posted" ? { deliveryFailureDetail: ledger.detail } : {}),
      };
    });
    return opts?.compact
      ? items.map((item) => ({
          ...item,
          fieldsElided: ["body", "summary", "evidenceRef", "humanDetail", "waiting"],
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
  /** Delivered informational records remain queryable after closure. Receipt filtering
   * happens before LIMIT; no prose/tier classifier and no second event store. */
  listDeliveredHumanUpdates(opts: { limit?: number } = {}): Array<QueueItem & { deliveredAt: string; deliveryReceipt: string }> {
    if (!this.hasHumanIntentColumn) return [];
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(101, Math.floor(opts.limit!))) : 20;
    const receipts = `SELECT qitem_id, ts, transition_note FROM queue_transitions` +
      (detectTable(this.db, "queue_transitions_archive") ? ` UNION ALL SELECT qitem_id, ts, transition_note FROM queue_transitions_archive` : "");
    const rows = this.db.prepare(`
      SELECT q.*, r.ts AS delivered_at, r.transition_note AS delivery_receipt
      FROM queue_items q JOIN (${receipts}) r ON r.qitem_id = q.qitem_id
      WHERE q.human_intent = 'update' AND is_human_seat_session(q.destination_session) = 1
        AND r.transition_note LIKE 'slack-owner-notification-posted %'
      ORDER BY r.ts DESC, q.qitem_id DESC LIMIT ?
    `).all(limit) as Array<QueueItemRow & { delivered_at: string; delivery_receipt: string }>;
    return rows.map((row) => ({ ...this.rowToItem(row), deliveredAt: row.delivered_at, deliveryReceipt: row.delivery_receipt }));
  }

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
        is_human_seat_session(destination_session) = 1
        OR (state = 'blocked' AND is_human_seat_session(blocked_on) = 1)
      )`,
    ];
    if (this.hasHumanIntentColumn) conditions.push("COALESCE(human_intent, 'decision') <> 'update'");
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
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS + (this.hasHumanIntentColumn ? ", human_intent" : "") : "*";
    let sql = `SELECT ${columns} FROM queue_items WHERE ${conditions.join(" AND ")} ORDER BY closure_required_at ASC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r, !opts?.compact));
  }

  /**
   * Record that an in-progress queue item has exceeded its closure_required_at
   * deadline, appending a transition note and emitting `qitem.closure_overdue`.
   *
   * Deduplicated: if this obligation has already recorded `closure-overdue`
   * since it was claimed (or created), no duplicate event or transition is emitted.
   */
  recordClosureOverdue(qitemId: string, opts?: { now?: string }): PersistedEvent | null {
    const qitem = this.getById(qitemId);
    if (!qitem || qitem.state !== "in-progress" || !qitem.closureRequiredAt) return null;
    const cutoff = opts?.now ?? new Date().toISOString();
    if (qitem.closureRequiredAt > cutoff) return null;
    const claimSince = qitem.claimedAt ?? qitem.tsCreated;
    if (this.hasQueueTransitionsTable) {
      const alreadyRecorded = this.db.prepare(
        `SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_note = 'closure-overdue' AND ts >= ? LIMIT 1`,
      ).get(qitemId, claimSince);
      if (alreadyRecorded) return null;
      if (detectTable(this.db, "queue_transitions_archive")) {
        const alreadyRecordedArchive = this.db.prepare(
          `SELECT 1 FROM queue_transitions_archive WHERE qitem_id = ? AND transition_note = 'closure-overdue' AND ts >= ? LIMIT 1`,
        ).get(qitemId, claimSince);
        if (alreadyRecordedArchive) return null;
      }
    } else {
      const alreadyRecorded = this.db.prepare(
        `SELECT 1 FROM events WHERE type = 'qitem.closure_overdue' AND json_extract(payload, '$.qitemId') = ? AND julianday(created_at) >= julianday(?) LIMIT 1`,
      ).get(qitemId, claimSince);
      if (alreadyRecorded) return null;
    }
    const txn = this.db.transaction(() => {
      if (this.hasQueueTransitionsTable) {
        this.transitionLog.append({
          qitemId,
          state: qitem.state,
          actorSession: "daemon@system",
          transitionNote: "closure-overdue",
          closureTarget: this.retainedClaimBlocker(qitemId),
        });
      }
      return this.eventBus.persistWithinTransaction({
        type: "qitem.closure_overdue",
        qitemId,
        destinationSession: qitem.destinationSession,
        closureRequiredAt: qitem.closureRequiredAt!,
        overdueSince: qitem.closureRequiredAt!,
      });
    });
    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return persisted;
  }

  /**
   * Surface two evidence-backed undelivered classes: the original pending
   * create-path nudge failures, and active human-notification episodes whose
   * gateway ledger says transport-failed or receiptless past the post window.
   * A generic null nudge is still excluded; only a structured OWNER episode
   * makes that absence meaningful. READ only — no retry or unwind.
   */
  findUndelivered(opts?: { rig?: string; limit?: number; compact?: boolean }): QueueItem[] {
    // OPR.0.5.6.14 — delivery truth belongs to the CURRENT human-notification
    // episode, not to the row's whole history. Pull every active row that can
    // carry a current episode or a legacy nudge/receipt, then derive/filter in
    // JS. LIMIT is applied after that filtering so historical POSTED episodes
    // cannot consume the window and hide a later failure.
    const ownerEpisodeCandidate = this.hasOwnerNotificationColumns
      ? `EXISTS (SELECT 1 FROM queue_transitions owner_episode
                   WHERE owner_episode.qitem_id = queue_items.qitem_id
                     AND owner_episode.owner_notification_level IS NOT NULL)`
      : "0";
    const conditions = [
      "state IN ('pending', 'in-progress', 'blocked')",
      `((state = 'pending' AND (last_nudge_result LIKE 'failed:%'
                             OR last_nudge_result LIKE 'unroutable:%'
                             OR last_nudge_result LIKE 'gateway-owned%'))
         OR ${ownerEpisodeCandidate}
         OR EXISTS (SELECT 1 FROM queue_transitions receipt
                      WHERE receipt.qitem_id = queue_items.qitem_id
                        AND (receipt.transition_note LIKE 'slack-owner-notification-posted %'
                          OR receipt.transition_note LIKE 'slack-owner-notification-transport-failed %')))`,
    ];
    const params: unknown[] = [];
    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS + (this.hasHumanIntentColumn ? ", human_intent" : "") : "*";
    const sql = `SELECT ${columns} FROM queue_items WHERE ${conditions.join(" AND ")} ORDER BY ts_created ASC`;
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
    const out: QueueItem[] = [];
    for (const r of rows) {
      const item = this.rowToItem(r, !opts?.compact);
      const ledger = this.deliveryOutcomeFor(item.qitemId);
      if (ledger?.outcome === "posted") continue; // the receipt wins, always
      if (ledger?.outcome === "transport-failed") {
        out.push({
          ...item,
          deliveryOutcome: "transport-failed",
          deliveryFailureClass: "transport-failed",
          deliveryFailureDetail: ledger.detail,
        });
      } else if (ledger?.outcome === "never-posted") {
        out.push({
          ...item,
          deliveryOutcome: "never-posted",
          deliveryFailureClass: "never-posted",
          deliveryFailureDetail: ledger.detail,
        });
      } else {
        // No ledger verdict: only the legacy pending failed/unroutable class is
        // undelivered. An active non-human row can still have an old OWNER
        // transition; that historical episode is not a current obligation.
        const lastNudge = item.lastNudgeResult ?? "";
        if (item.state === "pending" && (lastNudge.startsWith("failed:") || lastNudge.startsWith("unroutable:"))) {
          out.push(item);
        }
      }
      if (opts?.limit !== undefined && out.length >= opts.limit) break;
    }
    return out;
  }

  /** OPR.0.5.6.14 — terminal transport is a CAPABILITY, not topology presence.
   *  An exact session or composed canonical seat is pane-bound only when its
   *  node carries an explicit tmux binding. external_cli is paneless and must
   *  continue to the human-registry/gateway leg. FAIL-OPEN only where the DB
   *  cannot carry classification evidence (empty/partial bootstrap schemas). */
  private hasTerminalTransport(dest: string): boolean {
    try {
      const anyTopology = this.db.prepare("SELECT 1 FROM sessions LIMIT 1").get()
        ?? this.db.prepare("SELECT 1 FROM nodes LIMIT 1").get();
      if (!anyTopology) return true;
      if (this.db.prepare(
        `SELECT 1 FROM sessions s JOIN bindings b ON b.node_id = s.node_id
          WHERE s.session_name = ?
            AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
            AND b.tmux_session IS NOT NULL LIMIT 1`,
      ).get(dest)) return true;
      const at = dest.lastIndexOf("@");
      if (at <= 0) return true; // non-canonical shapes stay on the legacy path
      const seat = dest.slice(0, at);
      const rig = dest.slice(at + 1);
      const composed = this.db.prepare(
        `SELECT 1 FROM nodes n
          JOIN rigs r ON r.id = n.rig_id
          JOIN bindings b ON b.node_id = n.id
          WHERE r.name = ? AND REPLACE(n.logical_id, '.', '-') = ?
            AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
            AND b.tmux_session IS NOT NULL LIMIT 1`,
      ).get(rig, seat);
      return !!composed;
    } catch {
      return true; // schema-partial fixture DB: never discriminate without evidence
    }
  }

  /** Null means legacy/no OWNER history; inactive means OWNER history exists
   *  but the row no longer projects a current human-notification episode. */
  private currentDeliveryEpisode(item: QueueItem, knownOwner?: QueueTransition): { notificationKey: string; startedAt: string } | "inactive" | null {
    let transition = knownOwner ?? this.transitionLog.latestOwnerNotificationForQitem(item.qitemId);
    if (!transition) return null;
    // A human-decision-resolved notice written BY the transition that closed the row (a human's direct reply closing
    // it) is never posted: the Slack outbound lists active rows only (listHumanAlerts), and that human just answered.
    // It opens no new delivery episode; the delivery that happened is the latest OUTBOUND notice's, to that human.
    // Judged by the notice's own transition, not the row's current state: a resolved notice written while the row
    // stayed active is a real delivery and keeps its outcome after an agent later closes the row.
    let resolvedBy: string | null = null;
    if (transition.ownerNotificationKind === "human-decision-resolved" && !["pending", "in-progress", "blocked"].includes(transition.state)) {
      const outbound = this.transitionLog.listForQitem(item.qitemId)
        .filter((t) => t.ownerNotificationLevel != null && t.ownerNotificationKind != null && t.ownerNotificationKind !== "human-decision-resolved")
        .sort((a, b) => b.transitionId - a.transitionId)[0];
      if (!outbound) return "inactive";
      resolvedBy = transition.actorSession;
      transition = outbound;
    }
    const registry = this.loadHumanRegistryFn();
    if (!registry.ok) return "inactive";
    // After that fallback the recipient is the human who answered: the row may be an agent's that was parked on them
    // (its destination is the agent, and closing cleared blocked_on).
    const humanAddress = resolvedBy !== null
      ? resolveRegisteredHumanAddress(resolvedBy, registry.entities)
      : transition.ownerNotificationKind === "human-decision-resolved"
      ? resolveRegisteredHumanAddress(transition.actorSession, registry.entities)
      : item.state === "blocked"
        ? resolveRegisteredHumanAddress(item.blockedOn, registry.entities)
        : resolveRegisteredHumanAddress(item.destinationSession, registry.entities);
    return humanAddress
      ? { notificationKey: `${item.qitemId}:${transition.transitionId}`, startedAt: transition.ts }
      : "inactive";
  }

  /** OPR.0.5.6.14 — derive the current episode's delivery ledger. Receipt
   *  transitions are same-row but keyed by qitemId:OWNER-transitionId; an old
   *  posted receipt cannot mask a later human park. Legacy pre-OWNER or literal
   *  external rows retain their row-scoped fallback. */
  deliveryOutcomeFor(qitemId: string): { outcome: "posted" | "transport-failed" | "never-posted"; detail: string } | null {
    const ledger = this.deliveryLedger(qitemId);
    return ledger ? { outcome: ledger.outcome, detail: ledger.detail } : null;
  }

  /** #514 — true only when this row's CURRENT human-notification episode (OWNER history addressed
   *  to a registered human, aliases included) has a POSTED receipt. Legacy rows with no OWNER
   *  history, inactive episodes, never-posted and transport-failed all read false. Same derivation
   *  as deliveryOutcomeFor; it reads row fields, never the waiting view. */
  humanNotificationPostedThisEpisode(qitemId: string): boolean {
    if (!this.hasQueueTransitionsTable) return false;
    // Only the ask's own notification binds a recipient: create writes it in state pending, to the destination of
    // that moment. A park notice (its recipient is not retained), a resolution notice, or a later destination change
    // (routeToFallback opens no new episode) cannot establish that the current destination received this ask.
    const owner = this.transitionLog.latestOwnerNotificationForQitem(qitemId);
    if (!owner || owner.state !== "pending") return false;
    if (owner.ownerNotificationKind !== "human-required" && owner.ownerNotificationKind !== "human-update") return false;
    const rerouted = this.db.prepare(
      "SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_id > ? AND transition_note LIKE 'fallback-routed:%' LIMIT 1",
    ).get(qitemId, owner.transitionId);
    if (rerouted) return false;
    // The ledger's episode exists only when the destination resolves to a registered human (aliases included).
    const ledger = this.deliveryLedger(qitemId, owner);
    return ledger !== null && ledger.outcome === "posted" && ledger.episode?.notificationKey === `${qitemId}:${owner.transitionId}`;
  }

  private deliveryLedger(qitemId: string, knownOwner?: QueueTransition): { outcome: "posted" | "transport-failed" | "never-posted"; detail: string; episode: { notificationKey: string; startedAt: string } | null } | null {
    // Some repository-only fixtures intentionally model the pre-transition
    // schema. Delivery projection is additive there: absence means no verdict,
    // never a list failure.
    if (!this.hasQueueTransitionsTable) return null;
    const row = this.db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as QueueItemRow | undefined;
    if (!row) return null;
    // The delivery episode uses row fields, not the waiting/backstop view.
    // Keep this read fresh without repeating the caller's recovery-tag scan.
    const item = this.rowToItem(row, false);
    const episodeState = this.currentDeliveryEpisode(item, knownOwner);
    if (episodeState === "inactive") return null;
    const episode = episodeState;
    const notes = this.db.prepare(
      `SELECT transition_note FROM queue_transitions
        WHERE qitem_id = ? AND (transition_note LIKE 'slack-owner-notification-posted %'
                             OR transition_note LIKE 'slack-owner-notification-transport-failed %')
        ORDER BY transition_id DESC`,
    ).all(qitemId) as Array<{ transition_note: string }>;
    const currentNotes = episode
      ? notes.filter((note) => note.transition_note.split(/\s+/).includes(`notification_key=${episode.notificationKey}`))
      : notes;
    const posted = currentNotes.find((note) => note.transition_note.startsWith("slack-owner-notification-posted "));
    if (posted) return { outcome: "posted", detail: posted.transition_note, episode };
    const failed = currentNotes.find((note) => note.transition_note.startsWith("slack-owner-notification-transport-failed "));
    if (failed) return { outcome: "transport-failed", detail: failed.transition_note, episode };
    const startedAt = episode?.startedAt ?? item.tsCreated;
    const gatewayRouted = episode !== null || item.lastNudgeResult?.startsWith("gateway-owned") === true;
    if (gatewayRouted) {
      const ageMs = Date.now() - new Date(startedAt.includes("T") ? startedAt : startedAt + "Z").getTime();
      if (ageMs > QueueRepository.NEVER_POSTED_WINDOW_MS) {
        const key = episode ? ` for notification_key=${episode.notificationKey}` : "";
        return { outcome: "never-posted", detail: `gateway-routed row with no delivery receipt${key} past the post window`, episode };
      }
    }
    return null;
  }

  /** The grace window before a receiptless gateway-routed row honestly reads
   *  never-posted (the connector sweep cadence bounds normal posting latency). */
  static readonly NEVER_POSTED_WINDOW_MS = 120_000;

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
      // A park timer targets the owner that parked the row. Once the row belongs to someone else it must not keep
      // waking the old owner, so it ends here like any other exit from the park. A repeating wait is left running:
      // it resolves its recipient from the row's current owner at delivery (evaluateQueueWait).
      const armed = this.wakeRepo.getStatus(qitemId);
      const armedJob = armed?.kind === "timer" ? (this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db)).getById(armed.ref) : null;
      if (!armedJob || !isQueueWait(armedJob.specYaml)) this.retireParkGeneratedTimer(qitemId, "park_rerouted");

      this.transitionLog.append({
        qitemId,
        state: qitem.state,
        actorSession: "system:queue-fallback",
        transitionNote: `fallback-routed: ${originalDestination} → ${fallbackDestination} (${reason})`,
        closureTarget: qitem.state === "in-progress" ? this.retainedClaimBlocker(qitemId) : undefined,
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

  private activityReader?: WaitingActivityReader;
  attachActivityReader(reader: WaitingActivityReader): void { this.activityReader = reader; }

  private workflowGuidance?: (packetId: string) => string[];
  attachWorkflowGuidance(reader: (packetId: string) => string[]): void { this.workflowGuidance = reader; }

  evaluateWaitReminder(input: { jobId: string }) {
    const binding = this.wakeRepo.findCurrentQitemsByGeneratedTimer(input.jobId)[0];
    if (!binding && this.wakeRepo.findLiveQitemsByAttachedWatchdog(input.jobId).length > 0) return null;
    const result = evaluateQueueWait(this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db), input.jobId, binding ? this.waitingView(binding.qitemId) : null);
    // Only an already-admitted send reads prose: healthy silence, receipts and
    // failed-delivery retries remain owned by the existing wait evaluator.
    if (result?.action === "send" && binding && this.workflowGuidance) {
      try { result.message += "\n" + this.workflowGuidance(binding.qitemId).join("\n"); }
      catch (error) { result.message += "\nWorkflow method: UNKNOWN: current guidance unavailable: " + String(error); }
    }
    return result;
  }

  ownerActivity(session: string): ReturnType<WaitingActivityReader> {
    try { return this.activityReader?.(session) ?? null; } catch { return null; }
  }

  waitingView(qitemId: string): WaitingView | null {
    const view = readWaitingView(this.db, qitemId, this.activityReader);
    if (view && ["pending", "in-progress"].includes(view.state)) {
      // #514 — the unclaimed sweep skips a pending ask already posted to its human in the current
      // episode (same predicate as runStuckSweep), so the view must not promise that sweep.
      const awaitingHuman = view.state === "pending" && this.humanNotificationPostedThisEpisode(qitemId);
      if (awaitingHuman) {
        view.nextBackstop = { owner: view.owner, mechanism: "none (posted to the human; awaiting their decision)", dueAt: null, intervalSeconds: null };
      }
      const recovery = readWakeLadderBackstop(this.db, qitemId);
      if (recovery) {
        if (!awaitingHuman) view.laterBackstop = { ...view.nextBackstop, note: "Conditional safety net; current delivery/recovery ownership is evaluated first." };
        view.nextBackstop = recovery;
      }
    }
    return view;
  }

  private handoffAdvisory(row: QueueItemRow): QueueItem["handoffAdvisory"] {
    // handoff() creates its local successor in the same transaction. Do not
    // scan successor history again on every projection of those source rows.
    if (row.state === "handed-off" || !isTerminalState(row.state)
      || row.closure_reason !== "handed_off_to" || !row.closure_target) return undefined;
    const target = row.closure_target;
    try {
      const successor = this.db.prepare(
        `SELECT 1 FROM queue_items s
          WHERE (s.qitem_id = ? OR s.destination_session = ?) AND s.qitem_id != ?
            AND (s.handed_off_from = ? OR EXISTS (
              SELECT 1 FROM json_each(s.chain_of_record) WHERE value = ?
            )) LIMIT 1`,
      ).get(target, target, row.qitem_id, row.qitem_id, row.qitem_id);
      // A linked row may have handed on to another owner. Its current state
      // does not establish whether later hops still hold the work.
      if (successor) return undefined;
    } catch {
      // Optional reporting must not fail a close that has already committed,
      // or describe an unavailable lookup as proof of a missing local row.
      return undefined;
    }
    const foreignTarget = /^qitem-[^@]+@[^@]+$/.test(target);
    return {
      status: "unverified",
      target,
      reason: "no-live-local-successor",
      message: foreignTarget
        ? `Successor custody for '${target}' is unverified on this daemon: the successor is named on that host, and this daemon cannot read its custody. This closure records a handoff claim, not proof of transfer or pickup.`
        : `Successor custody for '${target}' is unverified on this daemon: no local row with this source's lineage was found. A successor may exist on another host. This closure records a handoff claim, not proof of transfer or pickup; reconcile the successor by ID.`,
    };
  }

  private rowToItem(row: QueueItemRow, includeWaiting = true): QueueItem {
    // S04 — derive the pickup receipt at the ONE shared projection point (list/show/overdue
    // all flow through here), so the park-vs-strand question is answered by the row face.
    const meaningful = lastMeaningfulTransition(this.db, row.qitem_id);
    const waiting = includeWaiting ? this.waitingView(row.qitem_id) : null;
    const activity = this.ownerActivity(row.destination_session);
    const pickup = derivePickup({
      state: row.state,
      lastMeaningfulAt: meaningful?.at,
      activity: activity?.activity,
      needsInput: activity?.needsInput.count,
      claimedAt: row.claimed_at,
      lastHeartbeat: row.last_heartbeat,
      postClaimMotionCount: 0, // this reader supplies the current meaningful timestamp
    });
    const handoffAdvisory = this.handoffAdvisory(row);
    return {
      ...(handoffAdvisory ? { handoffAdvisory } : {}),
      pickup,
      ...(waiting ? { waiting } : {}),
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
      humanIntent: row.human_intent ?? null,
      humanDetail: row.human_detail ?? null,
      replyTo: row.reply_to ?? null,
      humanQuestions: row.human_questions ? (JSON.parse(row.human_questions) as HumanQuestion[]) : null,
      humanAnswers: row.human_answers ? (JSON.parse(row.human_answers) as HumanAnswers) : null,
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

function isQueueState(value: unknown): value is QueueState {
  return typeof value === "string" && (QUEUE_STATES as readonly string[]).includes(value);
}
