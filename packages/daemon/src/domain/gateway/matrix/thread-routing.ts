import type { MatrixEvent } from "./matrix-api.js";
import type { ThreadSeatMap } from "./thread-seat-map.js";

export function routeMessage(map: ThreadSeatMap, roomId: string, event: MatrixEvent, fallback: string): {
  destination: string; tags: string[]; conversationId?: string; human?: string;
} {
  const relation = event.content["m.relates_to"];
  const root = relation?.rel_type === "m.thread" ? relation.event_id : relation?.["m.in_reply_to"]?.event_id;
  const mapping = root ? map.resolveByEvent(roomId, root) : null;
  const tags = ["matrix", "inbound"];
  if (mapping) return { destination: mapping.seat, human: mapping.human, conversationId: mapping.conversationId, tags: [...tags, "thread", `reply-to:${mapping.conversationId}`] };
  return { destination: fallback, tags: [...tags, "unrouted-signal"] };
}
