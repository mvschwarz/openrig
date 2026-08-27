// S10 — durability through failure, duplicate ABSENCE pinned (proof contract):
//   1. induced Slack API TIMEOUT → the retry RECONCILES BY MARKER before any send: marker
//      found → ack without repost (the timeout had landed); marker absent → send once. Never a
//      blind repost; an unreadable channel stays retained (delay, never a duplicate).
//   2. induced CRASH between persist and dispatch → the next activation's replay delivers
//      EXACTLY once; a second replay re-acks without a second post.
// Any duplicate human notification is the red.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { OUTBOUND_OP, type OutboundPostPayload } from "../src/domain/gateway/slack/outbound-driver.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-27T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));
const activeCount = (s: string, form: string): number => s.split(form).length - 1;

/** A Slack double that can: TIMEOUT the first post (while actually landing it or not), serve
 *  conversations.history with the landed texts, and count real posts. */
function slackDouble(opts: { timeoutFirstPost: boolean; timeoutLanded: boolean; historyReadable?: boolean; extraHistory?: string[] }) {
  const posted: string[] = []; // texts that actually LANDED on "Slack"
  let postCalls = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    if (url.endsWith("chat.postMessage")) {
      postCalls++;
      const text = String((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      if (opts.timeoutFirstPost && postCalls === 1) {
        if (opts.timeoutLanded) posted.push(text); // it LANDED — but the sender never learns
        throw new Error("timeout after 15000ms"); // the ambiguous outcome
      }
      posted.push(text);
      return new Response(JSON.stringify({ ok: true, ts: `${1000 + postCalls}.1` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("conversations.history")) {
      if (opts.historyReadable === false) {
        return new Response(JSON.stringify({ ok: false, error: "channel_unreadable" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // History = whatever else is in the channel (ordinary coordination prose) + the landed posts.
      const texts = [...(opts.extraHistory ?? []), ...posted];
      return new Response(JSON.stringify({ ok: true, messages: texts.map((t) => ({ text: t })) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, posted, postCount: () => postCalls };
}

function harness(fetchImpl: FetchImpl) {
  const fsx = memFs();
  const outboundSeen = new SeenStore("/seen.jsonl", fsx, clock);
  const deliver = subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake",
    channel: "C1",
    sourceLabel: "vm",
    fetchImpl,
    delivered: new SeenStore("/del.jsonl", fsx, clock),
    attempted: new SeenStore("/att.jsonl", fsx, clock),
    outboundSeen,
  });
  return { deliver, outboundSeen };
}
const payload: OutboundPostPayload = { qitemId: "qitem-dur-1", summary: "Decide X", body: "b", destinationSession: "mike@external", sourceSession: "dev-driver@v-openrig-build" };
const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "d-dur-1", op: OUTBOUND_OP, entityBindingRef: "mike#slack", payload };

describe("H1 — induced timeout → reconcile-by-marker, never a blind repost", () => {
  it("timeout that LANDED: the retry finds the qitem marker and ACKS WITHOUT reposting — exactly ONE human notification", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true });
    const { deliver, outboundSeen } = harness(slack.fetchImpl);
    const first = await deliver(decision);
    expect(first.ok).toBe(false); // ambiguous outcome surfaces as a failure class → retained
    expect(slack.posted).toHaveLength(1); // …but it LANDED on Slack
    const retry = await deliver(decision); // the replay
    expect(retry.ok).toBe(true); // reconciled: marker found → ack
    expect(slack.posted).toHaveLength(1); // duplicate ABSENCE: still exactly one message
    expect(slack.postCount()).toBe(1); // and no second post was even attempted
    expect(outboundSeen.load().has("qitem-dur-1")).toBe(true); // qitem seen via reconcile
  });

  it("timeout that did NOT land: the retry finds no marker and sends ONCE", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: false });
    const { deliver } = harness(slack.fetchImpl);
    expect((await deliver(decision)).ok).toBe(false);
    expect(slack.posted).toHaveLength(0); // genuinely lost
    const retry = await deliver(decision);
    expect(retry.ok).toBe(true);
    expect(slack.posted).toHaveLength(1); // delivered exactly once
  });

  it("F-B1r MARKER EFFECT: a HOSTILE qitemId timeout-that-landed reconciles by the ESCAPED marker — producer and scanner compare the SAME bytes, no repost, and no active syntax ever posts", async () => {
    // The round-2 byte-fidelity requirement, pinned by EFFECT: the footer now posts the id
    // escaped, so the reconcile scan must search the escaped form or a landed hostile-id post
    // would be missed and REPOSTED (a duplicate human notification — the H red). For minted
    // ids escaped == raw, so behavior is unchanged.
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true });
    const { deliver, outboundSeen } = harness(slack.fetchImpl);
    const hostile: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-hostile-marker", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "<!channel>" },
    };
    const first = await deliver(hostile);
    expect(first.ok).toBe(false); // ambiguous timeout → retained
    expect(slack.posted).toHaveLength(1); // …but it LANDED
    expect(activeCount(slack.posted[0]!, "<!channel>"), "the landed post itself must carry no active syntax").toBe(0);
    const retry = await deliver(hostile);
    expect(retry.ok).toBe(true); // reconciled: the ESCAPED marker matched the landed bytes
    expect(slack.posted).toHaveLength(1); // duplicate ABSENCE: exactly one message, ever
    expect(outboundSeen.load().has("<!channel>")).toBe(true); // qitem seen via reconcile
  });

  it("reconcile scan UNREADABLE: retained (a delay), NEVER a blind repost", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true, historyReadable: false });
    const { deliver } = harness(slack.fetchImpl);
    await deliver(decision);
    const retry = await deliver(decision);
    expect(retry.ok).toBe(false);
    expect((retry as { class: string }).class).toBe("reconcile-unreadable");
    expect(slack.posted).toHaveLength(1); // the landed copy stays the only copy
  });
});

