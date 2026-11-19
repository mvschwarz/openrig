import type { QueueRepository, QueueItem } from "./queue-repository.js";
import { isHumanSeatSessionRef } from "./session-name.js";

/** Shared queue attention membership; projection and delivery details remain with each reader. */
export function humanAskAttention(queue: QueueRepository) {
  const rows = queue.listAttention({ limit: 1001, includeWaiting: false });
  const bounded = rows.slice(0, 1000);
  const asked = new Set(bounded.filter(q => queue.isCurrentHumanAsk(q.qitemId)).map(q => q.qitemId));
  const current = bounded.filter(q => isHumanSeatSessionRef(q.destinationSession) || asked.has(q.qitemId)
    || q.state === "blocked" && isHumanSeatSessionRef(q.blockedOn ?? ""));
  return { current, asked, partial: rows.length >= 1001 };
}

/** This job handles structured human asks only, with the existing whole-thread answer semantics. */
export function appAskUnsupported(queue: QueueRepository, item: QueueItem): string | null {
  if (item.contentErasedAt) return "source_unavailable";
  if (!queue.isPersonAddress(item.destinationSession) || queue.isSharedChannel(item.destinationSession)
    || item.humanIntent === "update" || !item.humanQuestions?.length || item.evidenceRef?.startsWith("pair-request:")) return "unsupported_request_kind";
  if (item.state !== "pending") return "request_not_pending";
  return null;
}
