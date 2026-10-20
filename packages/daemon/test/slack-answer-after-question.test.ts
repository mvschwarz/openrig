// Adapted from dev60-review's retained four-case #822 baseline (9d31add8).
// Slack HTTP/socket are inert; queue, thread routing and Mission Control resolution are real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";

const human = "human-founder@external";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("#822: replies answer only the current posted question", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let bus: EventBus;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  let socket: WsLike;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "r822-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    posts = [];
    const sockets: WsLike[] = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract),
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        posts.push(JSON.parse(String(init?.body)));
        return reply({ ok: true, ts: `${10 + posts.length}.1` });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    socket = sockets[0]!;
    socket.onopen?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  // The person types a message (top-level when threadTs is undefined).
  const say = async (threadTs: string | undefined, ts: string, text: string) => {
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text, ts, thread_ts: threadTs, channel: "C-TEST" } } }) });
    await new Promise((r) => setTimeout(r, 50));
  };
  const inboundRow = (ts: string) =>
    repo.getById(`qitem-slack-inbound-${createHash("sha256").update(`C-TEST:${ts}`).digest("hex").slice(0, 20)}`);
  // The seat parks the person's row on that person (rig queue block --on <person>).
  const parkOnPerson = (qitemId: string, summary: string) =>
    repo.update({ qitemId, actorSession: "operator-agent@kernel", state: "blocked", blockedOn: "human-founder@kernel", summary, evidenceRef: "/proof/ask.md", transitionNote: "asked the person" });
  const latestPark = (qitemId: string) =>
    repo.transitionLog.listForQitem(qitemId).filter((t) => t.ownerNotificationKind === "human-required").at(-1)!;
  const receipts = (qitemId: string) =>
    repo.transitionLog.listForQitem(qitemId).map((t) => t.transitionNote ?? "").filter((n) => n.startsWith("slack-owner-notification-posted "));
  const field = (note: string, name: string) => note.split(/\s+/).find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1);
  const episodeKey = (qitemId: string, transitionId: number | string) => `${qitemId}:${transitionId}`;
  const resolveNote = (qitemId: string) =>
    repo.transitionLog.listForQitem(qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").at(-1)?.transitionNote ?? null;
  // What the outbound sweep would do next: post the row's pending owner notification, if any.
  async function sweep(qitemId: string): Promise<void> {
    const pending = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId);
    const alert = await pending();
    if (!alert) return;
    wire.dispatcher.dispatch("post_message", human, alert);
    await vi.waitFor(async () => expect(await pending()).toBeUndefined());
  }

  it("1. an early follow-up stays ordinary context and the question still posts", async () => {
    await say(undefined, "1.1", "Can you check the build?");
    const row = inboundRow("1.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const park = latestPark(row.qitemId);

    await say("1.1", "1.2", "Also, it's the release branch.");
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(resolveNote(row.qitemId)).toBeNull();
    expect(inboundRow("1.2")).toMatchObject({ destinationSession: "operator-agent@kernel", replyTo: row.qitemId }); // its own row too

    await sweep(row.qitemId);
    const notes = receipts(row.qitemId);
    expect(notes.some((n) => n.includes(`notification_key=${episodeKey(row.qitemId, park.transitionId)}`))).toBe(true);
    const posted = notes.at(-1)!;
    expect(field(posted, "kind")).toBe("human-required");
    expect(field(posted, "thread_ts")).toBe("1.1");
  });

  it("2. a delayed early follow-up stays context despite the existing receipt", async () => {
    await say(undefined, "2.1", "Can you check the build?");
    const row = inboundRow("2.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const park = latestPark(row.qitemId);
    await sweep(row.qitemId); // the question posts, into the person's own thread (Q2)
    expect(posts.at(-1)?.thread_ts).toBe("2.1");
    const question = receipts(row.qitemId).find((n) => n.includes(`notification_key=${episodeKey(row.qitemId, park.transitionId)}`))!;
    expect(question).toBeDefined();
    expect(field(question, "thread_ts")).toBe("2.1");
    const askedTs = field(question, "message_ts")!;

    await say("2.1", "2.2", "Written before the question appeared."); // Slack ts before the question's, delivered after its receipt
    expect(Number("2.2")).toBeLessThan(Number(askedTs));
    expect(repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, episodeKey(row.qitemId, park.transitionId))).toBe(true);
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(resolveNote(row.qitemId)).toBeNull();
    expect(inboundRow("2.2")).toMatchObject({ destinationSession: "operator-agent@kernel", replyTo: row.qitemId });
  });

  it("3. a genuine reply after the question posted resolves it", async () => {
    await say(undefined, "3.1", "Can you check the build?");
    const row = inboundRow("3.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const park = latestPark(row.qitemId);
    await sweep(row.qitemId);
    const askedTs = field(receipts(row.qitemId).find((n) => n.includes(`notification_key=${episodeKey(row.qitemId, park.transitionId)}`))!, "message_ts")!;

    await say("3.1", "30.1", "The release branch.");
    expect(Number("30.1")).toBeGreaterThan(Number(askedTs));
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.state).toBe("in-progress"));
    expect(resolveNote(row.qitemId)).toBe("The release branch.");
  });

  it("4. a re-park ignores the older receipt until the current question posts", async () => {
    await say(undefined, "4.1", "Can you check the build?");
    const row = inboundRow("4.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const first = latestPark(row.qitemId);
    await sweep(row.qitemId); // question 1 posts
    await say("4.1", "40.1", "The release branch.");
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.state).toBe("in-progress"));
    await sweep(row.qitemId); // the "resolved" notice posts

    parkOnPerson(row.qitemId, "Should I also tag it?");
    const second = latestPark(row.qitemId);
    expect(second.transitionId).not.toBe(first.transitionId);
    expect(repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, episodeKey(row.qitemId, first.transitionId))).toBe(true);
    expect(repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, episodeKey(row.qitemId, second.transitionId))).toBe(false);
    const newestPostedTs = Math.max(...receipts(row.qitemId).map((n) => Number(field(n, "message_ts"))));

    await say("4.1", "41.1", "One more thing about the build."); // before question 2 posts, after every earlier post
    expect(Number("41.1")).toBeGreaterThan(newestPostedTs); // a ts check against ANY receipt would pass it
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(resolveNote(row.qitemId)).toBe("The release branch."); // only episode one's decision
    expect(inboundRow("41.1")).toMatchObject({ destinationSession: "operator-agent@kernel", replyTo: row.qitemId });
    await sweep(row.qitemId);
    expect(receipts(row.qitemId).some((n) => n.includes(`notification_key=${episodeKey(row.qitemId, second.transitionId)}`))).toBe(true);
    await say("4.1", "42.1", "Yes, tag it.");
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.state).toBe("in-progress"));
    expect(resolveNote(row.qitemId)).toBe("Yes, tag it.");
  });
});
