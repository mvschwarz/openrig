// #2829 slice 1 — queue-driven seat cold start.
//
// When a queue wake cannot land because its destination seat has no live receiver,
// and that seat belongs to a RUNNING rig and has opted in (`cold_start: true` on the
// member or its pod), the daemon launches just that seat's runner through the existing
// single-seat launch path (RestoreOrchestrator.launchSingleNode — the `rig launch`
// door). That door holds the seat-delivery-guard lifecycle lease for the whole launch
// (`launchNodeTargets` → `guard.lifecycle`), so a cold start never races an in-flight
// delivery, and it applies the ordinary restore decision: a `resume_if_possible` seat
// with a usable resume token RESUMES its conversation, and an unresumable one parks as
// `awaiting-decision` instead of silently fresh-priming over it.
//
// Eligibility is deliberately narrow (maintainer terms, #2829 2026-11-11). It is keyed
// on WHO stopped the seat, not merely that it is stopped (see `classifyColdStartStop`):
//   - the seat still exists in the current rig spec and opted in — a deleted seat or
//     one that never opted in never cold-starts;
//   - its latest stop was not an intentional operator stop (`rig seat stop`, a rig-wide
//     down, a removal) — those are deliberate end states and are never auto-revived;
//   - the one revivable stop is a resource-reclaiming daemon stop: slice 2's idle reaper
//     records itself as operator `daemon:seat-reaper` with reason `idle_reap` so new work
//     CAN wake the seat again;
//   - a rolled-back launch (`superseded` row, a failed start) is retryable, subject to
//     the same failure backoff as any other attempt;
//   - the rig is up: some OTHER seat of the same rig has a live tmux session — a down rig
//     keeps today's whole-rig deferral semantics;
//   - the seat's tmux session is really gone (re-probed here, not trusted from the
//     queue's classification).
//
// Single-launch guarantee: N simultaneous arrivals for one dormant seat produce exactly
// ONE launch. Concurrent notifications for a node join one in-flight attempt (the map
// below), and the durable ledger claims the attempt window BEFORE the launch starts, so
// neither a second drain pass nor the wake-ladder's retries can launch again inside the
// window. Pickup needs no new code: once the seat is observed running, the existing
// unroutable-wake retry (#2790) re-sends the waiting rows.
import type Database from "better-sqlite3";
import { parseSessionName } from "./session-name.js";
import type { RigSpec } from "./types.js";
import type { SeatDeliveryGuard } from "./seat-delivery-guard.js";

/** Minimum time between cold-start attempts for one seat. */
export const COLD_START_MIN_INTERVAL_MS = 60_000;
/** After this many consecutive failed attempts the seat stops cold-starting until a launch succeeds. */
export const COLD_START_MAX_CONSECUTIVE_FAILURES = 3;
export const COLD_START_FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * The stops the daemon itself may undo on new work. A resource-reclaiming stop is not an
 * end to the seat's work: the idle reaper (a separate slice) stops a seat as
 * `daemon:seat-reaper` with reason `idle_reap` precisely so the next queue row can wake
 * it. Every other operator — a human `rig seat stop`, `rig down`, a removal — records an
 * end state, and cold start never revives it.
 */
export const COLD_START_REVIVABLE_STOPS: ReadonlyArray<{ operator: string; reason: string }> = [
  { operator: "daemon:seat-reaper", reason: "idle_reap" },
];

/** Why a seat is stopped, from the daemon's own records. Only `dormant`, `failed_start` and
 *  `daemon_reclaim` may be woken; `intentional` carries the operator/reason for the log. */
export type ColdStartStopIntent =
  | { kind: "dormant" }
  | { kind: "failed_start" }
  | { kind: "daemon_reclaim"; operator: string; reason: string }
  | { kind: "intentional"; operator: string | null; reason: string | null };

/** What the single-seat launch door reported for this one seat. Structural subset of the
 *  restore orchestrator's `NarrowLaunchResult`, so this module never imports it. */
