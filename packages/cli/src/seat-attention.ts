// Seats that need attention, named where a command shows or reports them, so a held seat doesn't read as a view or
// kernel that failed for no reason (D#52). This reads the daemon's own attention flag and recorded reason from the
// node route `rig ps --nodes` uses; it detects nothing itself. A check that couldn't be made is reported as unknown,
// never as "nothing needs attention".

import type { DaemonClient } from "./client.js";
import { attentionReason, questionReason, servesQuestion, type NodeEntry } from "./commands/ps.js";

export interface SeatAttention {
  seat: string;
  reason: string;
  /** The daemon serves a live question for this seat (needs-input), so a person can answer it there. Otherwise the
   *  flag is broader: a failed or gated startup, a recorded error, a held message or a missing required file. */
  waitingOnPerson: boolean;
}

export interface AttentionCheck {
  attention: SeatAttention[];
  /** Seats whose attention couldn't be read, and why. */
  unknown: Array<{ seat: string; why: string }>;
}

function failure(res: { status: number; data?: unknown }): string {
  const error = (res.data as { error?: unknown } | null | undefined)?.error;
  return `HTTP ${res.status}${typeof error === "string" && error ? `: ${error}` : ""}`;
}

/** The given local seats (session names, `member@rig`) checked against the daemon's node inventory. A rig whose read
 *  fails leaves its seats unknown and keeps the other rigs' answers. */
export async function checkSeatAttention(client: DaemonClient, seats: readonly string[]): Promise<AttentionCheck> {
  const check: AttentionCheck = { attention: [], unknown: [] };
  const byRig = new Map<string, Set<string>>();
  for (const seat of seats) {
    const at = seat.indexOf("@");
    if (at <= 0 || at === seat.length - 1) { check.unknown.push({ seat, why: "not a seat@rig name" }); continue; }
    const rig = seat.slice(at + 1);
    if (!byRig.has(rig)) byRig.set(rig, new Set());
    byRig.get(rig)!.add(seat);
  }
  if (byRig.size === 0) return check;
  const unknownAll = (why: string) => { for (const wanted of byRig.values()) for (const seat of wanted) check.unknown.push({ seat, why }); };
  let rigs: Array<{ rigId: string; rigName?: string; name?: string }>;
  try {
    const res = await client.get<Array<{ rigId: string; rigName?: string; name?: string }>>("/api/ps");
    if (res.status >= 400 || !Array.isArray(res.data)) { unknownAll(`the rig list couldn't be read (${failure(res)})`); return check; }
    rigs = res.data;
  } catch (err) {
    unknownAll(`the rig list couldn't be read (${err instanceof Error ? err.message : String(err)})`);
    return check;
  }
  for (const [rigName, wanted] of byRig) {
    const matches = rigs.filter(rig => (rig.rigName ?? rig.name) === rigName);
    if (matches.length === 0) { for (const seat of wanted) check.unknown.push({ seat, why: `no rig named ${rigName} on this daemon` }); continue; }
    const found = new Set<string>();
    const failures: string[] = [];
    for (const rig of matches) {
      let nodes: NodeEntry[];
      try {
        const res = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
        if (res.status >= 400 || !Array.isArray(res.data)) { failures.push(`${rigName}'s seats couldn't be read (${failure(res)})`); continue; }
        nodes = res.data;
      } catch (err) {
        failures.push(`${rigName}'s seats couldn't be read (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      for (const node of nodes) {
        const seat = node.canonicalSessionName;
        if (!seat || !wanted.has(seat) || found.has(seat)) continue;
        found.add(seat);
        if (node.needsAttention === undefined) { check.unknown.push({ seat, why: "the daemon served no attention evidence for it" }); continue; }
        if (!node.needsAttention) continue;
        const question = servesQuestion(node);
        // A live question names its own reason. An older recorded error would describe something else.
        check.attention.push({ seat, reason: question ? questionReason(node) ?? "reason unavailable" : attentionReason(node), waitingOnPerson: question });
      }
    }
    for (const seat of wanted) {
      if (!found.has(seat)) check.unknown.push({ seat, why: failures[0] ?? `not in ${rigName}'s seats on this daemon` });
    }
  }
  return check;
}

/** The kernel's seats that aren't ready, checked the same way. */
export async function checkKernelAttention(client: DaemonClient): Promise<AttentionCheck> {
  try {
    const res = await client.get<{ agents?: Array<{ session_name?: string; startup_status?: string; down?: boolean }> }>("/api/kernel/status");
    if (res.status >= 400) return { attention: [], unknown: [{ seat: "kernel", why: `the kernel status couldn't be read (${failure(res)})` }] };
    const unready = (res.data?.agents ?? [])
      .filter(agent => agent.startup_status !== "ready" || agent.down)
      .flatMap(agent => agent.session_name ? [agent.session_name] : []);
    return unready.length ? checkSeatAttention(client, unready) : { attention: [], unknown: [] };
  } catch (err) {
    return { attention: [], unknown: [{ seat: "kernel", why: `the kernel status couldn't be read (${err instanceof Error ? err.message : String(err)})` }] };
  }
}

/** One line per seat that needs attention, then one line per reason a check couldn't be made. */
export function attentionLines(check: AttentionCheck, where: "tile" | "pane"): string[] {
  const lines = check.attention.map(({ seat, reason, waitingOnPerson }) => waitingOnPerson
    ? `${seat} is waiting on a person: ${reason}. Answer it in its ${where === "tile" ? "tile" : "terminal"}, or read it with: rig capture ${seat}`
    : `${seat} needs attention: ${reason}. Look at it ${where === "tile" ? "in its tile " : ""}with: rig capture ${seat}`);
  const byWhy = new Map<string, string[]>();
  for (const { seat, why } of check.unknown) byWhy.set(why, [...(byWhy.get(why) ?? []), seat]);
  for (const [why, seats] of byWhy) {
    const named = seats.length > 5 ? `${seats.slice(0, 5).join(", ")} and ${seats.length - 5} more` : seats.join(", ");
    lines.push(`Couldn't check whether ${named} ${seats.length === 1 ? "needs" : "need"} attention: ${why}.`);
  }
  return lines;
}
