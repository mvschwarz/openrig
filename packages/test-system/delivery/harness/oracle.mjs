// What the receiver got, read from the stand-in's request log: the receiver-side truth every case judges by.
//
// A delivery is a user item in the seat's own conversation whose typed text holds the case's marker: a user message
// (Claude Code) or a user input item (Codex), read from the history of the latest request in the seat's thread. Each
// item counts once, however many requests repeat it. Requests repeat history all the time: every turn resends it, a
// retry resends the same request, and Codex re-requests a running turn with the newly typed message added after it.
// The seat's conversation is found positively: the thread whose request carries OpenRig's identity prompt for this rig,
// the first turn every seat gets. Only that thread's requests that offer tools and don't ask for a JSON-schema answer
// are the conversation. Deliberately not deliveries:
//   - a side request, in another thread or in the same one (Codex's task title; a no-tools request a program sends
//     under its session id), even when it quotes the typed text;
//   - a marker quoted inside some other item (only typed parts count, never a tool's output).
// When no thread can be identified, there's no conversation to judge: callers treat that as NOT RUN, never as empty.
// Two sends inside one item is a merge; order is the items' order in the conversation.

import { createHash } from "node:crypto";

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** OpenRig's identity prompt for the cell's rig, as a seat's first turn carries it. */
export const IDENTITY = /OpenRig session identity:\s*\n- rig: dlv\b/;

/** A request the conversation is made of: it offers the seat's tools and isn't asking for a JSON-schema answer. */
const isConversationRequest = (r) => r.body && typeof r.body === "object" && !r.served && r.request?.tools > 0 && !r.request?.structuredOutput;

/** Every distinct thread whose conversation requests carry OpenRig's identity prompt, in first-seen order. */
export function anchoredThreads(requests) {
  return [...new Set(requests.filter((r) => isConversationRequest(r) && r.request.thread
    && userItems(r.body).some((parts) => parts.some((p) => p.source === "text" && IDENTITY.test(p.text)))).map((r) => r.request.thread))];
}

/** The seat's conversation thread: the one thread carrying OpenRig's identity prompt. Null when none does, and when
 *  more than one does (a second seat generation, a fork): the conversation is then ambiguous, never guessed. */
export function seatThread(requests) {
  const anchored = anchoredThreads(requests);
  return anchored.length === 1 ? anchored[0] : null;
}

const textOf = (blocks, types) => (Array.isArray(blocks) ? blocks : []).filter((b) => types.includes(b?.type) && typeof b.text === "string").map((b) => b.text);

/** A request's user items, each as its parts: { text, source: "text" | "tool_result" }. */
export function userItems(body) {
  if (Array.isArray(body?.messages)) {
    return body.messages.filter((m) => m?.role === "user").map((m) => typeof m.content === "string" ? [{ text: m.content, source: "text" }]
      : (Array.isArray(m.content) ? m.content : []).flatMap((b) => b?.type === "text" ? [{ text: b.text, source: "text" }]
        : b?.type === "tool_result" ? (typeof b.content === "string" ? [{ text: b.content, source: "tool_result" }] : textOf(b.content, ["text"]).map((text) => ({ text, source: "tool_result" })))
        : []));
  }
  if (Array.isArray(body?.input)) {
    return body.input.filter((it) => (it?.type === "message" || it?.type === undefined) && it?.role === "user")
      .map((it) => typeof it.content === "string" ? [{ text: it.content, source: "text" }] : textOf(it.content, ["input_text", "text"]).map((text) => ({ text, source: "text" })));
  }
  return [];
}

const itemKey = (parts) => sha256(parts.map((p) => `${p.source}:${p.text}`).join("\u0000"));

/** The seat's conversation as the program last sent it: each user item once, in order, with the request it first
 *  arrived in and how many requests carried it. */
export function conversation(requests) {
  const thread = seatThread(requests);
  if (!thread) return { thread: null, identified: false, anchored: anchoredThreads(requests), items: [] };
  const inThread = requests.filter((r) => isConversationRequest(r) && r.request.thread === thread);
  const last = inThread.at(-1);
  if (!last) return { thread, identified: true, items: [] };
  const firstSeen = new Map();
  const carried = new Map();
  for (const r of inThread) {
    for (const parts of userItems(r.body)) {
      const key = itemKey(parts);
      if (!firstSeen.has(key)) firstSeen.set(key, r);
      carried.set(key, (carried.get(key) ?? 0) + 1);
    }
  }
  const items = userItems(last.body).map((raw, index) => {
    const key = itemKey(raw);
    const first = firstSeen.get(key);
    const parts = raw.map((p) => ({ ...p, bytes: Buffer.byteLength(p.text, "utf8"), sha256: sha256(p.text) }));
    return { index, seq: first.seq, at: first.at, kind: parts.some((p) => p.source === "tool_result") ? "tool_result" : "user", parts, carriedBy: carried.get(key) };
  });
  return { thread, identified: true, lastSeq: last.seq, items };
}

