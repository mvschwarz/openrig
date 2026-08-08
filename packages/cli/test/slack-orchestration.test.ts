import { describe, it, expect } from "vitest";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/slack/state-store.js";
import { runOutboundOnce, seedBacklogOnEnable } from "../src/slack/outbound.js";
import { InboundRouter, shouldIngest, handleEnvelope, type SlackEvent } from "../src/slack/inbound.js";
import type { QueueRunner, QueueItem, RunResult } from "../src/slack/queue-bridge.js";
import type { FetchImpl } from "../src/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-07-30T00:00:00.000Z");

function fakeRunner(handler: (args: string[]) => RunResult): { runner: QueueRunner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, runner: async (args) => (calls.push(args), handler(args)) };
}
const okOut = (stdout: string): RunResult => ({ ok: true, stdout, stderr: "", code: 0 });
const failOut = (stderr: string): RunResult => ({ ok: false, stdout: "", stderr, code: 1 });

function fetchStatus(status: number): FetchImpl {
  return async () => new Response(status === 200 ? "ok" : "err", { status });
}

const ALERT: QueueItem = {
  qitemId: "qitem-a1",
  destinationSession: "human-founder@kernel",
  tags: ["founder-alert"],
  state: "pending",
  summary: "Decide X",
  body: "full body here",
};

describe("Slice-11 OUTBOUND orchestration (items 1,2,3,9)", () => {
  const filter = { alertTag: "founder-alert" };
  const mkRunner = () =>
    fakeRunner((args) => {
      // args are full rig argv: ["queue","list",...] / ["queue","show",...]
      if (args[0] === "queue" && args[1] === "list") return okOut(JSON.stringify([ALERT]));
      if (args[0] === "queue" && args[1] === "show") return okOut(JSON.stringify(ALERT));
      return failOut("unexpected");
    });

  it("item 1: posts a fresh human alert; item 2: marks seen AFTER a 200", async () => {
    const { runner, calls } = mkRunner();
    const seen = new SeenStore("/s/seen.jsonl", memFs(), clock);
    const r = await runOutboundOnce({ runner, seen, webhookUrl: "https://hooks.slack.com/x", fetchImpl: fetchStatus(200), sourceLabel: "vm", filter });
    expect(r.freshCount).toBe(1);
    expect(r.posted).toEqual(["qitem-a1"]);
    expect(r.failed).toEqual([]);
    expect(seen.load().has("qitem-a1")).toBe(true); // marked after success
    // SCOPE FIX proven: read used `queue list -A` (all-rigs) + an explicit high --limit (B5)
    const listCall = calls.find((c) => c[1] === "list")!;
    expect(listCall.slice(0, 3)).toEqual(["queue", "list", "-A"]);
    expect(listCall).toContain("--limit");
    expect(listCall).toContain("--json");
  });

  it("item 2: idempotent — a second sweep posts nothing", async () => {
    const { runner } = mkRunner();
    const seen = new SeenStore("/s/seen.jsonl", memFs(), clock);
    const deps = { runner, seen, webhookUrl: "https://hooks.slack.com/x", fetchImpl: fetchStatus(200), sourceLabel: "vm", filter };
    await runOutboundOnce(deps);
    const r2 = await runOutboundOnce(deps);
    expect(r2.freshCount).toBe(0);
    expect(r2.posted).toEqual([]);
  });

  it("item 3: fail-visible on a bad webhook — NOT marked seen, retried next sweep", async () => {
    const { runner } = mkRunner();
    const seen = new SeenStore("/s/seen.jsonl", memFs(), clock);
    const deps = { runner, seen, webhookUrl: "https://hooks.slack.com/x", fetchImpl: fetchStatus(500), sourceLabel: "vm", filter };
    const r = await runOutboundOnce(deps);
    expect(r.posted).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.id).toBe("qitem-a1");
    expect(seen.load().has("qitem-a1")).toBe(false); // NOT dropped
    // now webhook recovers → the SAME alert is retried (still fresh)
    const r2 = await runOutboundOnce({ ...deps, fetchImpl: fetchStatus(200) });
    expect(r2.posted).toEqual(["qitem-a1"]);
  });

  it("item 9: enable seeds the backlog as history (no post), then no replay storm", async () => {
    const { runner, calls } = mkRunner();
    const seen = new SeenStore("/s/seen.jsonl", memFs(), clock);
    const seed = await seedBacklogOnEnable({ runner, seen, filter });
    expect(seed.seeded).toBe(1);
    expect(seed.onlineStatus).toMatch(/ENABLED/);
    expect(calls.some((c) => c[1] === "create")).toBe(false); // nothing created during seed
    // subsequent sweep: the pre-existing alert is history, not reposted
    const r = await runOutboundOnce({ runner, seen, webhookUrl: "https://hooks.slack.com/x", fetchImpl: fetchStatus(200), sourceLabel: "vm", filter });
    expect(r.freshCount).toBe(0);
  });

  it("B5: enable seeds the COMPLETE backlog beyond 100 (list passes an explicit high --limit)", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      qitemId: `q-${i}`,
      destinationSession: "human-founder@kernel",
      tags: ["founder-alert"],
      state: "pending",
      summary: `s${i}`,
    }));
    const { runner, calls } = fakeRunner((args) =>
      args[0] === "queue" && args[1] === "list" ? okOut(JSON.stringify(many)) : failOut("unexpected"),
    );
    const seen = new SeenStore("/s/seen.jsonl", memFs(), clock);
    const seed = await seedBacklogOnEnable({ runner, seen, filter });
    expect(seed.seeded).toBe(150); // ALL, not capped at the daemon's default 100
    expect(seen.load().size).toBe(150);
    const listCall = calls.find((c) => c[1] === "list")!;
    expect(listCall).toContain("--limit"); // explicit high limit, not the default 100
  });
});

