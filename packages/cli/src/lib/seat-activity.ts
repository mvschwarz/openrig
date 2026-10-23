/** The activity fields a seat's inventory row carries, as the daemon serves them. */
export interface SeatActivityFields {
  agentActivity?: { state: string } | null;
  activityState?: { display: string; needsInput: { count: number } } | null;
  communityHarness?: unknown;
}

/** The activity word for a seat, shared by rig ps and the MCP team read. A seat the daemon knows nothing about is
 *  unknown, never idle. */
export function formatSeatActivity(n: SeatActivityFields): string {
  // S19 — render from the served taxonomy state when present: needs-input as
  // count(+reason), otherwise the bridge's display value. No local arbitration.
  const tax = n.activityState;
  if (tax) {
    if (tax.needsInput.count > 0) return `needs-input x${tax.needsInput.count}`;
    // A community harness has no needs-input source in that state, so its zero isn't a clearance: a prompt the
    // screen shows is kept.
    if (n.communityHarness && n.agentActivity?.state === "needs_input") return "needs-input (screen)";
    return tax.display;
  }
  // Legacy fallback (a daemon without the S19 enrichment) — retires with the
  // pre-taxonomy surfaces per the ladder-as-migration rule.
  const activity = n.agentActivity;
  if (!activity) return "unknown";
  if (activity.state === "running") return "running";
  if (activity.state === "needs_input") return "needs_input";
  if (activity.state === "idle") return "idle";
  return "unknown";
}
