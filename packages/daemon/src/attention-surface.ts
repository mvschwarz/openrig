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
  /** How the person answers this request where they read it: the same mission-control verb and actor Steering uses. */
  answer?: { verb: "approve"; actorSession: string };
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