describe("Slice-11 INBOUND shouldIngest — loop-safety + T1076 non-text ignore", () => {
  const base: SlackEvent = { type: "message", user: "U1", text: "hello", ts: "1.1" };
  it("ingests a genuine human message", () => expect(shouldIngest(base)).toBe(true));
  it("ingests app_mention", () => expect(shouldIngest({ ...base, type: "app_mention" })).toBe(true));
  it("rejects bot posts (loop guard)", () => expect(shouldIngest({ ...base, bot_id: "B1" })).toBe(false));
  it("rejects subtypes (edits/joins/file_share)", () => expect(shouldIngest({ ...base, subtype: "message_changed" })).toBe(false));
  it("T1076: rejects file/image events cleanly", () => expect(shouldIngest({ ...base, files: [{ id: "F1" }] })).toBe(false));
  it("rejects empty/absent text and userless", () => {
    expect(shouldIngest({ ...base, text: "   " })).toBe(false);
    expect(shouldIngest({ ...base, user: undefined })).toBe(false);
  });
});

describe("Slice-11 INBOUND routing — never-drop (items 4,8)", () => {
  const mk = (createBehavior: () => RunResult) => {
    let n = 0;
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === "queue" && args[1] === "create") {
        n++;
        return createBehavior();
      }
      return failOut("unexpected");
    });
    const fs = memFs();
    const seen = new SeenStore("/s/seen.jsonl", fs, clock);
    const dead = new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fs, clock);
    // These tests exercise inbound LANDING mechanics (dedup/dead-letter/seen), not the A6 gate,
    // so inject an admit-all resolver that stamps the legacy human-class source.
    const router = new InboundRouter({ runner, seen, deadLetter: dead, destination: "operator-agent@kernel", resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }) });
    return { runner, calls, seen, dead, router, createCount: () => n };
  };
  const ev: SlackEvent = { type: "message", user: "U1", text: "hi team", ts: "100.1", channel: "C1" };

  it("item 4: human message → durable qitem on operator-agent@kernel, seen after", async () => {
    const h = mk(() => okOut("created qitem-in-1"));
    const r = await h.router.route(ev);
    expect(r.landed).toBe(true);
    expect(r.qitemId).toBe("qitem-in-1");
    expect(h.seen.load().has("100.1")).toBe(true);
    const createCall = h.calls.find((c) => c[1] === "create")!;
    expect(createCall).toContain("operator-agent@kernel");
    expect(createCall).toContain("human-U1@kernel"); // source provenance = human
    expect(createCall).toContain("routine"); // not "normal" (field lesson)
  });

  it("item 8: dedup by ts — same event twice creates ONE qitem", async () => {
    const h = mk(() => okOut("created qitem-in-1"));
    await h.router.route(ev);
    await h.router.route(ev);
    expect(h.createCount()).toBe(1);
  });

  it("item 8: in-flight guard — concurrent same-ts dispatch creates ONE", async () => {
    const h = mk(() => okOut("created qitem-in-1"));
    await Promise.all([h.router.route(ev), h.router.route(ev)]);
    expect(h.createCount()).toBe(1);
  });

  it("item 8: create FAILURE → dead-lettered before return, NOT seen, survives (non-destructive read), then recovers", async () => {
    let fail = true;
    const h = mk(() => (fail ? failOut("daemon down") : okOut("created qitem-in-9")));
    const r = await h.router.route(ev);
    expect(r.landed).toBe(false);
    expect(h.seen.load().has("100.1")).toBe(false); // NOT marked
    // dead-letter owns it (attempt-counted); readAll is NON-destructive (no put-back needed)
    const peek = h.dead.readAll();
    expect(peek).toHaveLength(1);
    expect(peek[0]!.attempts).toBe(1);
    expect(h.dead.readAll()).toHaveLength(1); // still there — readAll didn't consume it
    // recover and retry → lands, seen now, dead-letter atomically cleared
    fail = false;
    const rr = await h.router.retryDeadLetters();
    expect(rr.landed).toBe(1);
    expect(h.seen.load().has("100.1")).toBe(true);
    expect(h.dead.readAll()).toHaveLength(0); // cleared via atomic replaceAll
  });

  it("item 8: zero-drop across MANY failures — never lost while the daemon stays down", async () => {
    const h = mk(() => failOut("still down"));
    await h.router.route(ev); // attempt 1 → dead-letter
    for (let round = 0; round < 4; round++) await h.router.retryDeadLetters(); // keeps failing
    const remaining = h.dead.readAll();
    expect(remaining).toHaveLength(1); // still exactly one, never dropped
    expect(remaining[0]!.attempts).toBeGreaterThanOrEqual(5);
  });
});