export interface ColdStartLaunchResult {
  ok: boolean;
  code?: string;
  message?: string;
  launched?: Array<{ logicalId: string; status: string; error?: string }>;
  alreadyRunning?: Array<{ logicalId: string }>;
  failedTargets?: Array<{ logicalId: string; reason: string }>;
}

/** The launch door's outcome for one seat. `resumed`/`fresh_primed`/`already_running` are the
 *  only success shapes; `awaiting_decision` means the door refused to replace an unresumable
 *  conversation with a fresh one (the maintainer's continuity term), not a launch. */
export type ColdStartLaunchOutcome =
  | { kind: "resumed" }
  | { kind: "fresh_primed" }
  | { kind: "already_running" }
  | { kind: "awaiting_decision"; error: string }
  | { kind: "failed"; error: string };

/** Does a recorded stop belong to one of the revivable daemon stops? */
function isRevivableStop(operator: string, reason: string): boolean {
  return COLD_START_REVIVABLE_STOPS.some(stop => stop.operator === operator && stop.reason === reason);
}

/**
 * Classify why a seat is not running, keyed on WHO stopped it.
 *
 * The stop path records a boolean intent on the session row (`intentionally_stopped`) and,
 * a `session.stopped` event carrying the session id, operator and reason. The
 * boolean alone cannot express the difference the maintainer asked for — the reaper and a
 * human both set it — so eligibility reads the event when the flag is set. Attribution
 * uses the existing transactional event ledger, not a reusable tmux name: a missing or
 * legacy event without this exact session id is conservative, never revivable.
 */
