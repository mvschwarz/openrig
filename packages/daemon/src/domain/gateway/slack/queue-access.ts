// S10 — the IN-PROCESS queue port for the gateway subsystem. Successor to the retired CLI
// queue-bridge (which shelled out to `rig queue` from the relay's separate process): in-daemon
// there is no process boundary, so fleet access is a direct QueueRepository read/write. The
// SELECTION SEMANTICS are the shipped slice-11 rules carried over unchanged (filterHumanAlerts
// moved verbatim from queue-bridge.ts, which was DELETED with the relay runners at the cutover):
//   - a qitem alerts iff ACTIVE (pending/in-progress/blocked), tagged with the alert tag, AND
//     human-destined (explicit allow-list, a human-seat session ref, or tier human-gate);
//   - reads are unbounded (the B5 lesson: a default limit silently truncates a large backlog).

import type { QueueRepository, QueueItem as RepoQueueItem } from "../../queue-repository.js";
import { isHumanSeatSessionRef } from "../../session-name.js";

/** The narrow projection the slack path consumes (shape-compatible with the retired bridge's
 *  QueueItem so message construction and tests carry over). */
export interface QueueItem {
  qitemId: string;
  destinationSession?: string | null;
  sourceSession?: string | null;
  tags?: string[] | null;
  state?: string | null;
  tier?: string | null;
  summary?: string | null;
  body?: string | null;
  evidenceRef?: string | null;
}

export interface AlertFilterOpts {
  alertTag: string; // e.g. "founder-alert"
  /** Optional explicit human-seat allow-list; when empty, any human-seat destination or human-gate tier matches. */
  destinations?: string[];
}

/** PURE (verbatim from the retired queue-bridge): select the qitems that should alert a human. */
export function filterHumanAlerts(items: QueueItem[], opts: AlertFilterOpts): QueueItem[] {
  const active = new Set(["pending", "in-progress", "blocked"]);
  const allow = new Set(opts.destinations ?? []);
  return items.filter((q) => {
    if (q.state && !active.has(q.state)) return false;
    if (!(q.tags ?? []).includes(opts.alertTag)) return false;
    const dest = q.destinationSession ?? "";
    const isHuman = allow.size > 0 ? allow.has(dest) : isHumanSeatSessionRef(dest) || q.tier === "human-gate";
    return isHuman;
  });
}

export interface CreateQitemInput {
  source: string;
  destination: string;
  summary: string;
  body: string;
  priority?: string;
  tags?: string[];
}

/** What the inbound router needs: land a durable qitem, get its id (or throw). */
export interface InboundQueuePort {
  createQitem(input: CreateQitemInput): Promise<string>;
}

/** What the outbound driver needs: the current human-alert set, full items included. */
export interface OutboundQueuePort {
  listHumanAlerts(filter: AlertFilterOpts): Promise<QueueItem[]>;
}

function project(q: RepoQueueItem): QueueItem {
  const r = q as unknown as Record<string, unknown>;
  return {
    qitemId: String(r.qitemId),
    destinationSession: (r.destinationSession as string | null) ?? null,
    sourceSession: (r.sourceSession as string | null) ?? null,
    tags: (r.tags as string[] | null) ?? null,
    state: (r.state as string | null) ?? null,
    tier: (r.tier as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    evidenceRef: (r.evidenceRef as string | null) ?? null,
  };
}

/** Slice-11 item 9, carried over verbatim from the retired outbound.ts: on ENABLE, seed all
 *  currently-active human alerts as history/seen WITHOUT posting, so turning the connector on
 *  never replays the backlog. Returns the honest online-status line marking the transition. */
export async function seedBacklogAsHistory(opts: {
  queue: OutboundQueuePort;
  seen: import("./state-store.js").SeenStore;
  filter: AlertFilterOpts;
  log?: (msg: string) => void;
}): Promise<{ seeded: number; onlineStatus: string }> {
  const alerts = await opts.queue.listHumanAlerts(opts.filter);
  const already = opts.seen.load();
  const toSeed = alerts.map((a) => a.qitemId).filter((id) => !already.has(id));
  const seeded = opts.seen.seed(toSeed, "seeded-at-enable");
  const onlineStatus = `slack outbound ENABLED at enable-time: ${seeded} pre-existing alert(s) seeded as history (not reposted); only alerts created after this point will deliver.`;
  opts.log?.(onlineStatus);
  return { seeded, onlineStatus };
}

/** Build both ports over the daemon's own QueueRepository. In-process: no shell, no transport,
 *  no `-A` scope trap (list() here is repository-wide), no bounded-body N+1 (rows carry bodies). */
export function makeQueuePorts(queueRepo: QueueRepository): InboundQueuePort & OutboundQueuePort {
  return {
    async createQitem(input: CreateQitemInput): Promise<string> {
      const created = await queueRepo.create({
        sourceSession: input.source,
        destinationSession: input.destination,
        body: input.body,
        summary: input.summary,
        priority: (input.priority ?? "routine") as never,
        tags: input.tags ?? ["founder-slack", "inbound"],
      });
      return (created as unknown as { qitemId: string }).qitemId;
    },
    async listHumanAlerts(filter: AlertFilterOpts): Promise<QueueItem[]> {
      // activeOnly narrows at the repo; filterHumanAlerts re-checks state defensively (verbatim rule).
      const rows = queueRepo.list({ activeOnly: true, limit: 1000000 });
      return filterHumanAlerts(rows.map(project), filter);
    },
  };
}
