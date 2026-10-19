import path from "node:path";
import { JsonStore } from "./state-store.js";

export interface ThreadMapping {
  roomId: string;
  threadRootEventId: string;
  human: string;
  seat: string;
  conversationId: string;
  state: "open" | "closed";
}
export interface QuestionMapping extends Omit<ThreadMapping, "state"> {
  eventId: string;
  questionId: string;
  emojiOptions: Record<string, string>;
}
interface State { threads: ThreadMapping[]; questions: QuestionMapping[]; events?: Record<string, string> }
export class ThreadSeatMap {
  private readonly store: JsonStore<State>;
  constructor(home: string) { this.store = new JsonStore(path.join(home, "state", "matrix-threads.json"), { threads: [], questions: [] }); }
  open(mapping: Omit<ThreadMapping, "state">): void {
    if (this.resolveByThread(mapping.roomId, mapping.threadRootEventId)) return;
    const state = this.store.read();
    this.store.write({ ...state, threads: [...state.threads, { ...mapping, state: "open" }] });
  }
  resolveByThread(roomId: string, root: string): ThreadMapping | null {
    return this.store.read().threads.find((m) => m.roomId === roomId && m.threadRootEventId === root) ?? null;
  }
  recordEvent(roomId: string, eventId: string, root: string): void {
    const state = this.store.read();
    this.store.write({ ...state, events: { ...state.events, [JSON.stringify([roomId, eventId])]: root } });
  }
  resolveByEvent(roomId: string, eventId: string): ThreadMapping | null {
    const root = this.store.read().events?.[JSON.stringify([roomId, eventId])]
      ?? this.question(roomId, eventId)?.threadRootEventId ?? eventId;
    return this.resolveByThread(roomId, root);
  }
  resolveByConversation(human: string, seat: string, conversationId: string, roomId: string): ThreadMapping | null {
    return [...this.store.read().threads].reverse().find((m) => m.human === human && m.seat === seat && m.conversationId === conversationId && m.roomId === roomId && m.state === "open") ?? null;
  }
  close(roomId: string, root: string): void {
    const state = this.store.read();
    this.store.write({ ...state, threads: state.threads.map((m) => m.roomId === roomId && m.threadRootEventId === root ? { ...m, state: "closed" } : m) });
  }
  recordQuestion(mapping: QuestionMapping): void {
    const state = this.store.read();
    if (this.question(mapping.roomId, mapping.eventId)) return;
    this.store.write({ ...state, questions: [...state.questions, mapping] });
  }
  question(roomId: string, eventId: string): QuestionMapping | null {
    return this.store.read().questions.find((q) => q.roomId === roomId && q.eventId === eventId) ?? null;
  }
}