export function classifyColdStartStop(db: Database.Database, nodeId: string): ColdStartStopIntent {
  const latest = db.prepare(`SELECT id AS sessionId, session_name AS sessionName, status, intentionally_stopped AS intentionallyStopped
    FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(nodeId) as { sessionId: string; sessionName: string; status: string; intentionallyStopped: number } | undefined;
  // A seat that never ran has nothing to replace: the door legitimately fresh-primes it.
  if (!latest) return { kind: "dormant" };
  // No recorded stop intent: an observed exit (crash), a detached session, or a session the
  // daemon lost. None of those is a decision to keep the seat down.
  if (latest.intentionallyStopped !== 1) {
    return { kind: latest.status === "superseded" ? "failed_start" : "dormant" };
  }

  const event = db.prepare(`SELECT payload FROM events
    WHERE node_id = ? AND type = 'session.stopped' ORDER BY seq DESC LIMIT 1`)
    .get(nodeId) as { payload: string } | undefined;
  if (event) {
    try {
      const payload: unknown = JSON.parse(event.payload);
      // Only an event for this exact session row attributes this stop. An older event cannot
      // explain a newer flag, so it stays intentional rather than reviving on stale evidence.
      if (typeof payload === "object" && payload !== null && "sessionId" in payload && payload.sessionId === latest.sessionId) {
        const operator = "operator" in payload && typeof payload.operator === "string" ? payload.operator : null;
        const reason = "reason" in payload && typeof payload.reason === "string" ? payload.reason : null;
        if (operator && reason && isRevivableStop(operator, reason)) return { kind: "daemon_reclaim", operator, reason };
        return { kind: "intentional", operator, reason };
      }
    } catch {
      /* an unparseable event explains nothing: stay conservative below */
    }
  }
  return { kind: "intentional", operator: null, reason: null };
}

/** Read the single-seat launch door's result for one seat without assuming `ok` means launched:
 *  the door also reports held/awaiting seats and already-running ones with `ok: true`. */
export function classifyColdStartLaunch(logicalId: string, result: ColdStartLaunchResult): ColdStartLaunchOutcome {
  const failed = result.failedTargets?.find(target => target.logicalId === logicalId);
  if (failed) return { kind: "failed", error: failed.reason };
  const launched = result.launched?.find(node => node.logicalId === logicalId);
  if (launched) {
    if (launched.status === "resumed" || launched.status === "rebuilt" || launched.status === "operator_recovered") return { kind: "resumed" };
    if (launched.status === "fresh-primed" || launched.status === "fresh") return { kind: "fresh_primed" };
    if (launched.status === "awaiting-decision") {
      return { kind: "awaiting_decision", error: launched.error ?? "the launch door stopped for an operator decision" };
    }
    if (launched.status === "attention_required") {
      return { kind: "awaiting_decision", error: launched.error ?? "the seat started and parked on a runtime prompt" };
    }
    if (launched.status === "left_attached") return { kind: "already_running" };
    return { kind: "failed", error: launched.error ?? `launch reported status '${launched.status}'` };
  }
  if (result.alreadyRunning?.some(node => node.logicalId === logicalId)) return { kind: "already_running" };
  // Fail closed: an unreported target is not evidence that the seat came up.
  if (!result.ok) return { kind: "failed", error: result.message ?? result.code ?? "the launch door refused" };
  return { kind: "failed", error: result.message ?? "the launch door returned no outcome for this seat" };
}

export interface SeatColdStartDeps {
  db: Database.Database;
  deliveryGuard: Pick<SeatDeliveryGuard, "lifecycle">;
  /** The existing single-seat launch door (`rig launch`): resumes or fresh-primes per restore policy. */
  launchSingleNode: (rigId: string, logicalId: string) => Promise<ColdStartLaunchResult>;
  /** Live tmux probe; the same adapter the queue's transport uses. */
  hasSession: (sessionName: string) => Promise<boolean>;
  /** Reads the seat's persisted rig spec (opt-in source of truth). */
  getNodeLaunchRecipe: (nodeId: string) => { rigSpec: RigSpec } | null;
  log?: (line: string) => void;
  now?: () => Date;
}

interface SeatRow {
  nodeId: string;
  rigId: string;
  rigName: string;
  logicalId: string;
  boundSession: string | null;
}

/** One cold-start attempt ledger row. */
export interface SeatColdStartLedgerRow {
  last_attempt_at: string;
  last_outcome: string;
  consecutive_failures: number;
  last_success_at: string | null;
}

export class SeatColdStarter {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: SeatColdStartDeps) {}

  /** Queue hook entry: a wake for `destinationSession` found no receiver. Fire-and-forget; never throws. */
  notify(destinationSession: string): void {
    try {
      const started = this.start(destinationSession);
      if (started) started.catch(() => { /* attempt() records its own failures */ });
    } catch (err) {
      this.log(`notify failed for ${destinationSession}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private log(line: string): void {
    (this.deps.log ?? ((msg: string) => console.log(msg)))(`[seat-cold-start] ${line}`);
  }

  /** Joins concurrent notifications for the same node into one launch attempt; undefined when the address is not a resolvable seat. */
  private start(destinationSession: string): Promise<void> | undefined {
    const parsed = parseSessionName(destinationSession);
    if (parsed.kind !== "canonical") return undefined;
    const seat = this.resolveSeat(parsed.member, parsed.rig, destinationSession);
    if (!seat) return undefined;
    const existing = this.inFlight.get(seat.nodeId);
    if (existing) return existing;
    const attempt = this.attempt(seat).finally(() => this.inFlight.delete(seat.nodeId));
    this.inFlight.set(seat.nodeId, attempt);
    return attempt;
  }

  /** Resolve a canonical destination address to exactly one seat row of one unarchived rig. */
  private resolveSeat(memberRef: string, rigName: string, destinationSession: string): SeatRow | null {
    const rows = this.deps.db.prepare(`SELECT n.id AS nodeId, n.rig_id AS rigId, r.name AS rigName, r.archived_at AS archivedAt,
        n.logical_id AS logicalId, b.tmux_session AS boundSession
      FROM nodes n JOIN rigs r ON r.id = n.rig_id LEFT JOIN bindings b ON b.node_id = n.id
      WHERE r.name = ?
        AND (n.logical_id = ? OR b.tmux_session = ?
          OR (replace(n.logical_id, '.', '-') || '@' || r.name = ?))`)
      .all(rigName, memberRef, destinationSession, destinationSession) as Array<SeatRow & { archivedAt: string | null }>;
    const eligible = rows.filter(row => row.archivedAt === null);
    // Exactly one seat may own the address; ambiguity is never launched into.
    return eligible.length === 1 ? eligible[0]! : null;
  }

  private currentTime(): Date {
    return (this.deps.now ?? ((): Date => new Date()))();
  }

  private async attempt(seat: SeatRow): Promise<void> {
    const now = this.currentTime();
    try {
      if (!await this.eligible(seat, now)) return;
      await this.deps.deliveryGuard.lifecycle([seat.nodeId], async () => {
        // No await between the final eligibility read and the launch door. The door joins
        // this same lease, so a supported stop cannot commit in its launch preflight.
        const current = this.resolveSeat(seat.logicalId, seat.rigName, seat.boundSession ?? `${seat.logicalId.replace(".", "-")}@${seat.rigName}`);
        if (!current || current.nodeId !== seat.nodeId || current.rigId !== seat.rigId
          || current.logicalId !== seat.logicalId || current.boundSession !== seat.boundSession) return;
        const refusal = this.selectionRefusal(current) ?? this.ledgerRefuses(seat.nodeId, this.currentTime());
        if (refusal) { this.log(`${seat.logicalId}: not cold-starting: ${refusal}`); return; }
        // Claim the attempt window BEFORE the (slow) launch. The in-memory join above covers
        // simultaneous arrivals; this row covers a second drain pass, a ladder retry, or a
        // restart mid-launch, so one dormant seat still gets exactly one launch per window.
        this.record(seat.nodeId, "launching", "in_flight", now.toISOString());
        const result = await this.deps.launchSingleNode(seat.rigId, seat.logicalId);
        const outcome = classifyColdStartLaunch(seat.logicalId, result);
        const success = outcome.kind === "resumed" || outcome.kind === "fresh_primed" || outcome.kind === "already_running";
        const label = outcome.kind === "failed" || outcome.kind === "awaiting_decision"
          ? `${outcome.kind}:${outcome.error}`
          : outcome.kind;
        this.record(seat.nodeId, label, success ? "succeeded" : "failed", this.currentTime().toISOString());
        this.log(`${seat.logicalId}: ${label}`);
      });
    } catch (err) {
      this.record(seat.nodeId, "failed:exception", "failed", this.currentTime().toISOString());
      this.log(`${seat.logicalId}: attempt threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Every maintainer-term gate; each refusal is a no-op (the queue keeps today's semantics). */
  private async eligible(seat: SeatRow, now: Date): Promise<boolean> {
    const refuse = (why: string): false => {
      this.log(`${seat.logicalId}: not cold-starting: ${why}`);
      return false;
    };
    const selection = this.selectionRefusal(seat);
    if (selection) return refuse(selection);

    // The queue said no receiver; verify — a live session means someone is there.
    const physical = seat.boundSession ?? `${seat.logicalId.replace(".", "-")}@${seat.rigName}`;
    try {
      if (await this.deps.hasSession(physical)) {
        this.deps.db.prepare("UPDATE seat_cold_starts SET consecutive_failures=0, last_success_at=?, last_outcome='observed_running' WHERE node_id=?")
          .run(now.toISOString(), seat.nodeId);
        return refuse("seat's tmux session is live");
      }
    } catch { /* an unprobeable session is not positive liveness; continue */ }

    const ledger = this.ledgerRefuses(seat.nodeId, now);
    if (ledger === "interval") return refuse("an attempt was made recently");
    if (ledger === "failures") return refuse("too many consecutive failed attempts");

    // The rig must be up: another seat of the same rig must be live in tmux. A down
    // rig keeps whole-rig restore semantics (the operator's/autoscaler's job).
    const peers = this.deps.db.prepare(`SELECT s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND n.id != ? AND s.status = 'running' ORDER BY s.id DESC LIMIT 5`)
      .all(seat.rigId, seat.nodeId) as Array<{ session_name: string }>;
    for (const peer of peers) {
      try { if (await this.deps.hasSession(peer.session_name)) return true; } catch { /* try the next peer */ }
    }
    return refuse("no other seat of this rig is live (rig down)");
  }

  private selectionRefusal(seat: SeatRow): string | null {
    // Opt-in: the seat must still be in its persisted rig spec with the flag set
    // (member wins over pod default). No recipe — pre-recipe seat, terminal node,
    // or a member removed from the spec (deleted seat) — never cold-starts.
    const recipe = this.deps.getNodeLaunchRecipe(seat.nodeId);
    const dot = seat.logicalId.indexOf(".");
    const podId = dot > 0 ? seat.logicalId.slice(0, dot) : seat.logicalId;
    const memberId = dot > 0 ? seat.logicalId.slice(dot + 1) : seat.logicalId;
    const specPod = recipe?.rigSpec.pods.find(pod => pod.id === podId);
    const specMember = specPod?.members.find(member => member.id === memberId);
    if (!recipe || !specMember) return "seat is not in the current rig spec";
    if (!((specMember.coldStart ?? specPod?.coldStart) === true)) return "no cold_start opt-in for this seat";

    // WHO stopped the seat decides whether new work may wake it (maintainer term 1).
    const stop = classifyColdStartStop(this.deps.db, seat.nodeId);
    if (stop.kind === "intentional") {
      return stop.operator
        ? `seat was stopped intentionally by '${stop.operator}'${stop.reason ? ` (${stop.reason})` : ""}`
        : "seat was stopped intentionally (no revivable daemon stop recorded)";
    }
    return null;
  }

  /** Durable ledger: the attempt window opens at launch, then records the outcome.
   *  `in_flight` leaves the failure count alone: a crash mid-launch is neither a launch nor
   *  a proven failure, and the interval alone already prevents a second launch in the window. */
  private record(nodeId: string, outcome: string, state: "in_flight" | "succeeded" | "failed", iso: string): void {
    const existing = this.deps.db.prepare("SELECT * FROM seat_cold_starts WHERE node_id = ?").get(nodeId) as SeatColdStartLedgerRow | undefined;
    const failures = state === "succeeded" ? 0
      : state === "failed" ? (existing?.consecutive_failures ?? 0) + 1
      : (existing?.consecutive_failures ?? 0);
    const success = state === "succeeded";
    if (existing) {
      this.deps.db.prepare("UPDATE seat_cold_starts SET last_attempt_at = ?, last_outcome = ?, consecutive_failures = ?, last_success_at = COALESCE(?, last_success_at) WHERE node_id = ?")
        .run(iso, outcome, failures, success ? iso : null, nodeId);
    } else {
      this.deps.db.prepare("INSERT INTO seat_cold_starts (node_id, last_attempt_at, last_outcome, consecutive_failures, last_success_at) VALUES (?, ?, ?, ?, ?)")
        .run(nodeId, iso, outcome, failures, success ? iso : null);
    }
  }

  /** Ledger gates: a too-recent attempt, or too many consecutive failures. */
  ledgerRefuses(nodeId: string, now: Date): "interval" | "failures" | null {
    const row = this.deps.db.prepare("SELECT * FROM seat_cold_starts WHERE node_id = ?").get(nodeId) as SeatColdStartLedgerRow | undefined;
    if (!row) return null;
    // Queue wakes may miss an operator's successful run entirely. A bounded quiet
    // window prevents that unobserved repair from leaving a permanent failure cap.
    if (Date.parse(row.last_attempt_at) + COLD_START_FAILURE_WINDOW_MS <= now.getTime()) {
      this.deps.db.prepare("UPDATE seat_cold_starts SET consecutive_failures=0 WHERE node_id=?").run(nodeId);
      return null;
    }
    if (row.consecutive_failures >= COLD_START_MAX_CONSECUTIVE_FAILURES) return "failures";
    if (Date.parse(row.last_attempt_at) + COLD_START_MIN_INTERVAL_MS > now.getTime()) return "interval";
    return null;
  }
}
