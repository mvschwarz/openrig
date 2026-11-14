// S10 CUTOVER — the slice-11 locked receipts, carried through the relay→subsystem cutover
// (ported from the retired cli/test/slack-orchestration.test.ts; the semantics under test are
// the LOCKED durability contract and must hold unchanged on the successor path), PLUS the
// dual-path ABSENCE receipts: every delivery class is carried by the SUBSYSTEM path (driver →
// in-process wire → chat.postMessage delivery) and by nothing else — the relay modules are
// deleted (compile-time absence) and the fetch capture proves no webhook is ever dialed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { InboundRouter, shouldIngest, handleEnvelope, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { seedBacklogAsHistory, type QueueItem, type OutboundQueuePort } from "../src/domain/gateway/slack/queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

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
const clock = () => new Date("2026-08-26T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));

const ALERT: QueueItem = {
  qitemId: "qitem-a1",
  destinationSession: "human-founder@kernel",
  tags: ["founder-alert"],
  state: "pending",
  summary: "Decide X",
  body: "full body here",
};

function fakePort(items: QueueItem[]): OutboundQueuePort & { listCalls: number } {
  const port = {
    listCalls: 0,
    async listHumanAlerts() {
      port.listCalls++;
      return items;
    },
  };
  return port;
}

/** Capture every outbound HTTP call: url + parsed JSON body. 2xx by default. */
function capturingFetch(status = 200): { fetchImpl: FetchImpl; calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    fetchImpl: async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: status === 200, ts: "1724.0001", error: status === 200 ? undefined : "posting_failed" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/** Compose the REAL subsystem outbound path over a temp home: driver → wire → delivery. */
function composeOutbound(home: string, port: OutboundQueuePort, fetchImpl: FetchImpl, fsx = memFs(), unfurl?: "on" | "off", thread?: string) {
  const outboundSeen = new SeenStore("/s/outbound-seen.jsonl", fsx, clock);
  const delivered = new SeenStore("/s/delivered.jsonl", fsx, clock);
  const attempted = new SeenStore("/s/attempted.jsonl", fsx, clock);
  let release: (q: string) => void = () => {};
  const deliver = subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake",
    channel: "C-TEST",
    sourceLabel: "vm",
    unfurl,
    resolveThreadTs: () => thread,
    fetchImpl,
    delivered,
    attempted,
    outboundSeen,
    release: (q) => release(q),
  });
  const wire = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
  const driver = new SlackOutboundDriver({
    home,
    queue: port,
    seen: outboundSeen,
    filter: { minimumLevel: "NOTICE" },
    dispatch: (op, ref, payload) => wire.dispatcher.dispatch(op, ref, payload),
  });
  release = (q) => driver.release(q);
  return { driver, wire, outboundSeen, delivered };
}

