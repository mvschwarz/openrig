// Slice-11 slack-connector — OUTBOUND orchestration (poll → post → seen-after).
//
// Locked items: 1 (proven post), 2 (dedup by qitemId; seen written AFTER a 200;
// at-least-once with byte-identical crash-window dup), 3 (fail-VISIBLE on a bad
// webhook), 7 (message hygiene — via message.ts), 9 (enable-time backlog seeds
// as history, zero replay storm + honest online-status line).
import type { SeenStore } from "./state-store.js";
import type { QueueRunner, AlertFilterOpts } from "./queue-bridge.js";
import { listHumanAlerts, showFull } from "./queue-bridge.js";
import { postWebhook, type FetchImpl } from "./slack-api.js";
import { buildOutboundMessage } from "./message.js";

export interface OutboundDeps {
  runner: QueueRunner;
  seen: SeenStore;
  webhookUrl: string;
  fetchImpl?: FetchImpl;
  sourceLabel: string;
  filter: AlertFilterOpts; // alertTag (+ optional destinations)
  bodyExcerpt?: number;
  log?: (msg: string) => void;
}

export interface OutboundResult {
  freshCount: number;
  posted: string[];
  failed: { id: string; error: string }[];
}

/**
 * One outbound sweep. Posts every FRESH human alert, marking it seen ONLY after
 * a 200. A failed post is logged loudly and left UNSEEN so the next sweep
 * retries it — never a silent drop. Returns failures so the caller exits
 * non-zero (fail-visible).
 */
export async function runOutboundOnce(deps: OutboundDeps): Promise<OutboundResult> {
  const log = deps.log ?? (() => {});
  const alerts = await listHumanAlerts(deps.runner, deps.filter);
  const seen = deps.seen.load();
  const fresh = alerts.filter((q) => !seen.has(q.qitemId));
  log(`alerts=${alerts.length} fresh=${fresh.length}`);

  const posted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const a of fresh) {
    // list bounds bodies (item 9 N+1) — pull the full item for summary+body.
    const full = (await showFull(deps.runner, a.qitemId)) ?? a;
    const payload = buildOutboundMessage(
      { qitemId: a.qitemId, summary: full.summary ?? a.summary, body: full.body, destinationSession: a.destinationSession },
      // M1 A5b WIRING: the image seam had a renderer and a consumer but NO production caller —
      // the sweep posted text only. An alert's evidenceRef IS the artifact the human judges, so
      // when it is an https image URL it rides as a Block Kit image block. buildImageBlocks is the
      // single gate (drops non-https / secret-bearing), so the predicate lives in ONE place.
      {
        sourceLabel: deps.sourceLabel,
        bodyExcerpt: deps.bodyExcerpt,
        mediaRefs: (full.evidenceRef ?? a.evidenceRef)
          ? [{ imageUrl: String(full.evidenceRef ?? a.evidenceRef), altText: full.summary ?? a.summary ?? "attachment" }]
          : undefined,
      },
    );
    const res = await postWebhook(deps.webhookUrl, payload, deps.fetchImpl);
    if (res.ok) {
      deps.seen.mark(a.qitemId, "posted"); // …seen ONLY after success (item 2)
      posted.push(a.qitemId);
      log(`posted ${a.qitemId}`);
    } else {
      // fail-VISIBLE (item 3): loud, NOT marked seen → retried next sweep (no drop).
      log(`ERROR posting ${a.qitemId}: ${res.error}`);
      failed.push({ id: a.qitemId, error: res.error ?? "unknown" });
    }
  }
  if (fresh.length === 0) log("nothing new");
  return { freshCount: fresh.length, posted, failed };
}

export interface SeedResult {
  seeded: number;
  onlineStatus: string;
}

/**
 * Item 9: on ENABLE, seed all currently-active human alerts as history/seen
 * WITHOUT posting, so turning the connector on never replays the backlog.
 * Returns an honest online-status line marking the transition.
 */
export async function seedBacklogOnEnable(deps: Pick<OutboundDeps, "runner" | "seen" | "filter" | "log">): Promise<SeedResult> {
  const alerts = await listHumanAlerts(deps.runner, deps.filter);
  const already = deps.seen.load();
  const toSeed = alerts.map((a) => a.qitemId).filter((id) => !already.has(id));
  const seeded = deps.seen.seed(toSeed, "seeded-at-enable");
  const onlineStatus = `slack outbound ENABLED at enable-time: ${seeded} pre-existing alert(s) seeded as history (not reposted); only alerts created after this point will deliver.`;
  deps.log?.(onlineStatus);
  return { seeded, onlineStatus };
}