/** The user items that carry `marker` in a typed part (not a tool's output), in conversation order. `turns` is kept
 *  as the name cases use. */
export function deliveriesOf(requests, marker) {
  const { thread, identified, items } = conversation(requests);
  return { thread, identified, turns: items.filter((item) => item.parts.some((p) => p.source === "text" && p.text.includes(marker))) };
}

/** Several sends judged together: each one's items, which items hold more than one of the case's markers (a merge),
 *  and whether the sends' first items come in send order. Identity and order are the items' positions in the
 *  conversation, never the request they were first seen in: Codex can add two new messages to one request. */
export function orderAndMerge(requests, markers, pattern) {
  const each = markers.map((m) => deliveriesOf(requests, m).turns);
  const first = each.map((items) => items[0] ?? null);
  const merged = first.filter(Boolean).filter((item, i, all) => all.findIndex((o) => o.index === item.index) === i && markersIn(item, pattern).length > 1)
    .map((item) => ({ index: item.index, markers: markersIn(item, pattern) }));
  const positions = first.map((item) => item?.index ?? Infinity);
  const inOrder = first.every(Boolean) && positions.every((p, i) => i === 0 || p > positions[i - 1]);
  return { each, first, merged, positions, inOrder };
}

/** The typed part that holds `marker` in an item, and whether `body` arrived in it byte for byte. */
export function partWith(turn, marker, body) {
  const part = turn.parts.find((p) => p.source === "text" && p.text.includes(marker)) ?? null;
  return { part, intact: part !== null && body !== undefined && part.text.includes(body) };
}

/** Program transforms Quality has ruled to be the program's own rewrite of pasted input, as expected.yaml lists them
 *  under program_transforms: each pinned to the versions it was observed on, and applied only as its exact inverse. */
export const PROGRAM_TRANSFORMS = [
  { id: "claude-code-tab-expansion", program: "claude", versions: ["2.1.322"], rewrite: (text) => text.replaceAll("\t", "    ") },
];

/** Whether `body` arrived intact in `part`, exactly or through one listed transform. A transform counts only when the
 *  part holds the rewritten body AND undoing it restores bytes OpenRig itself recorded writing (one of `wireSha256s`).
 *  Any other difference is a mismatch: a new, unlisted rewrite fails until Quality lists it. */
export function arrivedAs(part, body, { kind, version, wireSha256s = [] }) {
  if (!part) return { intact: false, transform: null };
  if (part.text.includes(body)) return { intact: true, transform: null };
  for (const t of PROGRAM_TRANSFORMS) {
    if (t.program !== kind || !t.versions.includes(version)) continue;
    const rewritten = t.rewrite(body);
    if (rewritten === body || !part.text.includes(rewritten)) continue;
    const restored = part.text.replace(rewritten, body);
    if (wireSha256s.includes(sha256(restored))) return { intact: true, transform: t.id, restoredSha256: sha256(restored) };
  }
  return { intact: false, transform: null };
}

/** Every marker of the case pattern in an item's typed parts: two in one item is a merge. */
export function markersIn(turn, pattern) {
  const re = new RegExp(pattern, "g");
  return turn.parts.filter((p) => p.source === "text").flatMap((p) => p.text.match(re) ?? []);
}

/** A judged cell. `checks` keep every assertion with what was seen, so a reader sees why, not only the verdict. */
export class Verdict {
  constructor() { this.checks = []; this.notRun = null; this.transforms = new Set(); }
  check(name, ok, seen) { this.checks.push({ name, ok: !!ok, seen }); return !!ok; }
  info(name, seen) { this.checks.push({ name, ok: null, seen }); }
  skip(reason) { this.notRun = reason; }
  /** A listed program transform this cell needed: the PASS names it, so the content limit stays visible. */
  transformed(id) { this.transforms.add(id); }
  get result() {
    if (this.notRun) return "NOT RUN";
    if (!this.checks.every((c) => c.ok !== false)) return "FAIL";
    return this.transforms.size ? `PASS (program transform: ${[...this.transforms].join(", ")})` : "PASS";
  }
  toJSON() {
    return { result: this.result, ...(this.notRun ? { reason: this.notRun } : {}),
      failed: this.checks.filter((c) => c.ok === false).map((c) => c.name), checks: this.checks };
  }
}
