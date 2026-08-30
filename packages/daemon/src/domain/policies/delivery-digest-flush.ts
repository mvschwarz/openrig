// OPR.0.5.6.1 mini-req 3 + AM-F1 — the C/D digest flush on the watchdog
// substrate. LOSSLESS against the row record: the flush re-derives its member
// set from the live selection (rows whose engine outcome is digest and whose
// episode carries no posted receipt) — nothing is held in memory, so a daemon
// down ACROSS a window flushes on the next evaluation with nothing lost
// (AM-F1 timing-losslessness). EXACTLY-ONCE by the receipt: each member row is
// stamped with the S14 posted literal (digest-tokened), and both the sweep's
// selection and this flush drop receipted episodes — no digested item is ever
// ALSO posted individually, and a second flush finds nothing. The digest post
// itself is notify-class (no mention, ever).

import type { QueueRepository } from "../queue-repository.js";
import { makeQueuePorts } from "../gateway/slack/queue-access.js";
import type { OwnerNotificationLevel } from "../queue-transition-log.js";
// R1 B-4: the flush consumes RECORDED message-time decisions — it never
// re-decides from later registry state, so no engine import belongs here.
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const DELIVERY_DIGEST_FLUSH_POLICY = "delivery-digest-flush";

interface RegistrySurfaceLike {
  loadHumanRegistry: (home: string) => {
    ok: boolean;
    entities?: Array<{
      entityId: string;
      prefs: { deliveryClass: "A" | "B" | "C" | "D"; away?: boolean; availability?: string };
    }>;
  };
}

export interface RunDeliveryDigestFlushInput {
  queueRepo: QueueRepository;
  registry: RegistrySurfaceLike;
  home: string;
  post: (payload: Record<string, unknown>) => Promise<{ ok: boolean; ts?: string }>;
  window: "4h" | "daily";
  minimumLevel?: OwnerNotificationLevel;
  dials?: { minimumLevelThatPosts: OwnerNotificationLevel; minimumLevelThatInterrupts: OwnerNotificationLevel };
  now?: Date;
}

export async function runDeliveryDigestFlush(input: RunDeliveryDigestFlushInput): Promise<{ posted: number; members: number }> {
  const reg = input.registry.loadHumanRegistry(input.home);
  if (!reg.ok || !reg.entities) return { posted: 0, members: 0 };
  const ports = makeQueuePorts(input.queueRepo, {
    loadHumanRegistry: () => reg,
  } as never);
  // The selection already drops receipted episodes — the exactly-once floor.
  const alerts = await ports.listHumanAlerts({ minimumLevel: input.minimumLevel ?? "NOTICE" });

  // R1 B-4: membership = the RECORDED message-time decision for the CURRENT
  // episode (containment wrote `delivery-decision: digest ...` with the episode
  // key and live dials at decision time). Later prefs/dial drift neither drops
  // nor reclassifies an already-made decision.
  const members = alerts.filter((alert) => {
    const key = alert.notificationKey ?? alert.qitemId;
    return input.queueRepo.listTransitions(alert.qitemId).some((t) =>
      t.transitionNote?.startsWith("delivery-decision: digest")
        && t.transitionNote.includes(`notification_key=${key}`)
        && t.transitionNote.includes(`window=${input.window}`));
  });
  if (members.length === 0) return { posted: 0, members: 0 };

  // RESERVE BEFORE DELIVER (R1 B-4, same doctrine as the deferral): member
  // receipts land BEFORE the post, so no crash boundary can re-post members.
  // At-most-once: a crash (or post failure) after the reserve loses the digest
  // recoverably and LOUDLY — never a silent double.
  const digestId = (input.now ?? new Date()).toISOString();
  for (const m of members) {
    const key = m.notificationKey ?? m.qitemId;
    if (input.queueRepo.transitionLog.hasOwnerNotificationReceipt(m.qitemId, key)) continue;
    input.queueRepo.update({
      qitemId: m.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: [
        "slack-owner-notification-posted",
        `notification_key=${key}`,
        `level=${m.ownerNotificationLevel ?? "RECORD"}`,
        `kind=${m.ownerNotificationKind ?? "unclassified"}`,
        `message_ts=${digestId}`,
        `thread_ts=${digestId}`,
        `digest=${digestId}`,
      ].join(" "),
    });
  }

  const outcome = await input.post({
    kind: "delivery-digest",
    window: input.window,
    count: members.length,
    items: members.map((m) => ({
      qitemId: m.qitemId,
      summary: m.summary ?? null,
      destinationSession: m.destinationSession ?? null,
      sourceSession: m.sourceSession ?? null,
    })),
  });
  if (!outcome.ok) {
    for (const m of members) {
      const key = m.notificationKey ?? m.qitemId;
      input.queueRepo.update({
        qitemId: m.qitemId,
        actorSession: "daemon@kernel",
        transitionNote: `delivery-digest-post-failed digest=${digestId} notification_key=${key}`,
      });
    }
    return { posted: 0, members: members.length };
  }
  return { posted: 1, members: members.length };
}

/** Watchdog-engine policy wrapper — the repeating window flush (digests recur;
 *  only the deferral is one-shot). */
export function makeDeliveryDigestFlushPolicy(deps: {
  queueRepo: QueueRepository;
  registry: RegistrySurfaceLike;
  home: string;
  post: (payload: Record<string, unknown>) => Promise<{ ok: boolean; ts?: string }>;
}): Policy {
  return {
    name: DELIVERY_DIGEST_FLUSH_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const window = ((job.context as { window?: string }).window === "daily" ? "daily" : "4h") as "4h" | "daily";
      const r = await runDeliveryDigestFlush({ ...deps, window });
      if (r.posted > 0) return { action: "skip", reason: `digest flushed (${r.members} items)` };
      return { action: "skip", reason: "nothing to flush" };
    },
  } as Policy;
}
