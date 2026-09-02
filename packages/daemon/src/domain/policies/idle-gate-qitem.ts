// OPR.0.4.3.16 — idle-gate-qitem watchdog policy.
//
// The PRE-claim stall: a gate qitem (guard code-review / spec-review /
// human-gate / ...) lands CLAIMABLE on a seat that then goes idle and
// silently sits. The existing overdue watchdog only catches ALREADY-CLAIMED
// work past its closure deadline (queue-repository.findOverdue → state
// 'in-progress'), so a pending/claimable gate never trips it.
//
// This policy (modeled on workflow-keepalive) joins two INDEPENDENTLY
// sourced signals into ONE bounded, audited wake:
//   A. a pending/claimable qitem addressed to seat X carrying a gate:* tag
//      (predicate centralized in domain/gate-predicate.ts), and
//   B. X is idle according to the shared arbitrated SeatActivityService
//      oracle. Unknown is NEVER treated as idle, and needs-input remains a
//      separate axis that also suppresses the wake.
// Cooldown is FREE via the engine's active-wake throttle (configure
// active_wake_interval_seconds on the registered job). It WAKES ONLY — it
// never claims or acts on the gate.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { effectiveGateRoles } from "../gate-predicate.js";
import type { SeatActivityService } from "../seat-activity-service.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

export interface IdleGateQitemDeps {
  db: Database.Database;
  /**
   * Consume the same arbitrated activity oracle as the public surfaces. Only
   * `getSeatStateBySession` is used; typed as a Pick so unit tests can inject
   * a lightweight seam without constructing a second oracle.
   */
  seatActivity: Pick<SeatActivityService, "getSeatStateBySession">;
}

interface PendingGateRow {
  qitem_id: string;
  tags: string | null;
  tier: string | null;
}

function parseTags(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]) : null;
  } catch {
    return null;
  }
}

export function makeIdleGateQitemPolicy(deps: IdleGateQitemDeps): Policy {
  const { db, seatActivity } = deps;

  return {
    name: "idle-gate-qitem",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const seat = job.target.session;

      // Signal A — pending/claimable GATE qitems addressed to this seat.
      // Claimable = state IN ('pending','blocked') per the queue claim
      // contract. A claimed/closed/canceled/handed-off qitem is not in
      // these states, so it is excluded BY CONSTRUCTION → never fires
      // (AC: not-claimable → no wake).
      const rows = db
        .prepare(
          `SELECT qitem_id, tags, tier FROM queue_items
             WHERE destination_session = ? AND state IN ('pending','blocked')
             ORDER BY ts_created ASC`,
        )
        .all(seat) as PendingGateRow[];
      const gated = rows
        .map((r) => ({
          qitemId: r.qitem_id,
          roles: effectiveGateRoles({ tags: parseTags(r.tags), tier: r.tier }),
        }))
        .filter((r) => r.roles.length > 0);
      if (gated.length === 0) {
        return { action: "skip", reason: "no_pending_gate" };
      }

      // Signal B — the shared arbitrated activity verdict. This is the same
      // oracle rendered by public surfaces; raw hook detail is evidence for
      // that oracle and must never independently decide a wake.
      const activity = seatActivity.getSeatStateBySession(seat);
      if (!activity || activity.activity === "unknown") {
        return {
          action: "skip",
          reason: "activity_stale_unknown",
          notes: {
            seat,
            activityState: activity?.activity ?? null,
            activityReason: activity ? "oracle_unknown" : "no_activity_signal",
          },
        };
      }
      if (activity.needsInput.count > 0) {
        // A live picker / approval prompt — never drive it with a wake.
        return {
          action: "skip",
          reason: "seat_needs_input",
          notes: { seat, activityReason: activity.needsInput.reason },
        };
      }
      if (activity.activity !== "idle-at-prompt") {
        return { action: "skip", reason: "seat_active", notes: { seat, activityState: activity.activity } };
      }

      // Signal C — OPR.0.5.8.1 S2. Fire once per MATERIAL STATE of the gated
      // set, not once per window and not once per idle episode.
      //
      // The engine's active-wake window was the only cooldown, and it is not
      // one: `watchdog-policy-engine.ts` clears `actionable` on EVERY skip, and
      // the throttle's precondition includes `job.actionable`. So a seat that
      // went briefly active between scans re-opened immediate firing —
      // reproduced at 60.1s into a 120s window. Window expiry alone also
      // re-woke an unchanged row every interval.
      //
      // The memory keys to the CONDITION, never to seat activity: a skip for
      // seat_active / needs_input / activity_stale returns above WITHOUT
      // touching it, so a flicker can no longer manufacture a fresh wake.
      const fingerprint = gatedConditionFingerprint(db, gated.map((g) => g.qitemId));
      const firedFor = (
        db.prepare("SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?")
          .get(job.jobId) as { c: string | null } | undefined
      )?.c ?? null;
      if (firedFor !== null && firedFor === fingerprint) {
        return {
          action: "skip",
          reason: "gate_condition_unchanged",
          notes: { seat, pendingGateCount: gated.length },
        };
      }

      // Both signals joined → ONE bounded wake (single-target, keepalive shape).
      //
      // The fingerprint is PROPOSED here and persisted by the engine only if
      // delivery succeeds. It is deliberately NOT written at this point.
      //
      // The first cut of this repair did write it here, justified as mirroring
      // how the engine stamps `last_fire_at` on the send path regardless of
      // delivery outcome. That mirrored the timing and inverted the consequence:
      // `last_fire_at` gates a window that EXPIRES, so a failed delivery
      // self-heals, while this gate holds until the gated set materially
      // changes. dev50-qa reproduced the result — a send that failed transport
      // still recorded the receipt, and the seat was never woken again until an
      // unrelated transition released it. Suppression must rest on evidence the
      // wake ARRIVED, never on the decision to attempt one.
      const primary = gated[0]!;
      const message =
        job.message ??
        buildIdleGateMessage({ seat, qitemId: primary.qitemId, roles: primary.roles, pendingCount: gated.length });

      return {
        action: "send",
        target: { session: seat },
        message,
        conditionReceipt: fingerprint,
        notes: {
          // Audit: which qitem + which activity signal + the join decision.
          qitemId: primary.qitemId,
          gateRoles: primary.roles,
          pendingGateCount: gated.length,
          otherPendingGateQitems: gated.slice(1).map((g) => g.qitemId),
          activityState: activity.activity,
          activityNeedsInput: activity.needsInput,
          activityDecidedBy: activity.decidedBy,
          activityChangedAt: activity.changedAt,
        },
      };
    },
  };
}

