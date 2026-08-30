// OPR.0.5.6.1 mini-req 3 + AM-F1 — the C/D digest flush, v3 (dual-rebind
// repair, R1 76a8cfd1 + R2 003f4786): LOSSLESS and EXACTLY-ONCE by transport
// truth. Membership = the RECORDED message-time decision for the CURRENT
// episode (containment wrote it with live dials at decision time). The digest
// posts THROUGH THE GATEWAY on a durable episode-stable decision id
// (`digest:<stable-hash>`): the dispatch buffer redrives it until the real
// post succeeds, the delivered-store makes any replay/re-dispatch converge on
// one post, and the S14 retain-and-repair path owns the post/stamp crash
// boundary. Member receipts are stamped by the delivery seam ONLY AFTER the
// post — a transport failure leaves zero false receipts and every member
// flushable (the redrive is the recovery, never a silent loss).

import { createHash } from "node:crypto";
import type { QueueRepository } from "../queue-repository.js";
import { makeQueuePorts } from "../gateway/slack/queue-access.js";
import type { OwnerNotificationLevel } from "../queue-transition-log.js";
import { OUTBOUND_OP } from "../gateway/slack/outbound-driver.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const DELIVERY_DIGEST_FLUSH_POLICY = "delivery-digest-flush";

interface RegistrySurfaceLike {
  loadHumanRegistry: (home: string) => {
    ok: boolean;
    entities?: Array<{ entityId: string; address: string }>;
  };
}

export interface RunDeliveryDigestFlushInput {
  queueRepo: QueueRepository;
  registry: RegistrySurfaceLike;
  home: string;
  dispatch: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => { ok: boolean; error?: string };
  window: "4h" | "daily";
  minimumLevel?: OwnerNotificationLevel;
}

export async function runDeliveryDigestFlush(input: RunDeliveryDigestFlushInput): Promise<{ dispatched: number; members: number }> {
  const reg = input.registry.loadHumanRegistry(input.home);
  if (!reg.ok || !reg.entities || reg.entities.length === 0) return { dispatched: 0, members: 0 };
  const human = reg.entities[0]!;

  const ports = makeQueuePorts(input.queueRepo, {
    loadHumanRegistry: () => reg,
  } as never);
  // The selection already drops receipted episodes — receipts exist only after
  // a REAL post, so members remain flushable until transport truth.
  const alerts = await ports.listHumanAlerts({ minimumLevel: input.minimumLevel ?? "NOTICE" });

  const members = alerts.filter((alert) => {
    const key = alert.notificationKey ?? alert.qitemId;
    return input.queueRepo.listTransitions(alert.qitemId).some((t) =>
      t.transitionNote?.startsWith("delivery-decision: digest")
        && t.transitionNote.includes(`notification_key=${key}`)
        && t.transitionNote.includes(`window=${input.window}`));
  });
  if (members.length === 0) return { dispatched: 0, members: 0 };

  const memberReceipts = members.map((m) => ({
    qitemId: m.qitemId,
    notificationKey: m.notificationKey ?? m.qitemId,
    level: m.ownerNotificationLevel ?? "RECORD",
    kind: m.ownerNotificationKind ?? "unclassified",
  }));
  // Durable episode-stable identity: same member set + window -> same decision id.
  const digestId = createHash("sha256")
    .update(input.window + "|" + memberReceipts.map((m) => m.notificationKey).sort().join(","))
    .digest("hex")
    .slice(0, 16);

  const payload = {
    deliveryDigestPost: true,
    digestId,
    qitemId: memberReceipts[0]!.qitemId, // anchor row for transport-failure ledger writes
    destinationSession: human.address,
    summary: `Delivery digest (${input.window}) — ${members.length} item(s)`,
    body: members.map((m) => `• ${m.summary ?? m.qitemId} [${m.qitemId}]`).join("\n"),
    memberReceipts,
  };
  const res = input.dispatch(OUTBOUND_OP, human.address, payload, { decisionId: `digest:${digestId}` });
  return { dispatched: res.ok ? 1 : 0, members: members.length };
}

/** Watchdog-engine policy wrapper — the repeating window flush (digests recur;
 *  only the deferral is one-shot). */
export function makeDeliveryDigestFlushPolicy(deps: {
  queueRepo: QueueRepository;
  registry: RegistrySurfaceLike;
  home: string;
  dispatch: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => { ok: boolean; error?: string };
}): Policy {
  return {
    name: DELIVERY_DIGEST_FLUSH_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const window = ((job.context as { window?: string }).window === "daily" ? "daily" : "4h") as "4h" | "daily";
      const r = await runDeliveryDigestFlush({ ...deps, window });
      if (r.dispatched > 0) return { action: "skip", reason: `digest dispatched (${r.members} items)` };
      return { action: "skip", reason: "nothing to flush" };
    },
  } as Policy;
}