describe("R2 round-3 — reconciliation identity is STRUCTURAL: guaranteed in the scanned surface, scoped to the target message (ordinary data only)", () => {
  it("EFFECT A: a valid LONG routine summary (5000 chars) + timeout-that-landed → exactly ONE landed copy, zero repost (the identity survives the clamp)", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true });
    const { deliver } = harness(slack.fetchImpl);
    const longRow: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-long-summary", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "qitem-routine-long-summary", summary: "s".repeat(5000), body: "ordinary body" },
    };
    const first = await deliver(longRow);
    expect(first.ok).toBe(false); // ambiguous timeout → retained
    expect(slack.posted).toHaveLength(1); // …but it LANDED, with the fallback text at the cap
    const retry = await deliver(longRow);
    expect(retry.ok).toBe(true);
    expect(slack.posted, "duplicate ABSENCE: the landed long-summary post must be recognized, never reposted").toHaveLength(1);
  });

  it("EFFECT B: unrelated routine prose QUOTING the id + timeout-that-did-NOT-land → never false-acks; the target posts exactly once on retry", async () => {
    const slack = slackDouble({
      timeoutFirstPost: true,
      timeoutLanded: false,
      extraHistory: ["status: qitem-routine-target is waiting on another lane"], // ordinary coordination prose
    });
    const { deliver } = harness(slack.fetchImpl);
    const target: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-target", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "qitem-routine-target", summary: "short summary", body: "b" },
    };
    const first = await deliver(target);
    expect(first.ok).toBe(false);
    expect(slack.posted).toHaveLength(0); // genuinely lost — only the unrelated quote exists
    const retry = await deliver(target);
    expect(retry.ok).toBe(true);
    expect(slack.posted, "the quote must not satisfy reconciliation — the target itself must post").toHaveLength(1);
    expect(slack.posted[0]).toContain("short summary"); // the landed copy is the TARGET, not a phantom
  });

  it("SCOPING: prose containing the qitem id AND a lookalike token shape cannot match — only the exact decision-scoped token does; and the token survives a max-length message", async () => {
    const slack = slackDouble({
      timeoutFirstPost: true,
      timeoutLanded: false,
      extraHistory: [
        "quoting qitem-routine-scope in prose",
        "even a lookalike (or-mark:qitem-routine-scope) built from the QITEM id must not match",
      ],
    });
    const { deliver } = harness(slack.fetchImpl);
    const scoped: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-scope-check", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "qitem-routine-scope", summary: "x".repeat(6000), body: "y".repeat(2000) },
    };
    await deliver(scoped);
    const retry = await deliver(scoped);
    expect(retry.ok).toBe(true);
    expect(slack.posted).toHaveLength(1); // posted despite both decoys (no false-ack)
    // and the posted max-length text still carries the reconcile identity within the cap:
    expect(slack.posted[0]!.length).toBeLessThanOrEqual(3900);
    expect(slack.posted[0]).toContain("d-scope-check"); // the decision-scoped token survived the clamp
  });
});

describe("H2 — crash between persist and dispatch → replay delivers EXACTLY once", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-dur-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("a persisted-never-dispatched decision delivers once on replay; a second activation re-acks without a second post", async () => {
    // CRASH WINDOW: the decision reached the durable buffer, the process died before send.
    new DispatchBuffer(home).enqueue(decision);
    const slack = slackDouble({ timeoutFirstPost: false, timeoutLanded: false });
    const { deliver } = harness(slack.fetchImpl);
    // Activation 1: replay delivers it.
    const w1 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w1.startServices?.();
    await flush();
    expect(slack.posted).toHaveLength(1);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0); // drained after the ack
    // Activation 2 (same durable stores would be shared in prod; here the buffer is empty):
    const w2 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w2.startServices?.();
    await flush();
    expect(slack.posted).toHaveLength(1); // exactly once, ever
  });

  it("crash AFTER delivery but BEFORE the ack drained the buffer: replay re-acks via the delivered-store, no double post", async () => {
    const slack = slackDouble({ timeoutFirstPost: false, timeoutLanded: false });
    const { deliver } = harness(slack.fetchImpl);
    // Persist + deliver via replay (pins the decisionId to d-dur-1).
    new DispatchBuffer(home).enqueue(decision);
    const w1 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w1.startServices?.();
    await flush();
    expect(slack.posted).toHaveLength(1);
    // CRASH WINDOW: delivered.mark happened, the ack-drain did not — the SAME decision sits
    // durable again for the next activation.
    new DispatchBuffer(home).enqueue(decision);
    const w2 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w2.startServices?.();
    await flush();
    // The delivered-store re-acks decisionId d-dur-1 without a second post.
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted.filter((t) => t.includes("qitem-dur-1"))).toHaveLength(1);
  });
});