/**
 * Wake-machinery markers are NEVER material. If they were, every wake would
 * justify the next one and the gate would be decorative.
 */
const WAKE_MACHINERY_NOTE_PREFIXES = [
  "wake-attempt:",
  "escalation-rung:",
  "ladder-exhausted:",
  "ladder-suspend:",
  "ladder-resume:",
  "park wake fired:",
  "idle-gate:",
];

/**
 * A stable digest of the gated condition: which rows qualify, and the material
 * state of each.
 *
 * Material state per the ruled definition — a substantive transition on the row
 * (state / claim / content-bearing note / resolution), a transition on its
 * blocker or the blocker reaching terminal, and pickup evidence. Row identity
 * alone is not enough: the same two rows can be in different states.
 *
 * Derived entirely from existing queue facts. Nothing new is recorded per wake;
 * the only stored value is the single overwritten fingerprint on the job.
 */
function gatedConditionFingerprint(db: Database.Database, qitemIds: readonly string[]): string {
  const notMachinery = WAKE_MACHINERY_NOTE_PREFIXES.map(() => "COALESCE(t.transition_note,'') NOT LIKE ?").join(" AND ");
  const latestSubstantive = db.prepare(
    `SELECT MAX(t.transition_id) AS marker
       FROM queue_transitions t
      WHERE t.qitem_id = ? AND ${notMachinery}`,
  );
  const rowFacts = db.prepare(
    `SELECT q.state AS state, COALESCE(q.blocked_on,'') AS blockedOn,
            COALESCE(q.claimed_at,'') AS claimedAt,
            COALESCE((SELECT b.state FROM queue_items b WHERE b.qitem_id = q.blocked_on),'') AS blockerState
       FROM queue_items q WHERE q.qitem_id = ?`,
  );
  const likeArgs = WAKE_MACHINERY_NOTE_PREFIXES.map((p) => `${p}%`);
  const parts = [...qitemIds].sort().map((id) => {
    const f = rowFacts.get(id) as
      | { state: string; blockedOn: string; claimedAt: string; blockerState: string }
      | undefined;
    const marker = (latestSubstantive.get(id, ...likeArgs) as { marker: number | null } | undefined)?.marker ?? 0;
    // The blocker contributes TWO independent axes, not one. Its terminal state
    // is carried by `blockerState`; a SUBSTANTIVE TRANSITION on it that leaves
    // that state unchanged is a separate material event and needs its own marker.
    // Omitting it meant a blocker note like "decision context materially amended"
    // on a still-in-progress blocker produced an identical digest and was
    // suppressed (review50-r2, reproduced against this exact policy). The same
    // wake-machinery exclusion applies, so a wake recorded on the blocker cannot
    // justify the next wake either.
    const blockerMarker =
      f?.blockedOn
        ? (latestSubstantive.get(f.blockedOn, ...likeArgs) as { marker: number | null } | undefined)?.marker ?? 0
        : 0;
    return [
      id,
      f?.state ?? "",
      f?.blockedOn ?? "",
      f?.blockerState ?? "",
      blockerMarker,
      f?.claimedAt ?? "",
      marker,
    ].join("|");
  });
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

function buildIdleGateMessage(input: {
  seat: string;
  qitemId: string;
  roles: string[];
  pendingCount: number;
}): string {
  const rolesLabel = input.roles.map((r) => `gate:${r}`).join(", ");
  const lines = [
    `Idle-seat gate reminder: you (${input.seat}) have a pending gate qitem ${input.qitemId} (${rolesLabel}) awaiting your review/decision, and your seat is idle.`,
    "Claim + act on it, or hand it off if it is not yours. This is a WAKE ONLY — the gate has NOT been claimed or acted on for you.",
  ];
  if (input.pendingCount > 1) {
    lines.push("", `(${input.pendingCount} pending gate qitems total for this seat.)`);
  }
  return lines.join("\n");
}