describe("S10 cutover — outbound classes ride the SUBSYSTEM path (slice-11 items 1,2,3 preserved)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-cut-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("outbound TEXT: fresh alert → chat.postMessage (NEVER a webhook); seen marked AFTER the 2xx", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver, outboundSeen } = composeOutbound(home, fakePort([ALERT]), fetchImpl);
    const sweep = await driver.sweepOnce();
    await flush();
    expect(sweep.dispatched).toEqual(["qitem-a1"]);
    expect(outboundSeen.load().has("qitem-a1")).toBe(true); // marked after success
    // Dual-path absence, transport level: the ONLY HTTP call is the Web API post — no webhook.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls.some((c) => c.url.includes("hooks.slack.com"))).toBe(false);
    expect(calls[0]!.body.channel).toBe("C-TEST");
    expect(calls[0]!.body).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  it("applies enabled previews to a threaded human row", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([ALERT]), fetchImpl, memFs(), "on", "100.1");
    await driver.sweepOnce();
    await flush();
    expect(calls[0]!.body).toMatchObject({ thread_ts: "100.1", unfurl_links: true, unfurl_media: true });
  });

  it("item 2 idempotent: a second sweep posts nothing", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([ALERT]), fetchImpl);
    await driver.sweepOnce();
    await flush();
    const s2 = await driver.sweepOnce();
    await flush();
    expect(s2.fresh).toBe(0);
    expect(calls).toHaveLength(1); // one post total
  });

  it("item 3 fail-visible: a failed post is retained (durable buffer), NOT seen; recovery replays exactly it", async () => {
    const bad = capturingFetch(500);
    const { driver, outboundSeen } = composeOutbound(home, fakePort([ALERT]), bad.fetchImpl);
    await driver.sweepOnce();
    await flush();
    expect(outboundSeen.load().has("qitem-a1")).toBe(false); // not dropped, not lied about
    expect(bad.calls).toHaveLength(1);
    // A later sweep does NOT double-dispatch (in-flight guard): the durable buffer owns the retry.
    const s2 = await driver.sweepOnce();
    await flush();
    expect(s2.dispatched).toEqual([]);
    expect(bad.calls).toHaveLength(1);
    // Recovery = the next activation replays the retained decision through delivery (no-loss).
    // Replay is a network action, so it rides startServices() — the post-bind half.
    const good = capturingFetch(200);
    const fsx2 = memFs();
    const next = composeOutbound(home, fakePort([]), good.fetchImpl, fsx2);
    next.wire.startServices?.();
    await flush();
    expect(good.calls).toHaveLength(1);
    expect(good.calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
  });

  it("outbound IMAGE: an https evidenceRef rides as a Block Kit image on the SAME single path (A5b)", async () => {
    const IMG = "https://example.invalid/PROGRAM-BOARD-row.png";
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([{ ...ALERT, qitemId: "qitem-img", evidenceRef: IMG }]), fetchImpl);
    await driver.sweepOnce();
    await flush();
    const blocks = (calls[0]!.body.blocks ?? []) as { type?: string; image_url?: string }[];
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.image_url).toBe(IMG);
  });

  it("A5b NEGATIVE CONTROL: a non-https evidenceRef emits NO image block (hygiene rail intact)", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([{ ...ALERT, qitemId: "qitem-local", evidenceRef: "/tmp/local-only.png" }]), fetchImpl);
    await driver.sweepOnce();
    await flush();
    const blocks = (calls[0]!.body.blocks ?? []) as { type?: string }[];
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
  });

  it("item 9: enable seeds the backlog as history — the next sweep posts NOTHING (no replay storm)", async () => {
    const fsx = memFs();
    const seen = new SeenStore("/s/outbound-seen.jsonl", fsx, clock);
    const seed = await seedBacklogAsHistory({ queue: fakePort([ALERT]), seen, filter: { minimumLevel: "NOTICE" } });
    expect(seed.seeded).toBe(1);
    expect(seed.onlineStatus).toMatch(/ENABLED/);
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([ALERT]), fetchImpl, fsx);
    const sweep = await driver.sweepOnce();
    expect(sweep.fresh).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("B5: seeding covers the COMPLETE backlog (150 > the old CLI default 100)", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      qitemId: `q-${i}`, destinationSession: "human-founder@kernel", tags: ["founder-alert"], state: "pending", summary: `s${i}`,
    }));
    const seen = new SeenStore("/s/seen.jsonl", memFs(), clock);
    const seed = await seedBacklogAsHistory({ queue: fakePort(many), seen, filter: { minimumLevel: "NOTICE" } });
    expect(seed.seeded).toBe(150);
    expect(seen.load().size).toBe(150);
  });
});

describe("Slice-11 INBOUND shouldIngest — loop-safety + T1076 non-text ignore (unchanged)", () => {
  const base: SlackEvent = { type: "message", user: "U1", text: "hello", ts: "1.1" };
  it("ingests a genuine human message", () => expect(shouldIngest(base)).toBe(true));
  it("ingests app_mention", () => expect(shouldIngest({ ...base, type: "app_mention" })).toBe(true));
  it("rejects bot posts (loop guard)", () => expect(shouldIngest({ ...base, bot_id: "B1" })).toBe(false));
  it("rejects subtypes (edits/joins; file_share is admitted with files since OPR.0.5.6.2)", () => expect(shouldIngest({ ...base, subtype: "message_changed" })).toBe(false));
  it("OPR.0.5.6.2 (T1076 replaced): file-bearing messages are ADMITTED — files are work, not noise", () => expect(shouldIngest({ ...base, files: [{ id: "F1" }] })).toBe(true));
  it("rejects empty/absent text and userless", () => {
    expect(shouldIngest({ ...base, text: "   " })).toBe(false);
    expect(shouldIngest({ ...base, user: undefined })).toBe(false);
  });
});