describe("Slice-11 INBOUND handleEnvelope — fast-ack (item 8)", () => {
  const mkRouter = () => {
    const fs = memFs();
    return new InboundRouter({
      runner: async () => okOut("created qitem-x"),
      seen: new SeenStore("/s/seen.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fs, clock),
      destination: "operator-agent@kernel",
      resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }),
    });
  };

  it("acks EVERY envelope with an id — even a non-ingestible one", async () => {
    let acked = 0;
    await handleEnvelope({ envelope_id: "e1", type: "events_api", payload: { event: { type: "message", bot_id: "B", ts: "1" } } }, () => acked++, mkRouter());
    expect(acked).toBe(1); // acked despite being a bot post we won't ingest
  });

  it("acks then routes a human message", async () => {
    let acked = 0;
    const router = mkRouter();
    await handleEnvelope(
      { envelope_id: "e2", type: "events_api", payload: { event: { type: "message", user: "U1", text: "hi", ts: "2.2", channel: "C1" } } },
      () => acked++,
      router,
    );
    expect(acked).toBe(1);
  });

  it("acks a disconnect envelope and does not route", async () => {
    let acked = 0;
    await handleEnvelope({ envelope_id: "e3", type: "disconnect", reason: "refresh" }, () => acked++, mkRouter());
    expect(acked).toBe(1);
  });
});

