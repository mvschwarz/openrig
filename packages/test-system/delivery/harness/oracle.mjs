// What the receiver got, read from the stand-in's request log: the receiver-side truth every case judges by.
//
// A delivery is a user item in the seat's own conversation whose typed text holds the case's marker: a user message
// (Claude Code) or a user input item (Codex), read from the history of the latest request in the seat's thread. Each
// item counts once, however many requests repeat it. Requests repeat history all the time: every turn resends it, a
// retry resends the same request, and Codex re-requests a running turn with the newly typed message added after it.
// Deliberately not deliveries:
//   - a side request in another thread (Codex asks for a task title with the typed text quoted in its prompt);
//   - a marker quoted inside some other item (only typed parts count, never a tool's output).
// Two sends inside one item is a merge.

import { createHash } from "node:crypto";

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The seat's conversation: the thread most of its tool-offering requests name. */
export function seatThread(requests) {
  const counts = new Map();
  for (const r of requests) {
    const thread = r.request?.thread;
    if (thread && r.request.tools > 0) counts.set(thread, (counts.get(thread) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
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
  const inThread = requests.filter((r) => r.body && typeof r.body === "object" && !r.served && (r.request?.thread ?? null) === thread);
  const last = inThread.at(-1);
  if (!last) return { thread, items: [] };
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
  return { thread, lastSeq: last.seq, items };
}

/** The user items that carry `marker` in a typed part (not a tool's output), in conversation order. `turns` is kept
 *  as the name cases use. */
export function deliveriesOf(requests, marker) {
  const { thread, items } = conversation(requests);
  return { thread, turns: items.filter((item) => item.parts.some((p) => p.source === "text" && p.text.includes(marker))) };
}

/** The typed part that holds `marker` in an item, and whether `body` arrived in it byte for byte. */
export function partWith(turn, marker, body) {
  const part = turn.parts.find((p) => p.source === "text" && p.text.includes(marker)) ?? null;
  return { part, intact: part !== null && body !== undefined && part.text.includes(body) };
}

/** Every marker of the case pattern in an item's typed parts: two in one item is a merge. */
export function markersIn(turn, pattern) {
  const re = new RegExp(pattern, "g");
  return turn.parts.filter((p) => p.source === "text").flatMap((p) => p.text.match(re) ?? []);
}

/** A judged cell. `checks` keep every assertion with what was seen, so a reader sees why, not only the verdict. */
export class Verdict {
  constructor() { this.checks = []; this.notRun = null; }
  check(name, ok, seen) { this.checks.push({ name, ok: !!ok, seen }); return !!ok; }
  info(name, seen) { this.checks.push({ name, ok: null, seen }); }
  skip(reason) { this.notRun = reason; }
  get result() {
    if (this.notRun) return "NOT RUN";
    return this.checks.every((c) => c.ok !== false) ? "PASS" : "FAIL";
  }
  toJSON() {
    return { result: this.result, ...(this.notRun ? { reason: this.notRun } : {}),
      failed: this.checks.filter((c) => c.ok === false).map((c) => c.name), checks: this.checks };
  }
}