describe("Slice-11 INBOUND routing — never-drop, on the in-process queue port (items 4,8)", () => {
  const mk = (createBehavior: () => string | Error) => {
    let n = 0;
    const queue = {
      createQitem: async () => {
        n++;
        const r = createBehavior();
        if (r instanceof Error) throw r;
        return r;
      },
    };
    const fs = memFs();
    const seen = new SeenStore("/s/seen.jsonl", fs, clock);
    const dead = new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fs, clock);
    const router = new InboundRouter({ queue, seen, deadLetter: dead, destination: "operator-agent@kernel", resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }) });
    return { seen, dead, router, createCount: () => n };
  };
  const ev: SlackEvent = { type: "message", user: "U1", text: "hi team", ts: "100.1", channel: "C1" };

  it("item 4: human message → durable qitem, seen after", async () => {
    const h = mk(() => "qitem-in-1");
    const r = await h.router.route(ev);
    expect(r.landed).toBe(true);
    expect(r.qitemId).toBe("qitem-in-1");
    expect(h.seen.load().has("C1:100.1")).toBe(true);
  });

  it("item 8: dedup by ts — same event twice creates ONE qitem", async () => {
    const h = mk(() => "qitem-in-1");
    await h.router.route(ev);
    await h.router.route(ev);
    expect(h.createCount()).toBe(1);
  });

  it("item 8: in-flight guard — concurrent same-ts dispatch creates ONE", async () => {
    const h = mk(() => "qitem-in-1");
    await Promise.all([h.router.route(ev), h.router.route(ev)]);
    expect(h.createCount()).toBe(1);
  });

  it("item 8: create FAILURE → dead-lettered before return, NOT seen, survives, then recovers", async () => {
    let fail = true;
    const h = mk(() => (fail ? new Error("daemon busy") : "qitem-in-9"));
    const r = await h.router.route(ev);
    expect(r.landed).toBe(false);
    expect(h.seen.load().has("C1:100.1")).toBe(false);
    const peek = h.dead.readAll();
    expect(peek).toHaveLength(1);
    expect(peek[0]!.attempts).toBe(1);
    expect(h.dead.readAll()).toHaveLength(1); // non-destructive read
    fail = false;
    const rr = await h.router.retryDeadLetters();
    expect(rr.landed).toBe(1);
    expect(h.seen.load().has("C1:100.1")).toBe(true);
    expect(h.dead.readAll()).toHaveLength(0);
  });

  it("item 8: zero-drop across MANY failures", async () => {
    const h = mk(() => new Error("still down"));
    await h.router.route(ev);
    for (let round = 0; round < 4; round++) await h.router.retryDeadLetters();
    const remaining = h.dead.readAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.attempts).toBeGreaterThanOrEqual(5);
  });
});

describe("Slice-11 INBOUND handleEnvelope — fast-ack (item 8, unchanged)", () => {
  const mkRouter = () => {
    const fs = memFs();
    return new InboundRouter({
      queue: { createQitem: async () => "qitem-x" },
      seen: new SeenStore("/s/seen.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fs, clock),
      destination: "operator-agent@kernel",
      resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }),
    });
  };

  it("acks EVERY envelope with an id — even a non-ingestible one", async () => {
    let acked = 0;
    await handleEnvelope({ envelope_id: "e1", type: "events_api", payload: { event: { type: "message", bot_id: "B", ts: "1" } } }, () => acked++, mkRouter());
    expect(acked).toBe(1);
  });

  it("acks then routes a human message", async () => {
    let acked = 0;
    await handleEnvelope(
      { envelope_id: "e2", type: "events_api", payload: { event: { type: "message", user: "U1", text: "hi", ts: "2.2", channel: "C1" } } },
      () => acked++,
      mkRouter(),
    );
    expect(acked).toBe(1);
  });

  it("acks a disconnect envelope and does not route", async () => {
    let acked = 0;
    await handleEnvelope({ envelope_id: "e3", type: "disconnect", reason: "refresh" }, () => acked++, mkRouter());
    expect(acked).toBe(1);
  });
});

