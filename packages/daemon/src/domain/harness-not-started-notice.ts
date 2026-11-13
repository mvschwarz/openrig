import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { resolveEscalationOwner } from "./escalation-owner.js";
import type { QueueRepository } from "./queue-repository.js";

/** What a launch or restore attempt did about the seats it positively left as bare shells (no harness started). */
export interface HarnessNotStartedReport {
  /** One durable notice per resolved owner, keyed by the attempt, so running this again for the attempt adds none. */
  notices: Array<{ owner: string; qitemId: string; seats: string[] }>;
  /** Seats with no single destination: kept here with the routing fact, never sent to a guessed recipient. */
  unrouted: Array<{ seat: string; outcome: string; reason: string }>;
}

/** The seat's newest session name: the shell this attempt registered for it. */
function seatSession(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}

/**
 * Tells each seat's escalation owner, once per attempt, which seats an attempt left as bare shells. Grouped by the owner
 * `resolveEscalationOwner` actually resolves (a declared delegation parent or escalation destination). A seat with no
 * single destination stays in the report with that outcome and its reason, and nothing is sent for it. Nothing here
 * stops, relaunches, gates or waits: the restore's own result is unchanged.
 */
export async function noticeHarnessNotStarted(
  db: Database.Database,
  queue: Pick<QueueRepository, "create" | "getById">,
  input: { rigId: string; attempt: string; seats: Array<{ nodeId: string; logicalId: string }> },
): Promise<HarnessNotStartedReport> {
  const report: HarnessNotStartedReport = { notices: [], unrouted: [] };
  const byOwner = new Map<string, string[]>();
  for (const seat of input.seats) {
    const session = seatSession(db, seat.nodeId);
    if (!session) {
      report.unrouted.push({ seat: seat.logicalId, outcome: "none", reason: "no recorded session for this seat" });
      continue;
    }
    const route = resolveEscalationOwner(db, session);
    if (route.owner && (route.outcome === "parent" || route.outcome === "routed")) {
      byOwner.set(route.owner, [...(byOwner.get(route.owner) ?? []), session]);
    } else {
      report.unrouted.push({ seat: session, outcome: route.outcome, reason: route.reason });
    }
  }
  for (const [owner, seats] of byOwner) {
    const key = createHash("sha256").update(`${input.rigId}\0${input.attempt}\0${owner}`).digest("hex").slice(0, 16);
    const qitemId = `qitem-harness-not-started-${key}`;
    const list = [...seats].sort();
    report.notices.push({ owner, qitemId, seats: list });
    // The attempt's notice for this owner already exists: running this again for the same attempt adds nothing.
    if (queue.getById(qitemId)) continue;
    await queue.create({
      qitemId,
      sourceSession: list[0]!,
      destinationSession: owner,
      wakeTrigger: "openrig",
      summary: `${list.length} seat${list.length === 1 ? "" : "s"} left as a bare shell: no harness started (${input.attempt})`,
      body: [
        `${input.attempt} left these seats as a bare shell, with no harness started. Each pane is kept, nothing was relaunched, and`,
        "`rig ps --nodes --summary` lists them under bareShell:",
        ...list.map((seat) => `- ${seat}`),
        "",
        "To start one: `rig launch <rig> <seat>`, or stop it and launch it fresh with `rig seat launch <seat> --fresh --stop --reason \"<why>\"`.",
      ].join("\n"),
      tags: ["harness-not-started", `rig:${input.rigId}`],
    });
  }
  return report;
}
