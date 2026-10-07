// #897 — a human ask longer than one Slack message is delivered as numbered replies in the
// primary's thread instead of being refused, and an ask that still can't be posted tells the
// seat that asked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SLACK_SECTION_CAP, SLACK_TEXT_CAP, splitForSlack, escapeSlackText } from "../src/domain/gateway/slack/message.js";
import { MAX_HUMAN_MESSAGE_PARTS, subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: "human-founder@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Approve the rollout plan?", evidenceRef: "/private/retained-proof.md", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const unescape = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const NOTE = "\n\nThe rest of this brief follows in this thread.";

// Paragraphs, Slack control characters and astral characters, over four messages long.
const paragraph = (n: number) => `Paragraph ${n}: the plan touches <service> & its users 😀 and needs a yes. `.repeat(12);
const longBody = `${Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join("\n\n")}\nAction: approve or hold.`;

type Post = { text: string; blocks: Array<{ type: string; text?: { text: string } }>; thread_ts?: string };

describe("long human asks (#897)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "long-human-ask-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const stores = (name: string) => ({
    delivered: new SeenStore(join(home, `${name}-delivered`)),
    attempted: new SeenStore(join(home, `${name}-attempted`)),
    outboundSeen: new SeenStore(join(home, `${name}-seen`)),
  });
  const decision = (id: string, payload: Record<string, unknown>): OutboundDecision =>
    ({ kind: "outbound_decision", decisionId: id, op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: `q-${id}`, ...payload } });
  const recorder = (posts: Post[]): FetchImpl => async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return reply({ ok: true, ts: `${posts.length}.1` });
  };

  it("posts a brief over one message's limit as numbered thread replies, losing nothing", async () => {
    const posts: Post[] = [];
    const onPosted = vi.fn();
    const questions = [{ id: "go", question: "Roll out?", options: [{ id: "yes", label: "Yes" }, { id: "hold", label: "Hold" }] }];
    const deliver = subsystemSlackDeliver({ ...stores("long"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl: recorder(posts), onPosted });
    expect(await deliver(decision("long", { body: longBody, humanQuestions: questions }))).toEqual({ ok: true });

    expect(posts.length).toBeGreaterThan(3);
    expect(posts[0]!.thread_ts).toBeUndefined();
    for (const p of posts.slice(1)) expect(p.thread_ts).toBe("1.1");
    for (const p of posts) {
      expect(p.text.length).toBeLessThanOrEqual(SLACK_TEXT_CAP);
      for (const b of p.blocks) if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_CAP);
      expect(p.text).not.toContain("�");
    }
    // The options stay on the primary; each reply is numbered.
    expect(posts[0]!.blocks.some((b) => b.type === "actions")).toBe(true);
    expect(posts.slice(1).some((p) => p.blocks.some((b) => b.type === "actions"))).toBe(false);
    posts.slice(1).forEach((p, i) => expect(p.text).toContain(`Continued (${i + 2} of ${posts.length})`));
    // Joined back, the parts are the whole brief.
    const bodies = posts.map((p) => unescape(p.blocks[1]!.text!.text));
    expect(bodies[0]!.endsWith(NOTE)).toBe(true);
    expect([bodies[0]!.slice(0, -NOTE.length), ...bodies.slice(1)].join("")).toBe(longBody);
    expect(onPosted).toHaveBeenCalledOnce();
  });

  it("leaves a brief that fits exactly as before: one message, no thread", async () => {
    const posts: Post[] = [];
    const deliver = subsystemSlackDeliver({ ...stores("short"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl: recorder(posts) });
    expect(await deliver(decision("short", { body: "Why: restores status. Approve or hold?" }))).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.thread_ts).toBeUndefined();
    expect(posts[0]!.text).not.toContain("follows in this thread");
  });

  it("splits a long supplemental detail the same way after the brief", async () => {
    const posts: Post[] = [];
    const deliver = subsystemSlackDeliver({ ...stores("detail"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl: recorder(posts) });
    const detail = "Background line with <context> & numbers.\n".repeat(150);
    expect(await deliver(decision("detail", { body: "Approve or hold?", humanDetail: detail }))).toEqual({ ok: true });
    expect(posts.length).toBeGreaterThan(2);
    // The brief fits, so the primary keeps the usual note.
    expect(unescape(posts[0]!.blocks[1]!.text!.text)).toBe("Approve or hold?\n\nSupplemental detail follows in this thread.");
    expect(posts[1]!.text).toContain(`Supplemental detail (1 of ${posts.length - 1})`);
    const pieces = posts.slice(1).map((p) => unescape(p.blocks[1]!.text!.text)).join("");
    expect(pieces).toBe(detail.trimEnd());
  });

  it("resumes an interrupted delivery without posting any part twice", async () => {
    const posted: Post[] = [];
    let calls = 0;
    const fetchImpl: FetchImpl = async (url, init) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: posted });
      calls++;
      if (calls === 3) throw new Error("synthetic timeout");
      const msg = { ...JSON.parse(String(init?.body)), ts: `${calls}.1` };
      posted.push(msg);
      return reply({ ok: true, ts: msg.ts });
    };
    const opts = { ...stores("resume"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl };
    expect((await subsystemSlackDeliver(opts)(decision("resume", { body: longBody }))).ok).toBe(false);
    expect(await subsystemSlackDeliver(opts)(decision("resume", { body: longBody }))).toEqual({ ok: true });
    const markers = posted.map((p) => p.text.match(/\(or-mark:[^)]+\)/)![0]);
    expect(new Set(markers).size).toBe(markers.length);
    expect(posted.length).toBe(calls - 1);
  });

  it("keeps the same cuts when the mention changes between an interrupted attempt and its retry", async () => {
    const posted: Post[] = [];
    let calls = 0;
    const fetchImpl: FetchImpl = async (url, init) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: posted });
      calls++;
      if (calls === 3) throw new Error("synthetic 429");
      const msg = { ...JSON.parse(String(init?.body)), ts: `${calls}.1` };
      posted.push(msg);
      return reply({ ok: true, ts: msg.ts });
    };
    // A long subject makes the complete-fallback budget, not the section cap, set the primary's room.
    let mention: string | undefined;
    const opts = { ...stores("mention"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl, resolveMentionUserId: () => mention };
    const ask = decision("mention", { body: longBody, summary: "Approve the plan? ".repeat(62) });
    expect((await subsystemSlackDeliver(opts)(ask)).ok).toBe(false);
    mention = "U0123456789";
    expect(await subsystemSlackDeliver(opts)(ask)).toEqual({ ok: true });
    // Joined back in posting order, the parts are the whole brief: nothing lost, nothing repeated.
    const bodies = posted.map((p) => unescape(p.blocks[1]!.text!.text));
    expect(bodies[0]!.endsWith(NOTE)).toBe(true);
    expect([bodies[0]!.slice(0, -NOTE.length), ...bodies.slice(1)].join("")).toBe(longBody);
  });

  it.each([
    ["none, then one", undefined, "U0123456789"],
    ["one, then none", "U0123456789", undefined],
  ])("keeps one message or a split when the mention changes between an interrupted attempt and its retry (mention %s)", async (_label, before, after) => {
    // A long subject makes the complete-fallback budget decide whether a brief fits in one message.
    const summary = "Approve the plan? ".repeat(62);
    const fitsBesideMention = async (length: number) => {
      const posts: Post[] = [];
      const id = `probe-${length}`;
      await subsystemSlackDeliver({ ...stores(id), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl: recorder(posts), resolveMentionUserId: () => "U0123456789" })(decision(id, { body: "a".repeat(length), summary }));
      return posts.length === 1;
    };
    // The shortest brief that doesn't fit in one message beside the mention.
    let fits = 0, splits = 6000;
    while (splits - fits > 1) { const mid = (fits + splits) >> 1; if (await fitsBesideMention(mid)) fits = mid; else splits = mid; }
    const body = "a".repeat(splits);

    const posted: Post[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: posted });
      const msg = { ...JSON.parse(String(init?.body)), ts: `${posted.length + 1}.1` };
      posted.push(msg);
      return reply({ ok: true, ts: msg.ts });
    };
    // The first attempt posts, then its receipt write fails, so the decision is retained for a retry.
    let receiptFails = true;
    const onPosted = () => { if (receiptFails) { receiptFails = false; throw new Error("synthetic receipt failure"); } };
    let mention = before;
    const opts = { ...stores("shape"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl, onPosted, resolveMentionUserId: () => mention };
    const ask = decision("shape", { body, summary });
    expect((await subsystemSlackDeliver(opts)(ask)).ok).toBe(false);
    mention = after;
    expect(await subsystemSlackDeliver(opts)(ask)).toEqual({ ok: true });
    // Joined back in posting order, the parts are the whole brief: nothing lost, nothing repeated.
    const bodies = posted.map((p) => unescape(p.blocks[1]!.text!.text));
    expect(bodies[0]!.endsWith(NOTE)).toBe(true);
    expect([bodies[0]!.slice(0, -NOTE.length), ...bodies.slice(1)].join("")).toBe(body);
  });

  it("redacts secrets before cutting, so no part carries a piece of one", async () => {
    const posts: Post[] = [];
    const deliver = subsystemSlackDeliver({ ...stores("secret"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl: recorder(posts) });
    // Assembled at run time so the fixture isn't flagged as a real token.
    const token = ["xoxb", "1234567890", "ABCDEFGHIJKLMNOP"].join("-");
    const body = Array.from({ length: 40 }, (_, i) => `${"a".repeat(140 + i)} ${token}`).join(" ");
    expect(await deliver(decision("secret", { body }))).toEqual({ ok: true });
    expect(posts.length).toBeGreaterThan(1);
    const all = JSON.stringify(posts);
    expect(all).not.toContain("xoxb-");
    expect(all).not.toContain("ABCDEFGHIJ");
    expect(all).toContain("[redacted-secret]");
  });

  it("still refuses what can't fit, with no post and a visible reason", async () => {
    const fetchImpl = vi.fn();
    const failed = vi.fn();
    const deliver = subsystemSlackDeliver({ ...stores("huge"), botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl, onTransportFailed: failed });
    const huge = "word ".repeat((SLACK_SECTION_CAP * MAX_HUMAN_MESSAGE_PARTS) / 5 + 1000);
    expect(await deliver(decision("huge", { body: huge }))).toMatchObject({ ok: false, class: "human-message-unrenderable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![2]).toMatch(/Slack messages \(maximum 20\)/);
  });

  it("cuts on a boundary and never inside a surrogate pair or an escape", () => {
    const text = `${"😀".repeat(700)}\n${"<&>".repeat(400)}`;
    const pieces = splitForSlack(text, () => 1000);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect(escapeSlackText(piece).length).toBeLessThanOrEqual(1000);
      expect(/[\uD800-\uDBFF]$/.test(piece)).toBe(false);
    }
    // No boundary within the first room: a hard cut between pairs. Then the line end wins.
    expect(pieces[0]).toBe("😀".repeat(500));
    expect(pieces[1]).toBe(`${"😀".repeat(200)}\n`);
  });

  it("tells the asking seat once when an ask can't be posted", async () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const huge = "word ".repeat((SLACK_SECTION_CAP * MAX_HUMAN_MESSAGE_PARTS) / 5 + 1000);
    const item = await repo.create({ ...request, body: huge });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets }, home);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => reply({ ok: true, ts: "1.1" }));
    const wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl });
    try {
      wire.startServices?.();
      const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
      wire.dispatcher.dispatch("post_message", request.destinationSession, alert);
      await vi.waitFor(() => expect(repo.getById(`${item.qitemId}-undeliverable`)).toBeTruthy());
      wire.dispatcher.dispatch("post_message", request.destinationSession, alert);
      await new Promise((r) => setTimeout(r, 50));
      const notice = repo.getById(`${item.qitemId}-undeliverable`)!;
      expect(notice).toMatchObject({ sourceSession: "author@rig", destinationSession: "author@rig", state: "pending" });
      expect(notice.body).toContain(item.qitemId);
      expect(notice.body).toMatch(/maximum 20/);
      expect(repo.list({ destinationSession: "author@rig" }).filter((q) => q.qitemId.endsWith("-undeliverable"))).toHaveLength(1);
      expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("chat.postMessage"))).toHaveLength(0);
    } finally {
      wire.stop();
      db.close();
    }
  });
});
