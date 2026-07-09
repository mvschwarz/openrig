/**
 * OPR.0.4.6.WF3 FR-5 — what/why/fix rendering for the named daemon
 * rejections (the house 3-part shape; clig.dev's rewrite-for-humans
 * rule). HUMAN MODE ONLY: `--json` preserves the RAW daemon body
 * byte-identically so scripts keep the stable error codes; exit codes
 * are untouched (1=4xx / 2=5xx, plus FR-1's outcome codes).
 *
 * Unrecognized error bodies fall back to the raw JSON render — this
 * module only rewrites what it genuinely understands.
 */

export interface ThreePartRejection {
  fact: string;
  consequence: string;
  action: string;
}

interface RejectionBody {
  error?: string;
  message?: string;
  instanceId?: string;
  expectedVersion?: number;
  actualVersion?: number;
  allowedExits?: string[];
  [key: string]: unknown;
}

/**
 * Map a recognized daemon rejection to the 3-part shape, or null when
 * the body is not a named rejection (caller falls back to raw JSON).
 */
export function describeDaemonRejection(body: unknown, instanceHint?: string): ThreePartRejection | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as RejectionBody;
  if (typeof b.error !== "string") return null;
  const instance = typeof b.instanceId === "string" ? b.instanceId : instanceHint;
  const traceCmd = instance ? `rig workflow trace ${instance}` : "rig workflow trace <instance>";
  const showCmd = instance ? `rig workflow show ${instance}` : "rig workflow show <instance>";

  switch (b.error) {
    case "packet_not_on_frontier":
      return {
        fact: `That packet is not on the instance frontier${b.message ? ` (${b.message})` : ""}.`,
        consequence:
          "The step it belonged to was already closed, replayed, or re-routed — the frontier has moved past it, so this close cannot apply.",
        action: `See where the instance actually is: ${traceCmd}`,
      };
    case "instance_not_active": {
      const state = typeof b.message === "string" && b.message.length > 0 ? b.message : "not active";
      return {
        fact: `The instance is ${state}.`,
        consequence: "Only an active instance can advance; terminal and waiting states reject projection.",
        // OPR.0.4.6.WF5 FR-4: the promised pointer upgrade — resume is
        // real now. A FAILED instance redrives; other terminal states
        // still inspect-first.
        action: `If it is failed, redrive it: rig workflow resume <instanceId> --actor-session <you>. Otherwise inspect: ${showCmd}`,
      };
    }
    case "instance_not_failed":
      return {
        fact: "The instance is not in the failed state.",
        consequence: "resume re-drives FAILED instances only — an active instance needs no resume, and a waiting instance continues via its preserved frontier packet (project), not a redrive.",
        action: `See the real state first: ${showCmd}`,
      };
    case "resume_step_unrecoverable":
      return {
        fact: "The instance carries no recorded failed step to rebind to.",
        consequence: "This is a pre-R2 row without a durable step binding; a redrive has no anchor.",
        action: "Instantiate a fresh run of the workflow (the trail of this instance remains for the record).",
      };
    case "resume_step_missing_from_spec":
      return {
        fact: "The failed step no longer exists in the cached workflow spec.",
        consequence: "The spec drifted after this instance failed; rebinding would route a step the workflow no longer declares.",
        action: "Restore the step in the spec (re-validate to refresh the cache) or instantiate a fresh run.",
      };
    case "instance_version_conflict":
      return {
        fact: `A concurrent writer advanced the instance first (expected version ${b.expectedVersion ?? "?"}, actual ${b.actualVersion ?? "?"}).`,
        consequence: "This projection was rolled back whole; no partial state was written.",
        action: `Re-read the current state (${traceCmd}), then retry against it.`,
      };
    case "exit_not_allowed": {
      const allowed = Array.isArray(b.allowedExits) && b.allowedExits.length > 0 ? b.allowedExits.join(" | ") : null;
      return {
        fact: `That exit is not allowed for this step${b.message ? ` (${b.message})` : ""}.`,
        consequence: "The step declares which exits it accepts; the daemon rejected the close before any state changed.",
        action: allowed ? `Use one of: ${allowed}.` : `Check the step's allowed exits in the spec, then re-close: ${traceCmd}`,
      };
    }
    case "no_next_step":
      return {
        fact: `The workflow has no next step for that exit${b.message ? ` (${b.message})` : ""}.`,
        consequence: "The handoff had nowhere to route; the close was rejected whole.",
        action: `Check the spec's routing for this step, or close terminally (--exit done | failed). Inspect: ${traceCmd}`,
      };
    case "next_owner_unresolved":
      return {
        fact: `The next step's owner could not be resolved${b.message ? ` (${b.message})` : ""}.`,
        consequence: "A projected packet needs a destination seat; nothing was routed.",
        action: "Pass --next-owner <session>, or fix the step's suggested_roles in the spec.",
      };
    case "instance_not_found":
      return {
        fact: `No such workflow instance${instance ? `: ${instance}` : ""}.`,
        consequence: "Nothing was read or changed.",
        action: "List instances: rig workflow list",
      };
    default:
      return null;
  }
}

/** Render the 3-part shape as stderr lines (the emit3PartError shape). */
export function formatThreePart(rej: ThreePartRejection): string[] {
  return [`Error: ${rej.fact}`, rej.consequence, rej.action];
}