describe("P28 — ignore-path telemetry discriminates the rejection branch (unchanged)", () => {
  const mkRouterStub = () =>
    new InboundRouter({
      queue: { createQitem: async () => "qitem-p28" },
      seen: new SeenStore("/s/p28.jsonl", memFs(), clock),
      deadLetter: new DeadLetterStore("/s/p28d.jsonl", memFs(), clock),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
    });

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

describe("Capability 3 — single-wire relay port isolation and attempted-replay bypass", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-relay-cut-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("never falls through to Slack when a human's primary binding is relay and the relay profile is unready, and bypasses re-decision on attempted replay", async () => {
    const { writeFileSync } = await import("node:fs");
    const { createDb } = await import("../src/db/connection.js");
    const { migrate } = await import("../src/db/migrate.js");
    const { ALL_MIGRATIONS } = await import("../src/db/all-migrations.js");
    const { EventBus } = await import("../src/domain/event-bus.js");
    const { QueueRepository } = await import("../src/domain/queue-repository.js");
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/domain/gateway/slack/config.js");
    const { buildSlackGatewayWire } = await import("../src/domain/gateway/slack/slack-subsystem.js");
    const { resolveSlackHandle } = await import("../src/domain/gateway/human-registry.js");
    const { DispatchBuffer } = await import("../src/domain/gateway/dispatch-buffer.js");
    const { HumanQuietStore } = await import("../src/domain/gateway/human-quiet-windows.js");

    const db = createDb();
    migrate(db, ALL_MIGRATIONS);

    // Configure Slack as READY so a fallthrough bug would hit Slack chat.postMessage
    const slackSecrets = join(home, "slack.env");
    writeFileSync(slackSecrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-FALLTHROUGH", secretsEnvFile: slackSecrets }, home);

    const relaySecrets = join(home, "relay.env");
    // Start with missing relay file -> unready relay profile
    const registry = {
      ok: true as const,
      entities: [
        {
          entityId: "sam",
          class: "human" as const,
          displayName: "Sam",
          address: "sam@external",
          connectorBindings: [
            {
              kind: "relay" as const,
              connectorRef: "wa-main",
              secretsRef: `file:${relaySecrets}`,
              role: "primary" as const,
              handle: "sam_wa",
            },
            {
              kind: "slack" as const,
              connectorRef: "slack-secondary",
              secretsRef: `file:${slackSecrets}`,
              role: "secondary" as const,
              handle: "USAM",
            },
          ],
          prefs: { deliveryClass: "A" as const, availability: "available" as const },
        },
      ],
    };

    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => registry,
    });
    const ask = await repo.create({
      sourceSession: "lead@rig",
      destinationSession: "orch@rig",
      body: "Must never fall through to Slack",
      nudge: false,
    });
    repo.update({
      qitemId: ask.qitemId,
      actorSession: "orch@rig",
      state: "blocked",
      blockedOn: "sam@kernel",
      summary: "Relay-bound question",
      evidenceRef: "/proof/relay-ask.md",
      transitionNote: "parked",
    });
    const askEpisodeKey = `${ask.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(ask.qitemId)!.transitionId}`;
    // Seed an earlier Slack-named transport-failed note for the same episode (as baseline 5d188a43b wrote before the fix);
    // a subsequent Relay failure for this episode must still record a relay-owner-notification-transport-failed note.
    repo.update({
      qitemId: ask.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-transport-failed notification_key=${askEpisodeKey} class=relay-profile-unready error=legacy-slack-named-failure`,
    });

    const slackCalls: string[] = [];
    const relayCalls: Array<Record<string, unknown>> = [];
    let failFirstRelayHttp = true;

    const makeWire = () =>
      buildSlackGatewayWire({
        home,
        queueRepo: repo,
        registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
        outboundIntervalMs: 15,
        fetchImpl: async (url, init) => {
          if (String(url).includes("slack.com")) {
            slackCalls.push(String(url));
            return new Response(JSON.stringify({ ok: true, ts: "1724.0001" }), { status: 200 });
          }
          relayCalls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (failFirstRelayHttp) {
            failFirstRelayHttp = false;
            throw new Error("simulated connection drop after attempt");
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

    const w1 = makeWire();
    try {
      w1.startServices?.();
      await new Promise((r) => setTimeout(r, 50));
      // Unready relay profile is retained in DispatchBuffer and NEVER falls through to Slack
      expect(slackCalls).toHaveLength(0);
      expect(relayCalls).toHaveLength(0);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);
      const w1Notes = repo.listTransitions(ask.qitemId).map((t) => t.transitionNote ?? "");
      const relayFailureNotes = w1Notes.filter((n) => n.startsWith("relay-owner-notification-transport-failed "));
      expect(relayFailureNotes).toHaveLength(1);
      expect(relayFailureNotes[0]).toContain("connector_ref=wa-main");
      expect(relayFailureNotes[0]).toContain("class=relay-profile-unready");
      expect(repo.getById(ask.qitemId)).toMatchObject({
        deliveryOutcome: "transport-failed",
        deliveryFailureDetail: expect.stringContaining("relay-owner-notification-transport-failed"),
      });
      expect(repo.findUndelivered().map((q) => q.qitemId)).toContain(ask.qitemId);
    } finally {
      w1.stop();
    }

    // If the relay connectorRef changes while still failing, it must record a new note naming the new connector rather than suppressing
    registry.entities[0]!.connectorBindings[0]!.connectorRef = "wa-failover";
    const originalPending = new DispatchBuffer(home).pending()[0]!;
    const {
      relayConnectorRef: _oldRef,
      relayEnvelope: _oldEnv,
      ...unpreparedPayload
    } = (originalPending.payload ?? {}) as Record<string, unknown>;
    const w1b = makeWire();
    try {
      w1b.dispatcher.dispatch("post_message", "sam@kernel", unpreparedPayload, {
        decisionId: "failover-probe",
      });
      await new Promise((r) => setTimeout(r, 30));
      const w1bRelayFailureNotes = repo
        .listTransitions(ask.qitemId)
        .map((t) => t.transitionNote ?? "")
        .filter((n) => n.startsWith("relay-owner-notification-transport-failed "));
      expect(w1bRelayFailureNotes).toHaveLength(2);
      expect(w1bRelayFailureNotes[1]).toContain("connector_ref=wa-failover");
      expect(repo.getById(ask.qitemId)?.deliveryFailureDetail).toContain("connector_ref=wa-failover");
    } finally {
      new DispatchBuffer(home).ack("failover-probe");
      w1b.stop();
      registry.entities[0]!.connectorBindings[0]!.connectorRef = "wa-main";
    }

    // Write valid relay secrets and replay: first HTTP attempt drops after recording attempt metadata
    writeFileSync(
      relaySecrets,
      [
        "OPENRIG_RELAY_URL=http://127.0.0.1:44101/outbound",
        "OPENRIG_RELAY_OUTBOUND_TOKEN=out-secret-token-123456",
        "OPENRIG_RELAY_INBOUND_TOKEN=in-secret-token-654321",
      ].join("\n"),
      { mode: 0o600 },
    );

    const w2 = makeWire();
    try {
      w2.startServices?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(slackCalls).toHaveLength(0);
      expect(relayCalls).toHaveLength(1);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    } finally {
      w2.stop();
    }

    // Turn ON quiet hours for sam BEFORE the next replay: because the decision was already attempted,
    // replay must bypass policy re-decision (must NOT hold for quiet hours) and deliver the exact frozen envelope
    const now = new Date();
    new HumanQuietStore(db).setUntil("sam", {
      until: new Date(now.getTime() + 3_600_000),
      timezone: "UTC",
      setBy: "test",
      now,
    });

    const w3 = makeWire();
    try {
      w3.startServices?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(slackCalls).toHaveLength(0);
      expect(relayCalls).toHaveLength(2);
      expect(relayCalls[1]).toEqual(relayCalls[0]);
      expect(new DispatchBuffer(home).pending()).toHaveLength(0);
      const episode = repo.currentHumanRequiredEpisode(ask.qitemId)!;
      expect(repo.hasRelayOwnerNotificationReceipt(ask.qitemId, episode.key)).toBe(true);
    } finally {
      w3.stop();
      db.close();
    }
  });

  it("polls and delivers Relay-primary alerts when Slack is disabled without minting new Slack buffer decisions, then enables Slack without replaying unbuffered Slack backlog while preserving earlier durable Slack buffer entries", async () => {
    const { writeFileSync } = await import("node:fs");
    const { createDb } = await import("../src/db/connection.js");
    const { migrate } = await import("../src/db/migrate.js");
    const { ALL_MIGRATIONS } = await import("../src/db/all-migrations.js");
    const { EventBus } = await import("../src/domain/event-bus.js");
    const { QueueRepository } = await import("../src/domain/queue-repository.js");
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/domain/gateway/slack/config.js");
    const { buildSlackGatewayWire } = await import("../src/domain/gateway/slack/slack-subsystem.js");
    const { resolveSlackHandle } = await import("../src/domain/gateway/human-registry.js");
    const { DispatchBuffer } = await import("../src/domain/gateway/dispatch-buffer.js");
    const { makeQueuePorts, seedBacklogAsHistory } = await import("../src/domain/gateway/slack/queue-access.js");
    const { toPayload } = await import("../src/domain/gateway/slack/outbound-driver.js");

    const db = createDb();
    migrate(db, ALL_MIGRATIONS);

    const slackSecrets = join(home, "slack.env");
    writeFileSync(slackSecrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    // Slack starts DISABLED
    saveConfig({ ...DEFAULT_CONFIG, enabled: false, channel: "C-MIXED", secretsEnvFile: slackSecrets }, home);

    const relaySecrets = join(home, "relay.env");
    writeFileSync(
      relaySecrets,
      [
        "OPENRIG_RELAY_URL=http://127.0.0.1:44102/outbound",
        "OPENRIG_RELAY_OUTBOUND_TOKEN=out-secret-token-123456",
        "OPENRIG_RELAY_INBOUND_TOKEN=in-secret-token-654321",
      ].join("\n"),
      { mode: 0o600 },
    );

    const registry = {
      ok: true as const,
      entities: [
        {
          entityId: "alex",
          class: "human" as const,
          displayName: "Alex",
          address: "alex@external",
          connectorBindings: [
            {
              kind: "slack" as const,
              connectorRef: "slack-main",
              secretsRef: `file:${slackSecrets}`,
              role: "primary" as const,
              handle: "UALEX",
            },
          ],
          prefs: { deliveryClass: "B" as const, availability: "available" as const },
        },
        {
          entityId: "sam",
          class: "human" as const,
          displayName: "Sam",
          address: "sam@external",
          connectorBindings: [
            {
              kind: "relay" as const,
              connectorRef: "wa-main",
              secretsRef: `file:${relaySecrets}`,
              role: "primary" as const,
              handle: "sam_wa",
            },
          ],
          prefs: { deliveryClass: "B" as const, availability: "available" as const },
        },
      ],
    };

    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => registry,
    });

    // 1. Earlier durable Slack ask already in DispatchBuffer before Slack was disabled
    const earlierSlackRow = await repo.create({
      sourceSession: "lead@rig",
      destinationSession: "orch@rig",
      body: "Earlier durable Slack ask body",
      nudge: false,
    });
    repo.update({
      qitemId: earlierSlackRow.qitemId,
      actorSession: "orch@rig",
      state: "blocked",
      blockedOn: "alex@kernel",
      summary: "Earlier durable Slack ask",
      evidenceRef: "/proof/earlier-slack.md",
      transitionNote: "parked earlier",
    });
    const [earlierAlert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({
      minimumLevel: "NOTICE",
    });
    new DispatchBuffer(home).enqueue({
      kind: "outbound_decision",
      decisionId: "earlier-durable-slack-1",
      op: OUTBOUND_OP,
      entityBindingRef: "alex@external",
      payload: toPayload(earlierAlert!),
    });

    // 2. Fresh Slack-primary ask and fresh Relay-primary ask created while Slack is disabled
    const freshSlackRow = await repo.create({
      sourceSession: "lead@rig",
      destinationSession: "orch@rig",
      body: "Fresh Slack backlog while disabled",
      nudge: false,
    });
    repo.update({
      qitemId: freshSlackRow.qitemId,
      actorSession: "orch@rig",
      state: "blocked",
      blockedOn: "alex@kernel",
      summary: "Slack backlog ask",
      evidenceRef: "/proof/fresh-slack.md",
      transitionNote: "parked while slack disabled",
    });

    const relayRow = await repo.create({
      sourceSession: "lead@rig",
      destinationSession: "orch@rig",
      body: "Fresh Relay ask while Slack disabled",
      nudge: false,
    });
    repo.update({
      qitemId: relayRow.qitemId,
      actorSession: "orch@rig",
      state: "blocked",
      blockedOn: "sam@kernel",
      summary: "Relay active ask",
      evidenceRef: "/proof/relay-active.md",
      transitionNote: "parked for relay",
    });

    const slackPosts: Array<Record<string, unknown>> = [];
    const relayPosts: Array<Record<string, unknown>> = [];

    const makeWire = () =>
      buildSlackGatewayWire({
        home,
        queueRepo: repo,
        registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
        outboundIntervalMs: 15,
        fetchImpl: async (url, init) => {
          if (String(url).includes("slack.com")) {
            slackPosts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
            return new Response(JSON.stringify({ ok: true, ts: "1724.0002" }), { status: 200 });
          }
          relayPosts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

    const w1 = makeWire();
    try {
      w1.startServices?.();
      await new Promise((r) => setTimeout(r, 60));
      // Relay ask delivered; Slack did not post
      expect(relayPosts).toHaveLength(1);
      expect(relayPosts[0]).toMatchObject({
        recipient: { handle: "sam_wa" },
        summary: "Relay active ask",
      });
      expect(slackPosts).toHaveLength(0);
      // Fresh Slack ask was NOT dispatched into the buffer while Slack was disabled;
      // only the pre-existing durable Slack decision remains in the buffer.
      expect(new DispatchBuffer(home).pending().map((d) => d.decisionId)).toEqual(["earlier-durable-slack-1"]);
    } finally {
      w1.stop();
    }

    // Now enable Slack: seed Slack-primary backlog as history, flip enabled=true, and restart wire
    const slackOnlyRegistry = {
      ...registry,
      entities: registry.entities.filter((e) =>
        e.connectorBindings.some((b) => b.role === "primary" && b.kind === "slack"),
      ),
    };
    await seedBacklogAsHistory({
      queue: makeQueuePorts(repo, { loadHumanRegistry: () => slackOnlyRegistry }),
      seen: new SeenStore(join(home, "state", "slack-outbound-seen.jsonl")),
      filter: { minimumLevel: "NOTICE" },
      buffer: new DispatchBuffer(home),
    });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MIXED", secretsEnvFile: slackSecrets }, home);

    const w2 = makeWire();
    try {
      w2.startServices?.();
      await new Promise((r) => setTimeout(r, 60));
      // Only the pre-existing durable Slack decision replays and posts; the fresh Slack backlog ask was seeded and never buffered
      expect(slackPosts).toHaveLength(1);
      expect(JSON.stringify(slackPosts[0])).toContain("Earlier durable Slack ask");
      expect(JSON.stringify(slackPosts)).not.toContain("Fresh Slack backlog while disabled");
      expect(new DispatchBuffer(home).pending()).toHaveLength(0);
    } finally {
      w2.stop();
      db.close();
    }
  });
});
