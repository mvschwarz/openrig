import { createHash } from "node:crypto";
import type { OutboxHandler, RunnerReceipt } from "./outbox-handler.js";
import type { QueueRepository } from "./queue-repository.js";
import { resolveEscalationOwner } from "./escalation-owner.js";
import { describeDefaultReceiver, resolveDefaultReceiver } from "./default-receiver.js";
import { resolveSessionNodeId } from "./queue-owner.js";
import { physicalSessionName } from "./session-registry.js";
import { isHumanSeatSessionRef } from "./session-name.js";
import { resolveRegisteredHumanAddress } from "./gateway/human-registry.js";

export const NATIVE_CONTINUATION_STEP = "Send a new plain prompt in that pane, without resending the retained words. This is distinct from /abort or rig seat stop; continuing is not cancellation proof and never restores withdrawn approvals.";

/** Ordinary durable work for an independent agent; no native resend or notification-specific retry owner. */
export async function reportNativeContinuation(outbox: OutboxHandler, queue: QueueRepository | undefined, receipt: RunnerReceipt) {
  const current = outbox.runnerReceipt(receipt.requestId);
  const evidence = current?.result?.continuation as { inputRequestIds: string[]; pendingRequestIds: string[]; unmatchedCount: number } | undefined;
  if (!current || current.erasedAt || !evidence) return undefined;
  const db = outbox.db;
  const unavailable = (reason: string) => ({ state: "unavailable", reason, step: NATIVE_CONTINUATION_STEP });
  if (!queue) return unavailable("No ordinary queue owner is available; the person operating the seat must continue it.");
  const qitemId = `qitem-native-continuation-${createHash("sha256").update(`${current.nodeId}\0${current.runId}\0${current.requestId}`).digest("hex").slice(0, 24)}`;
  const existing = queue.getById(qitemId);
  if (existing) return { state: "recorded", qitemId, owner: existing.destinationSession, reason: "Existing ordinary work is retained; this is not delivery or pickup proof.", step: NATIVE_CONTINUATION_STEP };
  const seat = db.prepare("SELECT session_name FROM sessions WHERE node_id=? ORDER BY id DESC LIMIT 1").get(current.nodeId) as { session_name: string } | undefined;
  if (!seat) return unavailable("The runner's recorded seat is unavailable; no source identity was invented.");
  const humans = queue.humanRegistry();
  const unusable = (candidate: string) => candidate === seat.session_name
    || physicalSessionName(db, candidate) === physicalSessionName(db, seat.session_name)
    || resolveSessionNodeId(db, candidate) === current.nodeId || isHumanSeatSessionRef(candidate)
    || (humans.ok && !!resolveRegisteredHumanAddress(candidate, humans.entities))
    || !resolveSessionNodeId(db, candidate) || !queue.acceptsDestination(candidate);
  const route = resolveEscalationOwner(db, seat.session_name, destination => queue.acceptsDestination(destination));
  let owner = route.owner && ["parent", "routed"].includes(route.outcome) && !unusable(route.owner) ? route.owner : null;
  let reason = route.reason;
  if (owner) {
    const state = resolveDefaultReceiver(db, () => owner);
    reason += `; responsible agent ${owner}, recorded state ${state.state}${state.recorded ? ` (${state.recorded})` : ""}; ordinary work may wait for it.`;
  }
  else {
    let receiver = resolveDefaultReceiver(db);
    if (receiver.session && unusable(receiver.session)) receiver = resolveDefaultReceiver(db, () => ({ session: null, problem: "The configured receiving agent cannot independently act for this runner." }));
    reason += `; ${describeDefaultReceiver(receiver)}`;
    owner = receiver.session && !unusable(receiver.session) ? receiver.session : null;
  }
  if (!owner) return unavailable(`${reason} No distinct responsible agent can receive this work; the person operating the seat must continue it.`);
  const target = current.payload.target as { runId: string; nativeTurnId: string };
  let unknown = evidence.unmatchedCount;
  const words: string[] = [];
  for (const id of evidence.inputRequestIds) {
    const input = outbox.runnerReceipt(id);
    if (!input || input.erasedAt || input.kind !== "input" || input.nodeId !== current.nodeId || input.runId !== current.runId
      || input.nativeTurnId !== target.nativeTurnId || typeof input.payload.text !== "string"
      || (input.memberIds ?? []).some(member => { const saved = outbox.runnerReceipt(member); return !saved || saved.erasedAt || saved.requestId !== input.requestId; })) { unknown++; continue; }
    words.push(`Reported retained input ${input.requestId}, members ${JSON.stringify(input.memberIds ?? [input.requestId])}: ${JSON.stringify(input.payload.text)}`);
  }
  const pending = evidence.pendingRequestIds.filter(id => { const input = outbox.runnerReceipt(id); return input && input.kind !== "cancel" && !input.erasedAt && input.nodeId === current.nodeId && input.runId === current.runId; });
  try {
    await queue.create({ qitemId, sourceSession: seat.session_name, destinationSession: owner, wakeTrigger: "openrig",
      summary: `Native input retained after cancellation ${current.requestId} at ${seat.session_name}`,
      tags: ["native-continuation", `native-request:${current.requestId}`],
      body: `Runner ${seat.session_name}; cancellation ${current.requestId}; named invocation ${JSON.stringify(target)}. ${reason}\n`
        + `Recorded ownership is not delivery or pickup proof; ordinary queue owner/escalation rules apply if this agent cannot act.\n`
        + `${NATIVE_CONTINUATION_STEP}\nCancellation remains requested and unconfirmed. Pending managed request snapshot: ${JSON.stringify(pending)}. Inspect rig seat status ${seat.session_name} --json for current destinations and additional work.\n`
        + `${words.join("\n")}\n${unknown} retained word entries were not observable or attributable; do not reconstruct or resend them.`,
    });
  } catch (error) {
    if ((error as { code?: string }).code === "qitem_erased") return unavailable("This continuation work ID was erased; it is not recreated.");
    throw error; // The existing runner result POST retries transient failures with this same immutable work ID.
  }
  return { state: "recorded", qitemId, owner, reason: `${reason} Ordinary work was retained; delivery and pickup are separate.`, step: NATIVE_CONTINUATION_STEP };
}
