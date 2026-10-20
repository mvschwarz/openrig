// Adapted from dev60-review's retained four-case #822 baseline (9d31add8).
// Slack HTTP/socket are inert; queue, thread routing and Mission Control resolution are real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
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

import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";

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
  let postHook: ((post: Record<string, unknown>) => Promise<Response | undefined>) | undefined;
  let logs: string[];
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "r822-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    posts = []; postHook = undefined; logs = [];
    const sockets: WsLike[] = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract, home),
      log: (message) => logs.push(message),
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        const post = JSON.parse(String(init?.body));
        posts.push(post);
        const overridden = await postHook?.(post);
        if (overridden) return overridden;
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
    expect(posts.at(-1)?.text).toContain("Reply in this thread after this question to answer it.");
    expect(JSON.stringify(posts.at(-1)?.blocks)).toContain("Earlier and extra messages still reach the agent as conversation.");
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

  it.each([
    { label: "missing reply time", posted: "11.1", messageTs: undefined, expected: "resolved-uncertain" },
    { label: "malformed reply time", posted: "11.1", messageTs: "later", expected: "resolved-uncertain" },
    { label: "equal times", posted: "11.1", messageTs: "11.100000", expected: "not-applicable" },
    { label: "legacy current receipt without kind", posted: "reconciled", messageTs: "30.1", kind: "", expected: "resolved-uncertain" },
    { label: "reconciled receipt without time", posted: "reconciled", messageTs: "30.1", expected: "resolved-uncertain" },
    { label: "missing receipt time", posted: "", messageTs: "30.1", expected: "resolved-uncertain" },
    { label: "legacy summary digest receipt", posted: "11.1", messageTs: "30.1", digest: "old-summary", expected: "resolved-uncertain" },
    { label: "one microsecond earlier", posted: "1800000000.123456", messageTs: "1800000000.123455", expected: "not-applicable" },
    { label: "one microsecond later", posted: "1800000000.123456", messageTs: "1800000000.123457", expected: "resolved" },
  ])("keeps receipt/time uncertainty honest: $label", async ({ posted, messageTs, expected, ...extra }) => {
    await say(undefined, "5.1", "Check this build.");
    const row = inboundRow("5.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const park = latestPark(row.qitemId);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote:
      `slack-owner-notification-posted notification_key=${episodeKey(row.qitemId, park.transitionId)} ${extra.kind === "" ? "" : "kind=human-required "}message_ts=${posted} thread_ts=5.1${extra.digest ? ` digest=${extra.digest}` : ""}` });
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    const resolver = makeHumanReplyResolver(repo, contract, home);
    expect(await resolver({ qitemId: row.qitemId, actorSession: human, decision: "The release branch.", messageTs })).toBe(expected);
    expect(repo.getById(row.qitemId)?.state).toBe(expected.startsWith("resolved") ? "in-progress" : "blocked");
    if (expected === "resolved") {
      // Replay is absorbed without requiring a new timestamp or another resolve.
      expect(await resolver({ qitemId: row.qitemId, actorSession: human, decision: "The release branch." })).toBe("already-resolved");
    }
  });

  it("a current digest posts the whole question with its own receipt before the answer", async () => {
    await say(undefined, "6.1", "Check this build.");
    const row = inboundRow("6.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const park = latestPark(row.qitemId);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote:
      `delivery-decision: digest notification_key=${episodeKey(row.qitemId, park.transitionId)} window=4h` });
    const { runDeliveryDigestFlush } = await import("../src/domain/policies/delivery-digest-flush.js");
    const result = await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: () => registry }, home,
      window: "4h", dispatch: (...args) => wire.dispatcher.dispatch(...args) });
    expect(result.dispatched).toBe(1);
    await vi.waitFor(() => expect(repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, episodeKey(row.qitemId, park.transitionId))).toBe(true));
    expect(JSON.stringify(posts.at(-1))).toContain("Which branch?");
    await say("6.1", "30.1", "Release.");
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.state).toBe("in-progress"));
  });


  it("does not resolve when reading the current receipt fails", async () => {
    await say(undefined, "7.1", "Check this build.");
    const row = inboundRow("7.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const read = vi.spyOn(repo.transitionLog, "getOwnerNotificationReceipt").mockImplementation(() => { throw new Error("receipt read unavailable"); });
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    try {
      await expect(makeHumanReplyResolver(repo, contract)({ qitemId: row.qitemId, actorSession: human, decision: "Release.", messageTs: "30.1" })).rejects.toThrow("receipt read unavailable");
      expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    } finally { read.mockRestore(); }
  });

  it("uses the current primary before the supplemental post finishes, without marking full delivery early", async () => {
    await say(undefined, "8.1", "Check this build.");
    const row = inboundRow("8.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const key = episodeKey(row.qitemId, latestPark(row.qitemId).transitionId);
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === row.qitemId)!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    postHook = async (post) => { if (String(post.text).includes("SUPPLEMENTAL-DETAIL")) await held; return undefined; };
    try {
      expect(wire.dispatcher.dispatch("post_message", human, { ...alert, humanDetail: "SUPPLEMENTAL-DETAIL" })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(posts).toHaveLength(2));
      const buffer = new DispatchBuffer(home);
      expect(buffer.pending()).toHaveLength(1);
      expect(repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, key)).toBe(false);
      expect(readFileSync(join(home, "state/slack-attempted-decisions.jsonl"), "utf8")).toContain("::primary-receipt::");
      await say("8.1", "8.2", "Early context."); // older person-root time is NOT the question time
      expect(repo.getById(row.qitemId)?.state).toBe("blocked");
      await say("8.1", "30.1", "Release.");
      expect(repo.getById(row.qitemId)?.state).toBe("in-progress");
      expect(resolveNote(row.qitemId)).toBe("Release.");
      expect(buffer.pending()).toHaveLength(1);
      expect(repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, key)).toBe(false);
      release();
      await vi.waitFor(() => expect(buffer.pending()).toHaveLength(0));
      expect(repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, key)).toBe(true);
      expect(posts).toHaveLength(2); // no primary replay or uncertainty notice
    } finally { release(); }
  });

  it.each(["reconciled", "", "11.1"])("a current degraded/legacy receipt %s resumes with separate agent context and a real human notice", async (posted) => {
    await say(undefined, "9.1", "Check this build.");
    const row = inboundRow("9.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const key = episodeKey(row.qitemId, latestPark(row.qitemId).transitionId);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote:
      `slack-owner-notification-posted notification_key=${key} kind=human-required message_ts=${posted} thread_ts=9.1${posted === "11.1" ? " digest=legacy" : ""}` });
    await say("9.1", "30.1", "Not approved; investigate first.");
    expect(repo.getById(row.qitemId)?.state).toBe("in-progress");
    expect(inboundRow("30.1")?.body).toMatch(/^Not approved; investigate first\./);
    expect(resolveNote(row.qitemId)).toContain("Not approved; investigate first.");
    expect(resolveNote(row.qitemId)).toContain("OpenRig timing context");
    expect(resolveNote(row.qitemId)).toContain("could not be confirmed");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C-TEST", thread_ts: "9.1" });
    expect(posts[0]?.text).toContain("could not verify");
    await say("9.1", "30.1", "Not approved; investigate first.");
    expect(posts).toHaveLength(1); // replay does not resolve or acknowledge twice
    expect(repo.transitionLog.listForQitem(row.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved")).toHaveLength(1);
  });

  it("a reply before a timed legacy summary is still proven early", async () => {
    await say(undefined, "10.1", "Check this build.");
    const row = inboundRow("10.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const key = episodeKey(row.qitemId, latestPark(row.qitemId).transitionId);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote:
      `slack-owner-notification-posted notification_key=${key} kind=human-required message_ts=20.1 thread_ts=10.1 digest=legacy` });
    await say("10.1", "15.1", "More context.");
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(posts).toHaveLength(0);
  });

  it.each(["older-episode", "qitem-only", "wrong-kind", "conflicting", "malformed", "unreadable"])("does not infer current delivery from %s primary evidence", async (scenario) => {
    await say(undefined, "12.1", "Check this build.");
    const row = inboundRow("12.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const key = episodeKey(row.qitemId, latestPark(row.qitemId).transitionId);
    const buffer = new DispatchBuffer(home);
    buffer.enqueue({ kind: "outbound_decision", decisionId: "pending", op: "post_message", entityBindingRef: human, payload: {
      qitemId: row.qitemId, notificationKey: scenario === "older-episode" ? `${row.qitemId}:0` : scenario === "qitem-only" ? row.qitemId : key,
      ownerNotificationKind: scenario === "wrong-kind" ? "human-update" : "human-required",
    } });
    const attempted = new SeenStore(join(home, "state/slack-attempted-decisions.jsonl"));
    const mark = (time: string) => attempted.mark(`pending::primary-receipt::${Buffer.from(JSON.stringify({ messageTs: time, threadTs: "12.1" })).toString("base64url")}`, "primary-receipt");
    mark(scenario === "malformed" ? "not-a-time" : "11.1");
    if (scenario === "conflicting") mark("13.1");
    if (scenario === "unreadable") { rmSync(join(home, "state/slack-attempted-decisions.jsonl")); mkdirSync(join(home, "state/slack-attempted-decisions.jsonl")); }
    await say("12.1", "30.1", "Release.");
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(inboundRow("30.1")?.replyTo).toBe(row.qitemId);
    expect(posts).toHaveLength(0);
  });

  it("a failed uncertainty notice stays failed and a retry never repeats the durable resolve or question", async () => {
    await say(undefined, "13.1", "Check this build.");
    const row = inboundRow("13.1")!;
    parkOnPerson(row.qitemId, "Which branch?");
    const key = episodeKey(row.qitemId, latestPark(row.qitemId).transitionId);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote:
      `slack-owner-notification-posted notification_key=${key} kind=human-required message_ts=reconciled thread_ts=13.1` });
    postHook = async () => reply({ ok: false, error: "invalid_auth" });
    await say("13.1", "30.1", "Investigate first.");
    expect(repo.getById(row.qitemId)?.state).toBe("in-progress");
    expect(logs.some((line) => line.includes("acknowledgement not posted"))).toBe(true);
    expect(new SeenStore(join(home, "state/slack-inbound-seen.jsonl")).load().has("C-TEST:30.1")).toBe(false);
    expect(readFileSync(join(home, "state/slack-inbound-deadletter.jsonl"), "utf8")).toContain("30.1");
    parkOnPerson(row.qitemId, "A new question while the old notice is owed.");
    postHook = undefined;
    await say("13.1", "30.1", "Investigate first.");
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(new SeenStore(join(home, "state/slack-inbound-seen.jsonl")).load().has("C-TEST:30.1")).toBe(true);
    expect(posts).toHaveLength(2); // failed notice then successful notice, no question
    expect(repo.transitionLog.listForQitem(row.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved")).toHaveLength(1);
  });
});
