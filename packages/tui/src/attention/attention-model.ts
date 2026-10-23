import type { AttentionRead, AttentionItem } from "@openrig/daemon/attention";
import type { Action, FleetSnapshot, ViewState } from "../types.js";
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
  read.items.sort((a, b) => a.kind.localeCompare(b.kind) || (a.kind === "update" ? ((b.id.startsWith("queue-update:") && b.urgency === "critical" ? 2 : b.urgency === "urgent" ? 1 : 0) - (a.id.startsWith("queue-update:") && a.urgency === "critical" ? 2 : a.urgency === "urgent" ? 1 : 0)) : 0) || (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
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
      lines.push(...questionLines(d.item).map(text => ({ text })));
      lines.push(...d.lines.map(text => ({ text })));
      for (const f of d.files) lines.push(listItem(f.label, { type: "attention-source", path: f.path }));
      // Answer it here, on this row, as the person: Steering's Approve, or, for an ask with questions (Approve would close it
      // without returning them), one act per open option, or, once every question is answered and the answers haven't gone
      // back yet, the act that sends them. While a question is open, or with none, `reply` takes their own words.
      const qitemId = d.item.id.startsWith("queue:") ? d.item.id.slice("queue:".length) : null;
      if (d.item.answer && qitemId) {
        const { verb, actorSession } = d.item.answer;
        const open = (d.item.humanQuestions ?? []).filter(q => answerOf(d.item, q.id) == null);
        if (verb === "approve") {
          lines.push(listItem(`Approve as ${actorSession} (closes this request, as Steering's Approve does)`, { type: "act", act: "answer", qitemId, verb, actorSession }));
        } else if (!open.length) {
          lines.push(listItem(`Send the recorded answers back to ${d.item.asker ?? "the asker"} and close this request`, { type: "act", act: "answer", qitemId, verb, actorSession }));
        } else {
          for (const q of open)
            for (const o of q.options) lines.push(listItem(`Answer "${q.question}": ${o.label}${o.recommended ? " (recommended)" : ""}`,
              { type: "act", act: "answer", qitemId, verb, actorSession, questionId: q.id, optionId: o.id }));
        }
        if (verb === "approve" || open.length) {
          lines.push({ text: `Or answer in your own words: reply <text>, as ${actorSession}${verb === "answer" ? " (it fills the first unanswered question and closes the request)" : ""}.` });
        }
      }
      // Chat, as on the Feed card: open the asker's terminal (its pod's view) to answer in your own words.
      if (d.item.asker) {
        const view = podViewOf(snap, d.item.asker);
        lines.push(view ? listItem(`Chat with ${d.item.asker} (opens its terminal)`, { type: "act", act: "open-terminal", view })
          : { text: `Chat: ${d.item.asker} isn't in this instance's loaded topology.` });
      }
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
        if (i.humanQuestions?.length) lines.push({ text: `    Questions: ${i.humanQuestions.length}, ${unansweredCount(i)} unanswered` });
        if (i.id.startsWith("human-update:") || i.id.startsWith("queue-update:")) lines.push({ text: "    No action needed" });
        if (i.unblocks) lines.push({ text: `    Unblocks: ${i.unblocks}` });
        lines.push({ text: `    ${i.scope} · ${i.at ?? "time unknown"}` });
      }
    }
    lines.push({ text: "" }, { text: `Read at ${read.readAt}` }, ...read.sources.map(s => ({ text: `${s.source}: ${s.state} · ${s.detail}` })));
  }
  lines.push({ text: "" }, { text: "Viewing is not approval. Each request's detail says whether it went to Slack and where to answer it." });
  return wrapDetailLines(lines, width);
}

/** The `reply` command on the open request: the person's own words, answered on that row as the person the Feed served. */
export function replyAct(read: AttentionRead | null | undefined, openId: string | null | undefined, text: string): Action {
  const item = read?.detail?.item;
  if (!item?.answer || item.id !== openId || !item.id.startsWith("queue:") || !text.trim()) {
    return { type: "notice", message: "reply answers the open request addressed to a person: open it in the Feed, then reply <your words>." };
  }
  return { type: "act", act: "answer", qitemId: item.id.slice("queue:".length), verb: "answer", actorSession: item.answer.actorSession, decision: text.trim() };
}

/** A question's recorded answer, by own key only (a question id like "constructor" isn't an answer). */
function answerOf(item: AttentionItem, questionId: string) {
  const answers = item.humanAnswers ?? {};
  return Object.prototype.hasOwnProperty.call(answers, questionId) ? answers[questionId] : undefined;
}

function unansweredCount(item: AttentionItem): number {
  return (item.humanQuestions ?? []).filter(q => answerOf(item, q.id) == null).length;
}

/** The row's questions and options, and what's recorded for each. */
function questionLines(item: AttentionItem): string[] {
  if (!item.humanQuestions?.length) return [];
  return ["Questions:", ...item.humanQuestions.flatMap((q, n) => {
    const answer = answerOf(item, q.id);
    const state = answer == null ? "unanswered" : typeof answer === "string"
      ? `answered: ${q.options.find(o => o.id === answer)?.label ?? answer}` : `answered in their words: ${answer.text}`;
    return [`${n + 1}. ${q.question} (${state})`, `   Options: ${q.options.map(o => o.recommended ? `${o.label} (recommended)` : o.label).join(" · ")}`];
  })];
}

/** The terminal view that holds a local seat: its pod, the agents table's own `term ▸` view. */
function podViewOf(snap: FleetSnapshot, session: string): string | null {
  for (const host of snap.hosts.filter(h => (h.id ?? "local") === "local"))
    for (const rig of host.rigs) for (const pod of rig.pods)
      if (pod.agents.some(a => a.session === session)) return `pod:${rig.name}/${pod.name}`;
  return null;
}
