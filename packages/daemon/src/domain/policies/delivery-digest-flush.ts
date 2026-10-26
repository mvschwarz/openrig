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
import { DispatchBuffer } from "../gateway/dispatch-buffer.js";
import { resolveDefaultPerson } from "../gateway/participants.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";
import { quietHoldFor } from "../gateway/human-quiet-windows.js";
import { WatchdogJobsRepository } from "../watchdog-jobs-repository.js";
import { holdForQuiet } from "./quiet-release.js";

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
  now?: Date;
}

export async function runDeliveryDigestFlush(input: RunDeliveryDigestFlushInput): Promise<{ dispatched: number; members: number }> {
  const reg = input.registry.loadHumanRegistry(input.home);
  if (!reg.ok || !reg.entities || reg.entities.length === 0) return { dispatched: 0, members: 0 };
  // Asks and updates below go to their own recipients; the digest of notices goes to the default person.
  const human = resolveDefaultPerson(reg.entities, input.home).person;

  const ports = makeQueuePorts(input.queueRepo, {
    loadHumanRegistry: () => reg,
  } as never);
  // The selection already drops receipted episodes — receipts exist only after
  // a REAL post, so members remain flushable until transport truth.
  const alerts = await ports.listHumanAlerts({ minimumLevel: input.minimumLevel ?? "NOTICE" });

  // MEMBERSHIP EXCLUSIVITY (R1 HOLD c7818ceb): a member already riding a
  // PENDING digest decision is IN FLIGHT — the durable buffer is the
  // recovery-safe source of truth (no new state, no ordering window: a mint
  // lost before enqueue leaves no pending entry, so its members stay
  // mintable; an enqueued mint redrives to transport truth). Excluding
  // in-flight members makes overlap structurally impossible, so a growing
  // member set can never double-deliver the pending ones.
  const inFlight = new Set<string>();
  try {
    for (const d of new DispatchBuffer(input.home).pending()) {
      if (!d.decisionId.startsWith("digest:")) continue;
      const ownKey = (d.payload as { notificationKey?: string } | null)?.notificationKey;
      if (ownKey) inFlight.add(ownKey);
      const mrs = (d.payload as { memberReceipts?: Array<{ notificationKey?: string }> } | null)?.memberReceipts ?? [];
      for (const m of mrs) if (m.notificationKey) inFlight.add(m.notificationKey);
    }
  } catch { /* unreadable buffer: fail open to selection; the dispatcher's stable-id idempotence still guards the same-set case */ }

  const candidates = alerts.filter((alert) => {
    const key = alert.notificationKey ?? alert.qitemId;
    if (inFlight.has(key)) return false;
    const notes = input.queueRepo.listTransitions(alert.qitemId).map((t) => t.transitionNote ?? "");
    // An ask held for quiet hours belongs to its window's release job, which posts it individually.
    if (notes.some((n) => n.startsWith("delivery-decision: quiet-hold") && n.split(/\s+/).includes(`notification_key=${key}`))) return false;
    return notes.some((n) =>
      n.startsWith("delivery-decision: digest")
        && n.includes(`notification_key=${key}`)
        && n.includes(`window=${input.window}`));
  });
  // Quiet hours re-checked at flush time, per ask, for its actual recipient: an ask put in the digest before its
  // recipient's quiet began is held under that recipient's window, not posted. Everything else flushes as before.
  const now = input.now ?? new Date();
  let jobsRepo: WatchdogJobsRepository | undefined;
  const selected = candidates.filter((item) => {
    const recipient = (item.destinationSession ?? "").split("@")[0] ?? "";
    const quiet = recipient ? quietHoldFor(input.queueRepo.db, recipient, now) : null;
    if (!quiet) return true;
    jobsRepo ??= new WatchdogJobsRepository(input.queueRepo.db);
    holdForQuiet({ queueRepo: input.queueRepo, jobsRepo, qitemId: item.qitemId, entityId: recipient,
      hold: { ...quiet, notificationKey: item.notificationKey ?? item.qitemId } });
    return false;
  });
  if (selected.length === 0) return { dispatched: 0, members: 0 };
  // The selected timing remains the existing digest policy. At that time a
  // human request/update needs its OWN complete brief and reply identity, not a
  // summary-only member receipt. Ordinary system notices retain aggregation.
  let completeDispatched = 0;
  const members = [] as typeof selected;
  for (const item of selected) {
    if (item.ownerNotificationKind !== "human-required" && item.ownerNotificationKind !== "human-update" && !item.humanDetail) {
      members.push(item);
      continue;
    }
    const id = createHash("sha256").update(input.window + "|" + (item.notificationKey ?? item.qitemId)).digest("hex").slice(0, 32);
    const result = input.dispatch(OUTBOUND_OP, item.destinationSession!, { ...item, deliveryDigestPost: true }, { decisionId: `digest:complete:${id}` });
    if (result.ok) completeDispatched++;
  }
  if (!members.length) return { dispatched: completeDispatched, members: selected.length };
  // Several people and none chosen: the notices wait (they stay selectable) rather than going to whoever sorts first.
  if (!human) return { dispatched: completeDispatched, members: selected.length };

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
  return { dispatched: completeDispatched + (res.ok ? 1 : 0), members: selected.length };
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
