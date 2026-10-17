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

/** Keep priority ordering when clients compose queue, delivery and outcome sources. */
export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const rank = (urgency: string) => urgency === "critical" ? 0 : urgency === "urgent" ? 1 : 2;
  return a.kind.localeCompare(b.kind) || rank(a.urgency) - rank(b.urgency)
    || (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id);
}

// Consumers must use the same lexical human classification as queue selection.
export { isHumanSeatSessionRef } from "./domain/session-name.js";
