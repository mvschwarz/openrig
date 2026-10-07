// #899 — an emoji reaction on an ask reaches the seat that asked, as a fact that seat
// interprets: who reacted, with which emoji, on which ask. It neither answers nor closes the
// ask. A reaction on any other message is ignored.
import { describe, it, expect } from "vitest";
import { InboundRouter, ingestDecision, handleEnvelope, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";

function memFs() {
  const files = new Map<string, string>();
  return {
    readFileSync: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    existsSync: (p: string) => files.has(p),
    writeFileSync: (p: string, d: string) => { files.set(p, d); },
    appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (a: string, b: string) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-10-07T07:00:00Z");

interface Landed { qitemId: string; source: string; destination: string; tags: string[]; summary: string; body: string }

function harness(opts: { admitted?: boolean; failCreates?: number; newerRoot?: string } = {}) {
  const fs = memFs();
  const rows: Landed[] = [];
  const resolved: string[] = [];
  const logs: string[] = [];
  let failures = opts.failCreates ?? 0;
  // One ask, posted as the root 400.0 of conversation qitem-ask-1 and owned by asker@rig.
  const threadMap = {
    resolveByThread: (ts: string) => ts === "400.0" ? { seat: "asker@rig", conversationId: "qitem-ask-1", threadTs: ts, state: "open" } : null,
    resolveByConversation: () => opts.newerRoot ? { threadTs: opts.newerRoot } : null,
  } as never;
  const deadLetter = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
  const router = new InboundRouter({
    queue: {
      createQitem: async (input: Landed) => {
        if (failures > 0) { failures--; throw new Error("queue unavailable"); }
        if (!rows.some((row) => row.qitemId === input.qitemId)) rows.push(input);
        return input.qitemId;
      },
    },
    seen: new SeenStore("/s.jsonl", fs, clock),
    deadLetter,
    destination: "operator-agent@kernel",
    resolveSender: () => opts.admitted === false ? { admitted: false, teaching: "not registered" } : { admitted: true, source: "founder@humans" },
    resolveRoute: makeThreadRouteResolver({ map: threadMap, unroutedDestination: "orch-lead@team", log: (m: string) => logs.push(m) }),
    resolveHumanReply: async (input: { qitemId: string }) => { resolved.push(input.qitemId); return "resolved"; },
    log: (m: string) => logs.push(m),
  } as never);
  return { router, rows, resolved, deadLetter, logs };
}

const reaction = (over?: Partial<SlackEvent>): SlackEvent => ({
  type: "reaction_added",
  user: "U1",
  reaction: "white_check_mark",
  item: { type: "message", channel: "C1", ts: "400.0" },
  event_ts: "401.0",
  ...over,
});
const deliver = (h: ReturnType<typeof harness>, ev: SlackEvent) =>
  handleEnvelope({ envelope_id: "env-1", type: "events_api", payload: { event: ev } }, () => {}, h.router);

describe("#899 reactions on an ask", () => {
  it("reach the seat that asked, naming who reacted, the emoji and the ask, without answering it", async () => {
    const h = harness();
    expect(await deliver(h, reaction())).toEqual({ status: "accepted", reason: "reaction" });
    expect(h.rows).toHaveLength(1);
    const row = h.rows[0]!;
    expect(row).toMatchObject({ source: "founder@humans", destination: "asker@rig" });
    expect(row.tags).toContain("human-reaction");
    expect(row.summary).toBe("Founder via Slack: reacted :white_check_mark: to qitem-ask-1");
    expect(row.body).toContain("founder@humans reacted :white_check_mark: to your ask qitem-ask-1");
    expect(row.body).toContain("doesn't answer or close the ask");
    // The seat decides what the reaction means; nothing resolves the ask for it.
    expect(h.resolved).toEqual([]);
  });

  it("land once when Slack redelivers an event, and each new reaction is its own row", async () => {
    const h = harness();
    await deliver(h, reaction());
    expect(await deliver(h, reaction())).toEqual({ status: "ignored", reason: "dup" });
    await deliver(h, reaction({ reaction: "eyes", event_ts: "402.0" }));
    expect(h.rows.map((row) => row.summary)).toEqual([
      "Founder via Slack: reacted :white_check_mark: to qitem-ask-1",
      "Founder via Slack: reacted :eyes: to qitem-ask-1",
    ]);
  });

  it("on an older root of the same ask still reach its seat", async () => {
    const h = harness({ newerRoot: "450.0" });
    expect(await deliver(h, reaction())).toEqual({ status: "accepted", reason: "reaction" });
    expect(h.rows[0]).toMatchObject({ destination: "asker@rig", summary: "Founder via Slack: reacted :white_check_mark: to qitem-ask-1" });
  });

  it("are ignored on any message that isn't an ask, with no row for anyone", async () => {
    const h = harness();
    expect(await deliver(h, reaction({ item: { type: "message", channel: "C1", ts: "999.0" } }))).toEqual({ status: "ignored", reason: "not-an-ask" });
    expect(h.rows).toEqual([]);
    // The log says it was ignored, not that it went to the unrouted-signal destination.
    expect(h.logs.some((m) => m.includes("unrouted-signal"))).toBe(false);
    expect(h.logs.some((m) => m.includes("reaction ignored"))).toBe(true);
  });

  it("from an unregistered person are refused", async () => {
    const h = harness({ admitted: false });
    expect(await deliver(h, reaction())).toEqual({ status: "refused", reason: "unregistered" });
    expect(h.rows).toEqual([]);
  });

  it("are admitted only when a person reacted to a message", () => {
    expect(ingestDecision(reaction())).toEqual({ ingest: true });
    expect(ingestDecision(reaction({ item: { type: "file", ts: "400.0" } }))).toEqual({ ingest: false, reason: "reaction-target" });
    expect(ingestDecision(reaction({ user: undefined }))).toEqual({ ingest: false, reason: "no-user" });
  });

  it("survive a failed create: dead-lettered, then landed once by the retry", async () => {
    const h = harness({ failCreates: 1 });
    expect(await deliver(h, reaction())).toEqual({ status: "dead-lettered", reason: "create_failed" });
    expect(h.deadLetter.readAll()).toHaveLength(1);
    expect(await h.router.retryDeadLetters()).toEqual({ retried: 1, landed: 1 });
    expect(h.rows).toHaveLength(1);
    expect(h.deadLetter.readAll()).toHaveLength(0);
  });
});
