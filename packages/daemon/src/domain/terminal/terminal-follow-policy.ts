/** Presentation policy only. Membership and completeness come from A1; input
 * and provider identity observations come from the current viewer generation. */
export interface FollowPolicy {
  maxTiles: number;
  graceMs: number;
  focusRetentionMs: number;
  pins: string[];
  suppressed: Record<string, number>;
}
export interface FollowControls {
  enabled: boolean;
  maxTiles?: number;
  graceMs?: number;
  focusRetentionMs?: number;
  pin?: string[];
  unpin?: string[];
  suppress?: string[];
  unsuppress?: string[];
  suppressionMs?: number;
}
export interface FollowingStatus {
  id: string;
  enabled: boolean;
  state: "following" | "empty" | "retained" | "disabled";
  maxTiles: number;
  tiles: Array<FollowTile & { reason?: string }>;
  events: string[];
  overflow: FollowChange[];
  nextAt?: number;
}
export const DEFAULT_FOLLOW_POLICY: FollowPolicy = {
  maxTiles: 8, graceMs: 4000, focusRetentionMs: 12000, pins: [], suppressed: {},
};
export interface FollowTile {
  key: string;
  seat: string;
  departedAt?: number;
  focusRetainUntil?: number;
  inputRecheckAt?: number;
}
export interface FollowObservation {
  focused: boolean;
  input: "empty" | "text" | "unknown";
}
export interface FollowChange { key: string; seat: string; reason: string }
export interface FollowPlan {
  tiles: FollowTile[];
  joins: FollowChange[];
  leaves: FollowChange[];
  retained: FollowChange[];
  overflow: FollowChange[];
  nextAt?: number;
  state: "following" | "empty" | "retained";
}

/** Never treats a partial source or stale provider inventory as an empty task.
 * Every departure is a tile operation; this module has no seat lifecycle API. */
export function planFollowingTiles(
  previous: readonly FollowTile[],
  members: readonly { key: string; seat: string }[],
  complete: boolean,
  observations: ReadonlyMap<string, FollowObservation>,
  policy: FollowPolicy,
  now: number,
): FollowPlan {
  const result: FollowPlan = { tiles: [], joins: [], leaves: [], retained: [], overflow: [], state: "following" };
  if (!complete) return { ...result, tiles: previous.map(t => ({ ...t })), state: "retained",
    retained: previous.map(t => ({ ...t, reason: "Membership or provider identity is incomplete; keeping the previous view." })) };
  const desired = new Map(members.map(m => [m.key, m]));
  const pins = new Set(policy.pins);
  const capacityExempt = new Set(previous.filter(t => !desired.has(t.key) && observations.get(t.key)?.input !== "empty").map(t => t.key));
  const capacityUsed = () => result.tiles.filter(t => !capacityExempt.has(t.key)).length;
  const wake = (at: number) => { if (at > now && (result.nextAt === undefined || at < result.nextAt)) result.nextAt = at; };
  const suppressed = (key: string) => {
    const until = policy.suppressed[key] ?? 0;
    if (until > now) { wake(until); return true; }
    return false;
  };
  const retain = (tile: FollowTile, reason: string) => {
    result.tiles.push(tile); result.retained.push({ ...tile, reason });
  };
  // Preserve existing participants before allocating space to newcomers. A
  // retained draft or pin can exceed the cap; it must not be evicted to fit it.
  for (const old of previous) {
    const member = desired.get(old.key);
    if (suppressed(old.key)) {
      result.leaves.push({ ...old, reason: "Temporarily hidden by the viewer; the agent keeps running." });
      continue;
    }
    if (member) {
      const observation = observations.get(old.key);
      if (capacityUsed() >= policy.maxTiles && !pins.has(old.key)
        && observation?.input === "empty" && !observation.focused) {
        result.leaves.push({ ...old, reason: "Hidden by the view's tile limit; the agent keeps running." });
      } else result.tiles.push({ ...member });
      continue;
    }
    const tile = { ...old, departedAt: old.departedAt ?? now };
    if (pins.has(old.key)) { retain(tile, "Pinned; no longer a participant in this task."); continue; }
    const grace = tile.departedAt + policy.graceMs;
    if (now < grace) { retain(tile, "Left the task; keeping its tile for the departure grace period."); wake(grace); continue; }
    const observed = observations.get(old.key);
    if (!observed || observed.input !== "empty") {
      // Exactly one delayed check per departure, independent of global hook
      // activity. After it, keep unknown/draft input until a relevant lifecycle
      // event or explicit refresh; never create a recurring input poll.
      tile.inputRecheckAt ??= now + 30000;
      wake(tile.inputRecheckAt);
      retain(tile, observed?.input === "text" ? "Left the task; keeping its typed draft."
        : "Left the task; input is unconfirmed, so its tile is kept.");
      continue;
    }
    const focusUntil = Math.max(grace + policy.focusRetentionMs, tile.focusRetainUntil ?? 0);
    if (observed.focused && now < focusUntil) {
      retain(tile, "Left the task; keeping the focused tile briefly for reading."); wake(focusUntil); continue;
    }
    result.leaves.push({ ...old, reason: "No open obligation remains in this task; closing only its viewer tile." });
  }
  const shown = new Set(result.tiles.map(t => t.key));
  for (const member of members) {
    if (shown.has(member.key) || suppressed(member.key)) continue;
    if (capacityUsed() >= policy.maxTiles && !pins.has(member.key)) {
      result.overflow.push({ ...member, reason: `Not shown: the view's limit is ${policy.maxTiles} tiles. Raise maxTiles explicitly to show more.` });
      continue;
    }
    result.tiles.push({ ...member }); shown.add(member.key);
    result.joins.push({ ...member, reason: "Joined: owns an open obligation in this task." });
  }
  if (members.length === 0 && result.tiles.length === 0) result.state = "empty";
  return result;
}
