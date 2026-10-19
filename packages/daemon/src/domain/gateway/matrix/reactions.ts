import type { HumanQuestion } from "../../human-questions.js";
import type { MatrixEvent } from "./matrix-api.js";
import type { ThreadSeatMap } from "./thread-seat-map.js";

// Explicit wire emoji → option positions; strip only the optional VS16 to
// accommodate clients that send either Unicode spelling of a keycap.
export const OPTION_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"] as const;
export function renderQuestion(question: HumanQuestion): { text: string; emojiOptions: Record<string, string> } {
  const emojiOptions: Record<string, string> = {};
  const options = question.options.map((option, index) => {
    const emoji = OPTION_EMOJI[index];
    if (!emoji) throw new Error("Matrix question supports at most four options");
    emojiOptions[emoji] = option.id;
    return `${emoji} ${option.label}${option.recommended ? " (recommended)" : ""}`;
  });
  return { text: [question.question, ...options, "React to this message to choose, or reply in the thread."].join("\n"), emojiOptions };
}
export function reactionAnswer(map: ThreadSeatMap, roomId: string, event: MatrixEvent, human: string): {
  qitemId: string; questionId: string; optionId: string; seat: string; threadRootEventId: string;
} | null {
  const relation = event.content["m.relates_to"];
  if (event.type !== "m.reaction" || relation?.rel_type !== "m.annotation" || !relation.event_id || !relation.key) return null;
  const question = map.question(roomId, relation.event_id);
  if (!question || question.human !== human) return null; // exact room + asked human, not any registered sender
  const chosen = Object.entries(question.emojiOptions).find(([emoji]) => emoji.replace(/\uFE0F/g, "") === relation.key!.replace(/\uFE0F/g, ""));
  return chosen ? { qitemId: question.conversationId, questionId: question.questionId, optionId: chosen[1], seat: question.seat, threadRootEventId: question.threadRootEventId } : null;
}
