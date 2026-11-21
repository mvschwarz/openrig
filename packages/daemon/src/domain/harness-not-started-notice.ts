import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { resolveEscalationOwner, resolveEscalationOwnerOfNode } from "./escalation-owner.js";
import { OPENRIG_SENDER } from "../lib/pane-envelope.js";
import type { QueueRepository } from "./queue-repository.js";

/** What a launch or restore attempt did about the seats it positively left with no agent running: bare shells (no harness
 *  started), and seats whose failed resume was rolled back. */
export interface HarnessNotStartedReport {
  /** One durable notice per resolved owner, keyed by the attempt. Its seats are the ones the stored notice names. */
  notices: Array<{ owner: string; qitemId: string; seats: string[] }>;
  /** Seats with no single destination: kept here with the routing fact, never sent to a guessed recipient. */
  unrouted: Array<{ seat: string; outcome: string; reason: string }>;
  /** A notice that wasn't recorded, or a stored one that names other seats than this run found. Nothing else changes. */
  warnings: string[];
}

/** The seat's newest session name: the shell this attempt registered for it. Picked by id, as node inventory picks a
 *  seat's current session: ids are monotonic, and created_at is the clock's, to the second. */
function seatSession(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
    .get(nodeId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}

/** A seat with no recorded session (a rolled-back resume can remove the only one a recreated seat had): its canonical
 *  address, `<pod>-<member>@<rig>`, as the owner resolver's own topology read spells it. */
function seatAddress(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT replace(n.logical_id, '.', '-') || '@' || r.name AS address FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?")
    .get(nodeId) as { address: string } | undefined;
  return row?.address ?? null;
}

/** The seats a stored notice names: its `- <seat>` lines. */
function noticeSeats(body: string): string[] {
  return body.split("\n").flatMap((line) => /^- ([^:]+)(?:: |$)/.exec(line)?.[1] ?? []).sort();
}

/**
 * Tells each seat's escalation owner, once per attempt, which seats an attempt left with no agent running: as bare shells,
 * or rolled back after a failed resume (`rolledBack`), each kind with its own lines. Grouped by the owner
 * `resolveEscalationOwner` actually resolves (a declared delegation parent or escalation destination). A seat with no
 * single destination stays in the report with that outcome and its reason, and nothing is sent for it. One owner's
 * failure is a warning, and the other owners still get theirs. Nothing here stops, relaunches, gates or waits: the
 * restore's own result is unchanged.
 */
export async function noticeHarnessNotStarted(
  db: Database.Database,
  queue: Pick<QueueRepository, "create">,
  input: { rigId: string; attempt: string; seats: Array<{ nodeId: string; logicalId: string; cause?: string; rolledBack?: true }> },
): Promise<HarnessNotStartedReport> {
  const report: HarnessNotStartedReport = { notices: [], unrouted: [], warnings: [] };
  const byOwner = new Map<string, string[]>();
  const causes = new Map<string, string>();
  const rolledBack = new Set<string>();
  for (const seat of input.seats) {
    // A seat with no session left is named by its address, and its owner is read from its node.
    const recorded = seatSession(db, seat.nodeId);
    const session = recorded ?? seatAddress(db, seat.nodeId);
    if (!session) {
      report.unrouted.push({ seat: seat.logicalId, outcome: "none", reason: "no recorded session for this seat" });
      continue;
    }
    if (seat.cause) causes.set(session, seat.cause);
    if (seat.rolledBack) rolledBack.add(session);
    const route = recorded ? resolveEscalationOwner(db, session) : resolveEscalationOwnerOfNode(db, seat.nodeId, session);
    if (route.owner && (route.outcome === "parent" || route.outcome === "routed")) {
      byOwner.set(route.owner, [...(byOwner.get(route.owner) ?? []), session]);
    } else {
      report.unrouted.push({ seat: session, outcome: route.outcome, reason: route.reason });
    }
  }
  const rig = (db.prepare("SELECT name FROM rigs WHERE id = ?").get(input.rigId) as { name: string } | undefined)?.name ?? input.rigId;
  for (const [owner, seats] of byOwner) {
    const key = createHash("sha256").update(`${input.rigId}\0${input.attempt}\0${owner}`).digest("hex").slice(0, 16);
    const qitemId = `qitem-harness-not-started-${key}`;
    const list = [...seats].sort();
    const shells = list.filter((seat) => !rolledBack.has(seat));
    const rolled = list.filter((seat) => rolledBack.has(seat));
    const line = (seat: string) => `- ${seat}${causes.has(seat) ? `: ${causes.get(seat)}` : ""}`;
    const shellLines = shells.length === 0 ? [] : [
      `${input.attempt} left these seats as a bare shell, with no harness started. Each pane is kept, nothing was relaunched, and`,
      "`rig ps --nodes --summary` lists them under bareShell. Each line gives the seat's own cause:",
      ...shells.map(line),
      "",
      `A plain \`rig launch\` won't start an agent in these shells, so fix the cause first. \`rig restore-check --rig ${rig}\` names`,
      `the fix for each seat, and \`rig up ${rig} --existing --plan\` previews bringing the rig up without doing it. Then, where a`,
      "snapshot can resume a seat, stop it and launch it from that snapshot to resume its conversation. Otherwise an explicitly",
      "fresh launch starts it without its original conversation.",
    ];
    const rolledLines = rolled.length === 0 ? [] : [
      `${input.attempt} couldn't resume these seats' conversations. The blank session it launched for each was rolled back, so no`,
      "agent is running in them, and nothing was relaunched. Each line gives the seat's own cause and how to start it:",
      ...rolled.map(line),
      "",
      "OpenRig's records can't tell a seat that was never used from one whose conversation is elsewhere (a moved account or",
      `folder). Restore the original conversation if you know where it is; \`rig restore-check --rig ${rig}\` names the fix for`,
      "each seat. Otherwise the fresh launch in its line starts it without its original conversation.",
    ];
    const summary = rolled.length === 0
      ? `${list.length} seat${list.length === 1 ? "" : "s"} left as a bare shell: no harness started (${input.attempt})`
      : shells.length === 0
        ? `${list.length} seat${list.length === 1 ? "" : "s"} with no agent running: resume rolled back (${input.attempt})`
        : `${list.length} seats with no agent running: ${shells.length} bare shell${shells.length === 1 ? "" : "s"}, ${rolled.length} resume${rolled.length === 1 ? "" : "s"} rolled back (${input.attempt})`;
    try {
      // The same attempt's notice to this owner has one ID, and the queue returns a stored row for it unchanged, with no
      // second row or wake. So the report names the seats the stored notice names.
      const stored = await queue.create({
        qitemId,
        sourceSession: OPENRIG_SENDER,
        destinationSession: owner,
        wakeTrigger: "openrig",
        summary,
        body: [...shellLines, ...(shellLines.length && rolledLines.length ? [""] : []), ...rolledLines].join("\n"),
        tags: ["harness-not-started", `rig:${input.rigId}`],
      });
      const named = noticeSeats(stored.body);
      report.notices.push({ owner, qitemId, seats: named });
      if (stored.createWarning || named.join("\n") !== list.join("\n")) {
        report.warnings.push(`The notice ${qitemId} to ${owner} already existed for ${input.attempt} and wasn't changed. `
          + `It names ${named.join(", ") || "no seats"}, and this run found ${list.join(", ")}.`);
      }
    } catch (err) {
      report.warnings.push(`The notice to ${owner} for ${list.join(", ")} wasn't recorded (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  return report;
}
