import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { resolveEscalationOwner } from "./escalation-owner.js";
import { OPENRIG_SENDER } from "../lib/pane-envelope.js";
import type { QueueRepository } from "./queue-repository.js";

/** What a launch or restore attempt did about the seats it positively left as bare shells (no harness started). */
export interface HarnessNotStartedReport {
  /** One durable notice per resolved owner, keyed by the attempt. Its seats are the ones the stored notice names. */
  notices: Array<{ owner: string; qitemId: string; seats: string[] }>;
  /** Seats with no single destination: kept here with the routing fact, never sent to a guessed recipient. */
  unrouted: Array<{ seat: string; outcome: string; reason: string }>;
  /** A notice that wasn't recorded, or a stored one that names other seats than this run found. Nothing else changes. */
  warnings: string[];
}

/** The seat's newest session name: the shell this attempt registered for it. */
function seatSession(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}

/** The seats a stored notice names: its `- <seat>` lines. */
function noticeSeats(body: string): string[] {
  return body.split("\n").flatMap((line) => /^- ([^\s:]+)/.exec(line)?.[1] ?? []).sort();
}

/**
 * Tells each seat's escalation owner, once per attempt, which seats an attempt left as bare shells. Grouped by the owner
 * `resolveEscalationOwner` actually resolves (a declared delegation parent or escalation destination). A seat with no
 * single destination stays in the report with that outcome and its reason, and nothing is sent for it. One owner's
 * failure is a warning, and the other owners still get theirs. Nothing here stops, relaunches, gates or waits: the
 * restore's own result is unchanged.
 */
export async function noticeHarnessNotStarted(
  db: Database.Database,
  queue: Pick<QueueRepository, "create">,
  input: { rigId: string; attempt: string; seats: Array<{ nodeId: string; logicalId: string; cause?: string }> },
): Promise<HarnessNotStartedReport> {
  const report: HarnessNotStartedReport = { notices: [], unrouted: [], warnings: [] };
  const byOwner = new Map<string, string[]>();
  const causes = new Map<string, string>();
  for (const seat of input.seats) {
    const session = seatSession(db, seat.nodeId);
    if (!session) {
      report.unrouted.push({ seat: seat.logicalId, outcome: "none", reason: "no recorded session for this seat" });
      continue;
    }
    if (seat.cause) causes.set(session, seat.cause);
    const route = resolveEscalationOwner(db, session);
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
    try {
      // The same attempt's notice to this owner has one ID, and the queue returns a stored row for it unchanged, with no
      // second row or wake. So the report names the seats the stored notice names.
      const stored = await queue.create({
        qitemId,
        sourceSession: OPENRIG_SENDER,
        destinationSession: owner,
        wakeTrigger: "openrig",
        summary: `${list.length} seat${list.length === 1 ? "" : "s"} left as a bare shell: no harness started (${input.attempt})`,
        body: [
          `${input.attempt} left these seats as a bare shell, with no harness started. Each pane is kept, nothing was relaunched, and`,
          "`rig ps --nodes --summary` lists them under bareShell. Each line gives the seat's own cause:",
          ...list.map((seat) => `- ${seat}${causes.has(seat) ? `: ${causes.get(seat)}` : ""}`),
          "",
          `A plain \`rig launch\` won't start an agent in these shells, so fix the cause first. \`rig restore-check --rig ${rig}\` names`,
          `the fix for each seat, and \`rig up ${rig} --existing --plan\` previews bringing the rig up without doing it. Then, where a`,
          "snapshot can resume a seat, stop it and launch it from that snapshot to resume its conversation. Otherwise an explicitly",
          "fresh launch starts it without its original conversation.",
        ].join("\n"),
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
