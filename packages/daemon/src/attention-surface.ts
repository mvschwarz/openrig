import type { HumanAnswers, HumanQuestion } from "./domain/human-questions.js";

/** Passive projection over queue, native proof judgments and canonical health. */
export interface AttentionItem {
  id: string;
  kind: "action" | "update";
  summary: string;
  unblocks: string | null;
  urgency: string;
  at: string | null;
  scope: string;
  project: { id: string; root: string } | null;
  source: string;
  recipient?: string | null;
  /** How the person answers this request where they read it, through mission control as themselves: `approve` (Steering's
   *  one-tap Approve), or `answer` for an ask with questions, which Approve would close without returning their answers.
   *  `answer` takes a choice or their own words, or sends a complete set's recorded answers back, and the answer goes back
   *  to the asker as Slack's answers do. */
  answer?: { verb: "approve" | "answer"; actorSession: string };
  /** The seat that asked, which the person can open to answer in their own words (the Feed card's Chat). */
  asker?: string;
  /** The row's questions and the answers recorded so far, as the queue row holds them. */
  humanQuestions?: HumanQuestion[];
  humanAnswers?: HumanAnswers;
}
export interface AttentionDetail {
  item: AttentionItem;
  lines: string[];
  files: Array<{ label: string; path: string }>;
}
export interface AttentionRead {
  scope: "instance";
  readAt: string;
  items: AttentionItem[];
  sources: Array<{ source: string; state: "available" | "unavailable" | "partial"; detail: string }>;
  detail: AttentionDetail | null;
  detailError: string | null;
}

// Consumers must use the same lexical human classification as queue selection.
export { isHumanSeatSessionRef } from "./domain/session-name.js";
