// Seats waiting on a person (a startup prompt, a sign-in, a held message), named where a command shows or reports
// them, so a held seat doesn't read as a view or kernel that failed for no reason (D#52). This reads the daemon's
// own attention flag and reason from the node route `rig ps --nodes` uses; it detects nothing itself.

import type { DaemonClient } from "./client.js";
import { attentionReason, type NodeEntry } from "./commands/ps.js";

export interface SeatAttention { seat: string; reason: string }

/** The given seats (session names, `member@rig`) whose node needs attention, with its reason. An unreadable daemon
 *  answer names nothing, and the caller's own output stands. */
export async function seatsNeedingAttention(client: DaemonClient, seats: readonly string[]): Promise<SeatAttention[]> {
  const byRig = new Map<string, Set<string>>();
  for (const seat of seats) {
    const at = seat.lastIndexOf("@");
    if (at <= 0 || at === seat.length - 1) continue;
    const rig = seat.slice(at + 1);
    if (!byRig.has(rig)) byRig.set(rig, new Set());
    byRig.get(rig)!.add(seat);
  }
  if (byRig.size === 0) return [];
  try {
    const rigs = await client.get<Array<{ rigId: string; rigName?: string; name?: string }>>("/api/ps");
    if (rigs.status >= 400 || !Array.isArray(rigs.data)) return [];
    const held: SeatAttention[] = [];
    for (const rig of rigs.data) {
      const wanted = byRig.get(rig.rigName ?? rig.name ?? "");
      if (!wanted) continue;
      const nodes = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
      if (nodes.status >= 400 || !Array.isArray(nodes.data)) continue;
      for (const node of nodes.data) {
        const seat = node.canonicalSessionName;
        if (node.needsAttention === true && seat && wanted.has(seat)) held.push({ seat, reason: attentionReason(node) });
      }
    }
    return held;
  } catch {
    return [];
  }
}

/** The kernel's seats that aren't ready and need attention. */
export async function kernelSeatsNeedingAttention(client: DaemonClient): Promise<SeatAttention[]> {
  try {
    const res = await client.get<{ agents?: Array<{ session_name?: string; startup_status?: string; down?: boolean }> }>("/api/kernel/status");
    if (res.status >= 400) return [];
    const unready = (res.data?.agents ?? [])
      .filter(agent => agent.startup_status !== "ready" || agent.down)
      .flatMap(agent => agent.session_name ? [agent.session_name] : []);
    return unready.length ? seatsNeedingAttention(client, unready) : [];
  } catch {
    return [];
  }
}