// ── M1 A5b WIRING — the outbound sweep must actually EMIT image blocks ────────
// The renderer (buildImageBlocks) and the consumer (slackDeliverFn) were both built
// and unit-tested, but slackDeliverFn had ZERO non-test callers and the sweep passed
// no mediaRefs — so the shipped path posted TEXT ONLY. A seam with no construction
// site is not wired; a founder acceptance fired through it would have been a false pass.
describe("M1 A5b — outbound sweep emits image blocks for an evidence-bearing alert", () => {
  const filter = { alertTag: "founder-alert" };
  const IMG = "https://example.invalid/PROGRAM-BOARD-M1-row.png";
  const ALERT_IMG: QueueItem = { ...ALERT, qitemId: "qitem-img", evidenceRef: IMG };

  function capturingFetch(): { fetchImpl: FetchImpl; bodies: string[] } {
    const bodies: string[] = [];
    return {
      bodies,
      fetchImpl: async (_url: string, init?: { body?: string }) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("ok", { status: 200 });
      },
    } as { fetchImpl: FetchImpl; bodies: string[] };
  }

  const mkRunnerImg = () =>
    fakeRunner((args) => {
      if (args[0] === "queue" && args[1] === "list") return okOut(JSON.stringify([ALERT_IMG]));
      if (args[0] === "queue" && args[1] === "show") return okOut(JSON.stringify(ALERT_IMG));
      return failOut("unexpected");
    });

  it("posts an image block carrying the alert's https evidenceRef", async () => {
    const { runner } = mkRunnerImg();
    const seen = new SeenStore("/s/seen-img.jsonl", memFs(), clock);
    const { fetchImpl, bodies } = capturingFetch();
    const r = await runOutboundOnce({ runner, seen, webhookUrl: "https://hooks.slack.com/x", fetchImpl, sourceLabel: "vm", filter });
    expect(r.posted).toEqual(["qitem-img"]);
    const payload = JSON.parse(bodies[0]) as { blocks?: { type?: string; image_url?: string }[] };
    const images = (payload.blocks ?? []).filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].image_url).toBe(IMG);
  });

  it("NEGATIVE CONTROL: a non-https evidenceRef emits NO image block (hygiene rail intact)", async () => {
    const local: QueueItem = { ...ALERT, qitemId: "qitem-local", evidenceRef: "/tmp/local-only.png" };
    const { runner } = fakeRunner((args) => {
      if (args[0] === "queue" && args[1] === "list") return okOut(JSON.stringify([local]));
      if (args[0] === "queue" && args[1] === "show") return okOut(JSON.stringify(local));
      return failOut("unexpected");
    });
    const seen = new SeenStore("/s/seen-local.jsonl", memFs(), clock);
    const { fetchImpl, bodies } = capturingFetch();
    await runOutboundOnce({ runner, seen, webhookUrl: "https://hooks.slack.com/x", fetchImpl, sourceLabel: "vm", filter });
    const payload = JSON.parse(bodies[0]) as { blocks?: { type?: string }[] };
    expect((payload.blocks ?? []).filter((b) => b.type === "image")).toHaveLength(0);
  });
});

// ── P28 — the ignore path must explain its own discard ───────────────────────
// The log printed type/subtype/files — three fields that have all just PASSED when a
// message is dropped for bot_id or missing user/text — and omitted both the failing
// branch and the channel id. Live consequence: three plain-message events were discarded
// with no recoverable reason, and with channels:read ungranted there was no read that
// could even name the conversation they came from. Privacy rail: channel id and a branch
// LABEL only — never bodies, tokens, user ids, or text content/length.
describe("P28 — ignore-path telemetry discriminates the rejection branch", () => {
  const mkRouterStub = () => new InboundRouter({ runner: async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), seen: new SeenStore("/s/p28.jsonl", memFs(), clock), dead: new DeadLetterStore("/s/p28d.jsonl", memFs(), clock), destination: "operator-agent@kernel", resolveSender: () => ({ admitted: true, source: "human-founder@external" }) });

  async function logFor(ev: Record<string, unknown>): Promise<string> {
    const lines: string[] = [];
    await handleEnvelope({ envelope_id: "e", type: "events_api", payload: { event: ev } }, () => {}, mkRouterStub(), (m) => lines.push(m));
    return lines.join("\n");
  }

  it("names the CHANNEL and the bot_id branch", async () => {
    const out = await logFor({ type: "message", bot_id: "B1", user: "U1", text: "x", channel: "C090L0VFB0U" });
    expect(out).toContain("channel=C090L0VFB0U");
    expect(out).toContain("reason=bot_id");
  });

  it("names the missing-user branch DISTINCTLY (not conflated with bot_id)", async () => {
    const out = await logFor({ type: "message", text: "x", channel: "D0BLHF6VC86" });
    expect(out).toContain("channel=D0BLHF6VC86");
    expect(out).toContain("reason=no-user");
    expect(out).not.toContain("reason=bot_id");
  });

  it("names the empty-text branch DISTINCTLY", async () => {
    const out = await logFor({ type: "message", user: "U1", text: "   ", channel: "C3" });
    expect(out).toContain("reason=empty-text");
    expect(out).not.toContain("reason=no-user");
  });

  it("PRIVACY RAIL: never leaks the user id or the message text", async () => {
    const out = await logFor({ type: "message", user: "U09DAG5D14M", text: "secret body text", channel: "C4" });
    expect(out).not.toContain("U09DAG5D14M");
    expect(out).not.toContain("secret body text");
  });
});
