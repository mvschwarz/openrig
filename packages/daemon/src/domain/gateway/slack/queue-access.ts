// S10 — the IN-PROCESS queue port for the gateway subsystem. Successor to the retired CLI
// queue-bridge (which shelled out to `rig queue` from the relay's separate process): in-daemon
// there is no process boundary, so fleet access is a direct QueueRepository read/write. The
// SELECTION SEMANTICS consume the single structured OWNER classification written with the
// queue transition. Tags and destination spellings are not a second alert classifier.
//   - reads are unbounded (the B5 lesson: a default limit silently truncates a large backlog).

import type { QueueRepository, QueueItem as RepoQueueItem } from "../../queue-repository.js";
import { loadHumanRegistry, resolveRegisteredHumanAddress, type LoadResult, type HumanFragment } from "../human-registry.js";
import { ownerNotificationLevelAtLeast, type OwnerNotificationLevel, type QueueTransition } from "../../queue-transition-log.js";

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
  notificationKey?: string | null;
  ownerNotificationKind?: string | null;
  ownerNotificationLevel?: OwnerNotificationLevel | null;
}

export interface AlertFilterOpts {
  minimumLevel?: OwnerNotificationLevel;
}

/** PURE: select active qitems whose transition carries a sufficient OWNER classification. */
export function filterHumanAlerts(items: QueueItem[], opts: AlertFilterOpts): QueueItem[] {
  const active = new Set(["pending", "in-progress", "blocked"]);
  return items.filter((q) => {
    if (q.state && !active.has(q.state)) return false;
    return q.ownerNotificationLevel
      ? ownerNotificationLevelAtLeast(q.ownerNotificationLevel, opts.minimumLevel ?? "NOTICE")
      : false;
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

function project(q: RepoQueueItem, transition: QueueTransition, entities: readonly HumanFragment[]): QueueItem | null {
  const r = q as unknown as Record<string, unknown>;
  let destinationSession: string | null = null;
  let sourceSession: string | null = null;
  if (transition.ownerNotificationKind === "human-decision-resolved") {
    destinationSession = resolveRegisteredHumanAddress(transition.actorSession, entities);
    sourceSession = q.destinationSession;
  } else if (q.state === "blocked") {
    destinationSession = resolveRegisteredHumanAddress(q.blockedOn, entities);
    sourceSession = q.destinationSession;
  } else {
    destinationSession = resolveRegisteredHumanAddress(q.destinationSession, entities);
    sourceSession = q.sourceSession;
  }
  if (!destinationSession) return null;
  return {
    qitemId: String(r.qitemId),
    destinationSession,
    sourceSession,
    tags: (r.tags as string[] | null) ?? null,
    state: (r.state as string | null) ?? null,
    tier: (r.tier as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    evidenceRef: (r.evidenceRef as string | null) ?? null,
    notificationKey: `${q.qitemId}:${transition.transitionId}`,
    ownerNotificationKind: transition.ownerNotificationKind,
    ownerNotificationLevel: transition.ownerNotificationLevel,
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
  const toSeed = alerts.map((a) => a.notificationKey ?? a.qitemId).filter((id) => !already.has(id));
  const seeded = opts.seen.seed(toSeed, "seeded-at-enable");
  const onlineStatus = `slack outbound ENABLED at enable-time: ${seeded} pre-existing alert(s) seeded as history (not reposted); only alerts created after this point will deliver.`;
  opts.log?.(onlineStatus);
  return { seeded, onlineStatus };
}

/** Build both ports over the daemon's own QueueRepository. In-process: no shell, no transport,
 *  no `-A` scope trap (list() here is repository-wide), no bounded-body N+1 (rows carry bodies). */
export function makeQueuePorts(
  queueRepo: QueueRepository,
  opts: { loadHumanRegistry?: () => LoadResult } = {},
): InboundQueuePort & OutboundQueuePort {
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
      const registry = (opts.loadHumanRegistry ?? (() => loadHumanRegistry()))();
      if (!registry.ok) return [];
      const rows = queueRepo.list({ activeOnly: true, limit: 1000000 });
      const projected = rows.flatMap((row) => {
        const transition = queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
        if (!transition) return [];
        const notificationKey = `${row.qitemId}:${transition.transitionId}`;
        if (queueRepo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, notificationKey)) return [];
        const item = project(row, transition, registry.entities);
        return item ? [item] : [];
      });
      return filterHumanAlerts(projected, filter);
    },
  };
}
