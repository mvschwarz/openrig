/**
 * Hot-potato strict-rejection contract (PL-004 Phase A).
 *
 * Load-bearing API contract: any code path that transitions a queue_item to
 * `done` MUST pass a valid `closure_reason` from the 6-value enum below. This
 * is enforced at this layer (NOT at the route, NOT at the CLI) so every
 * surface that reaches the queue inherits the same guarantee.
 *
 * The 6 valid closure reasons:
 *   - handed_off_to  : work continues with a different seat (closure_target = new owner)
 *   - blocked_on     : work is parked pending another qitem (closure_target = blocker qitem_id)
 *   - denied         : receiver rejected the work (closure_target = reason text)
 *   - canceled       : sender or receiver withdrew (closure_target = note)
 *   - no-follow-on   : terminal completion, nothing else needed
 *   - escalation     : kicked up to higher tier (closure_target = escalation target)
 */

export const CLOSURE_REASONS = [
  "handed_off_to",
  "blocked_on",
  "denied",
  "canceled",
  "no-follow-on",
  "escalation",
] as const;

export type ClosureReason = (typeof CLOSURE_REASONS)[number];

export interface ClosureRequest {
  state: string;
  closureReason?: string | null;
  closureTarget?: string | null;
}

export interface ClosureValidationOk {
  ok: true;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
}

export interface ClosureValidationErr {
  ok: false;
  code: "missing_closure_reason" | "invalid_closure_reason" | "missing_closure_target";
  message: string;
  validReasons?: readonly string[];
}

export type ClosureValidation = ClosureValidationOk | ClosureValidationErr;

/**
 * Validate a state transition's closure obligation.
 * - If state !== "done": no closure_reason required; pass through any provided values.
 * - If state === "done": closure_reason REQUIRED, must be in CLOSURE_REASONS.
 *   handed_off_to / blocked_on / escalation also require closure_target.
 */
export function validateClosure(req: ClosureRequest): ClosureValidation {
  if (req.state !== "done") {
    return {
      ok: true,
      closureReason: (req.closureReason ?? null) as ClosureReason | null,
      closureTarget: req.closureTarget ?? null,
    };
  }

  if (!req.closureReason) {
    return {
      ok: false,
      code: "missing_closure_reason",
      message: `state=done requires closure_reason; valid values: ${CLOSURE_REASONS.join(", ")}`,
      validReasons: CLOSURE_REASONS,
    };
  }

  if (!isClosureReason(req.closureReason)) {
    return {
      ok: false,
      code: "invalid_closure_reason",
      message: `closure_reason=${req.closureReason} is not valid; valid values: ${CLOSURE_REASONS.join(", ")}`,
      validReasons: CLOSURE_REASONS,
    };
  }

  const requiresTarget = req.closureReason === "handed_off_to"
    || req.closureReason === "blocked_on"
    || req.closureReason === "escalation";

  if (requiresTarget && !req.closureTarget) {
    return {
      ok: false,
      code: "missing_closure_target",
      message: `closure_reason=${req.closureReason} requires closure_target`,
    };
  }

  return {
    ok: true,
    closureReason: req.closureReason,
    closureTarget: req.closureTarget ?? null,
  };
}

export function isClosureReason(value: unknown): value is ClosureReason {
  return typeof value === "string" && (CLOSURE_REASONS as readonly string[]).includes(value);
}

/**
 * Compute closure_required_at given a claim time and a tier.
 * Tier policies are intentionally simple in Phase A; the structure exists so
 * Phase B/C can swap in operator-tunable SLAs without a contract change.
 */
const TIER_SLA_SECONDS: Record<string, number> = {
  fast: 30 * 60,
  routine: 4 * 60 * 60,
  deep: 24 * 60 * 60,
  critical: 15 * 60,
};

export function computeClosureRequiredAt(claimedAt: string, tier: string | null): string | null {
  if (!tier) return null;
  const slaSeconds = TIER_SLA_SECONDS[tier];
  if (slaSeconds === undefined) return null;
  const claimed = new Date(claimedAt).getTime();
  return new Date(claimed + slaSeconds * 1000).toISOString();
}
