import type { AttentionRead, AttentionItem } from "@openrig/daemon/attention";
import type { FleetSnapshot, ViewState } from "../types.js";
import { listItem, wrapDetailLines, type ContentLine } from "../detail.js";

/** The bounded, confirmed-delivery projection served by S02; no client classification. */
export interface DeliveredHumanUpdates {
  items: Array<{ qitemId: string; summary: string | null; body: string; humanDetail: string | null;
    destinationSession: string; sourceSession: string; tags: string[] | null; evidenceRef: string | null;
    deliveredAt: string; deliveryReceipt: string }>;
  limit: number;
  truncated: boolean;
}

export function composeHumanUpdates(attention: AttentionRead | null, updates: DeliveredHumanUpdates | null, wanted?: string | null): AttentionRead | null {
  if (!attention && !updates) return null;
  const read: AttentionRead = attention ? { ...attention, items: [...attention.items], sources: [...attention.sources] } : {
    scope: "instance", readAt: new Date().toISOString(), items: [], detail: null, detailError: null,
    sources: [{ source: "queue", state: "unavailable", detail: "Human requests have not answered." }, { source: "outcomes and health", state: "unavailable", detail: "Feed source unavailable." }],
  };
  read.sources.push({ source: "delivered updates", state: !updates ? "unavailable" : updates.truncated ? "partial" : "available",
    detail: updates ? `Latest ${updates.limit} confirmed delivered updates; retained receipt window${updates.truncated ? ", more omitted" : ""}.` : "Delivered updates have not answered." });
  for (const q of updates?.items ?? []) {
    const projects = [...new Set((q.tags ?? []).filter(t => t.startsWith("project:")).map(t => t.slice(8)))];
    const item: AttentionItem = { id: `human-update:${q.qitemId}`, kind: "update", summary: q.summary || q.body.trim().split(/\r?\n/).find(Boolean) || "Delivered update",
      recipient: q.destinationSession, urgency: "update", unblocks: null, at: q.deliveredAt,
      scope: projects.length === 1 ? `project ${projects[0]} (queue tag)` : "instance · project unknown", project: null,
      source: `/api/queue/${encodeURIComponent(q.qitemId)}` };
    if (!read.items.some(current => current.id === `queue-update:${q.qitemId}`)) read.items.push(item);
    if (wanted === item.id && read.detail?.item.id !== item.id) {
      read.detailError = null;
      read.detail = { item, lines: [q.body, ...(q.humanDetail ? ["Supplemental detail:", q.humanDetail] : []),
        `From: ${q.sourceSession}`, `Delivered: ${q.deliveredAt}`, `Delivery receipt: ${q.deliveryReceipt}`, `Queue: ${q.qitemId}`, `Evidence: ${q.evidenceRef ?? "none recorded"}`],
        files: q.evidenceRef?.startsWith("/") ? [{ label: "Update evidence", path: q.evidenceRef }] : [] };
    }
  }
  read.items.sort((a, b) => a.kind.localeCompare(b.kind) || (a.kind === "update" ? Number(b.urgency === "urgent") - Number(a.urgency === "urgent") : 0) || (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
  if (wanted?.startsWith("human-update:") && read.detail?.item.id !== wanted) {
    read.detail = null;
    read.detailError = "Selected delivered update is unavailable or outside the retained window. Return to Feed and refresh.";
  }
  return read;
}

export function attentionLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const read = snap.attentionRead;
  const lines: ContentLine[] = [{ text: "FEED · Instance / All humans" }];
  if (!read) return wrapDetailLines([...lines, { text: "Unavailable: Feed sources have not answered." }, ...snap.readErrors.map(text => ({ text }))], width);
  if (state.attentionOpen) {
    const d = read.detail;
    lines.push(listItem("Back", { type: "back" }));
    if (!d || d.item.id !== state.attentionOpen) lines.push({ text: read.detailError ?? "Selected source unavailable." });
    else {
      const title = read.items.some(i => i.id === d.item.id) ? d.item.kind === "action" ? "Human requests" : "Update" : "Source record";
      lines.push({ text: `${title} · ${d.item.urgency}` }, { text: d.item.summary });
      if (d.item.recipient) lines.push({ text: `To: ${d.item.recipient}` });
      if (d.item.id.startsWith("human-update:") || d.item.id.startsWith("queue-update:")) lines.push({ text: "No action needed" });
      if (d.item.unblocks) lines.push({ text: `Unblocks: ${d.item.unblocks}` });
      lines.push({ text: `Scope: ${d.item.scope}` }, { text: `Observed: ${d.item.at ?? "unknown"}` });
      lines.push(...d.lines.map(text => ({ text })));
      for (const f of d.files) lines.push(listItem(f.label, { type: "attention-source", path: f.path }));
      lines.push({ text: `Source: ${d.item.source}` });
    }
  } else {
    const bad = read.sources.filter(s => s.state !== "available");
    if (bad.length) lines.push({ text: "Some sources unavailable or partial; this feed is incomplete." });
    for (const [kind, title] of [["action", "Human requests"], ["update", "Updates"]] as const) {
      if (state.attentionCategory && state.attentionCategory !== kind) continue;
      lines.push({ text: "" }, { text: title });
      const items = read.items.filter(i => i.kind === kind && (!state.filter || `${i.summary} ${i.scope}`.toLowerCase().includes(state.filter.toLowerCase())));
      if (!items.length) lines.push({ text: state.filter ? "  No matches in the served items." : bad.some(s => kind === "action" ? s.source === "queue" : s.source !== "queue") ? "  Unknown: a required source is unavailable or partial." : "  No current items in the available source window." });
      for (const i of items) {
        lines.push(listItem(`[${i.urgency}] ${i.summary}`, { type: "attention-open", id: i.id }));
        if (i.recipient) lines.push({ text: `    To: ${i.recipient}` });
        if (i.id.startsWith("human-update:") || i.id.startsWith("queue-update:")) lines.push({ text: "    No action needed" });
        if (i.unblocks) lines.push({ text: `    Unblocks: ${i.unblocks}` });
        lines.push({ text: `    ${i.scope} · ${i.at ?? "time unknown"}` });
      }
    }
    lines.push({ text: "" }, { text: `Read at ${read.readAt}` }, ...read.sources.map(s => ({ text: `${s.source}: ${s.state} · ${s.detail}` })));
  }
  lines.push({ text: "" }, { text: "Viewing is not approval. Required Slack decisions still apply." });
  return wrapDetailLines(lines, width);
}
