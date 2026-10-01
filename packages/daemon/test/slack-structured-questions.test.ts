// #193 — a decision may carry 1–4 structured questions, each with 2–4 clickable options.
// Slack renders them as buttons; a click (block_actions over Socket Mode) records that
// question's answer on the same item, and the decision resolves once every question has one.
// A typed reply in the thread still resolves the decision as before ("Other").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { queueRoutes } from "../src/routes/queue.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildOutboundMessage } from "../src/domain/gateway/slack/message.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { InboundReceiptStore } from "../src/domain/gateway/slack/state-store.js";

const human = "human-founder@external";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: human, summary: "Two quick questions", body: "Pick one for each; my recommendation is marked.", evidenceRef: "/private/proof.md", nudge: false };
const questions = [
  { id: "db", question: "Which database?", options: [{ id: "pg", label: "Postgres", recommended: true }, { id: "sqlite", label: "SQLite" }] },
  { id: "ship", question: "Ship this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
];

describe("structured human questions (#193)", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let bus: EventBus;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "human-questions-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  describe("create", () => {
    it("records the questions on a decision item", async () => {
      const created = await repo.create({ ...request, humanIntent: "decision", humanQuestions: questions });
      expect(repo.getById(created.qitemId)).toMatchObject({ humanQuestions: questions, humanAnswers: null });
    });

    it("accepts questions over HTTP, and answers a bad shape with a 400 that names the problem", async () => {
      const app = new Hono();
      app.use("*", async (c, next) => { (c.set as (k: string, v: unknown) => void)("queueRepo", repo); await next(); });
      app.route("/api/queue", queueRoutes());
      const create = (value: unknown) => app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": request.sourceSession }, body: JSON.stringify(value) });
      const ok = await create({ ...request, humanIntent: "decision", humanQuestions: questions });
      expect(ok.status).toBe(201);
      expect((await ok.json()).humanQuestions).toEqual(questions);
      const bad = await create({ ...request, humanIntent: "decision", humanQuestions: [] });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "invalid_human_questions" });
    });

    it("refuses questions on an update", async () => {
      await expect(repo.create({ ...request, humanIntent: "update", humanQuestions: questions })).rejects.toMatchObject({ code: "invalid_human_questions" });
    });

    it("refuses questions sent to an agent: no human is there to click", async () => {
      await expect(repo.create({ ...request, destinationSession: "worker@rig", humanQuestions: questions })).rejects.toMatchObject({ code: "invalid_human_questions" });
    });

    it("accepts questions when the intent is omitted: that is a decision (the CLI's documented default)", async () => {
      const created = await repo.create({ ...request, humanQuestions: questions });
      expect(repo.getById(created.qitemId)?.humanQuestions).toEqual(questions);
    });

    it.each([
      ["no questions", []],
      ["five questions", Array.from({ length: 5 }, (_, i) => ({ ...questions[0]!, id: `q${i}` }))],
      ["one option", [{ ...questions[0]!, options: [questions[0]!.options[0]!] }]],
      ["five options", [{ ...questions[0]!, options: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })) }]],
      ["duplicate question ids", [questions[0]!, { ...questions[1]!, id: "db" }]],
      ["duplicate option ids", [{ ...questions[0]!, options: [{ id: "pg", label: "A" }, { id: "pg", label: "B" }] }]],
      ["two recommended options", [{ ...questions[0]!, options: [{ id: "a", label: "A", recommended: true }, { id: "b", label: "B", recommended: true }] }]],
      ["an id with spaces", [{ ...questions[0]!, id: "which db" }]],
      ["an empty question", [{ ...questions[0]!, question: "  " }]],
      ["a label over Slack's 75-character button limit", [{ ...questions[0]!, options: [{ id: "a", label: "x".repeat(76) }, { id: "b", label: "B" }] }]],
      ["not an array", { id: "db" }],
    ])("refuses %s with a named error", async (_name, bad) => {
      await expect(repo.create({ ...request, humanIntent: "decision", humanQuestions: bad as never })).rejects.toMatchObject({ code: "invalid_human_questions" });
    });
  });

  describe("recording answers", () => {
    const answer = (qitemId: string, questionId: string, optionId: string, actorSession = human) => repo.recordHumanAnswer({ qitemId, actorSession, questionId, optionId });

    it("lets an answer change until the set is complete, then keeps the answers final for any retry", async () => {
      const { qitemId } = await repo.create({ ...request, humanIntent: "decision", humanQuestions: questions });
      expect(answer(qitemId, "db", "sqlite")).toMatchObject({ status: "recorded", complete: false });
      expect(answer(qitemId, "db", "pg")).toMatchObject({ status: "recorded", answers: { db: "pg" }, complete: false });
      expect(answer(qitemId, "ship", "yes")).toMatchObject({ status: "recorded", answers: { db: "pg", ship: "yes" }, complete: true });
      // A click after the last answer (e.g. while the hand-back is being retried) changes nothing.
      expect(answer(qitemId, "ship", "no")).toMatchObject({ status: "recorded", answers: { db: "pg", ship: "yes" }, complete: true });
      expect(repo.getById(qitemId)?.humanAnswers).toEqual({ db: "pg", ship: "yes" });
    });

    it("does not count a question named like a built-in object property as answered", async () => {
      const builtinNamed = [{ ...questions[0]!, id: "constructor" }, questions[1]!];
      const { qitemId } = await repo.create({ ...request, humanIntent: "decision", humanQuestions: builtinNamed });
      expect(answer(qitemId, "ship", "yes")).toMatchObject({ status: "recorded", answers: { ship: "yes" }, complete: false });
      expect(answer(qitemId, "constructor", "pg")).toMatchObject({ status: "recorded", answers: { ship: "yes", constructor: "pg" }, complete: true });
    });

    it("records nothing for another human, or once the decision is no longer pending", async () => {
      const { qitemId } = await repo.create({ ...request, humanIntent: "decision", humanQuestions: questions });
      expect(answer(qitemId, "db", "pg", "someone-else@external")).toMatchObject({ status: "not-applicable", reason: "not-the-asked-human" });
      repo.update({ qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "answered elsewhere" });
      expect(answer(qitemId, "db", "pg")).toMatchObject({ status: "not-applicable", reason: "state-done" });
      expect(repo.getById(qitemId)?.humanAnswers).toBeNull();
    });
  });

  describe("rendering", () => {
    type Block = { type: string; block_id?: string; text?: { text: string }; elements?: Array<{ type: string; action_id: string; value: string; style?: string; text: { type: string; text: string } }> };
    const render = () => buildOutboundMessage({ qitemId: "q", summary: "Two quick questions", body: "Pick one for each.", humanQuestions: questions }, { sourceLabel: "proof" });

    it("renders one button row per question, the recommended option styled primary", () => {
      const blocks = render().blocks as Block[];
      const rows = blocks.filter((b) => b.type === "actions");
      expect(rows.map((r) => r.block_id)).toEqual(["or-q:db", "or-q:ship"]);
      expect(rows[0]!.elements).toEqual([
        { type: "button", action_id: "or-opt:pg", value: "pg", style: "primary", text: { type: "plain_text", text: "Postgres" } },
        { type: "button", action_id: "or-opt:sqlite", value: "sqlite", text: { type: "plain_text", text: "SQLite" } },
      ]);
      // Each row follows its question's text.
      const dbRow = blocks.findIndex((b) => b.block_id === "or-q:db");
      expect(blocks[dbRow - 1]?.text?.text).toContain("Which database?");
    });

    it("keeps a complete text fallback: every question and option, the recommendation, and the typed-reply path", () => {
      const { text } = render();
      for (const s of ["Which database?", "Postgres (recommended)", "SQLite", "Ship this week?", "Yes", "No"]) expect(text).toContain(s);
      expect(text).toMatch(/reply in this thread/i);
      expect(JSON.stringify(render().blocks)).toMatch(/reply in this thread/i);
    });

    it("escapes question and option text like any other queue-authored field", () => {
      const { blocks } = buildOutboundMessage({ qitemId: "q", humanQuestions: [{ id: "a", question: "Ping <!channel>?", options: [{ id: "x", label: "<@U1>" }, { id: "y", label: "B" }] }] }, { sourceLabel: "proof" });
      const json = JSON.stringify(blocks);
      expect(json).not.toContain("<!channel>");
      expect(json).toContain("&lt;!channel&gt;");
    });

    it("renders a plain decision exactly as before", () => {
      const plain = buildOutboundMessage({ qitemId: "q", summary: "S", body: "B" }, { sourceLabel: "proof" });
      expect((plain.blocks as Block[]).some((b) => b.type === "actions")).toBe(false);
      expect(plain.text).not.toMatch(/reply in this thread/i);
    });
  });

  describe("answering through the real Slack wire", () => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    let posts: Array<Record<string, unknown>>;
    let socket: WsLike;
    let wire: ReturnType<typeof buildSlackGatewayWire>;
    beforeEach(async () => {
      const secrets = join(home, "fake.env");
      writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
      saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
      posts = [];
      const sockets: WsLike[] = [];
      const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
      const realResolve = makeHumanReplyResolver(repo, contract);
      resolveOverride = undefined;
      wire = buildSlackGatewayWire({
        home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
        resolveHumanReply: (input) => (resolveOverride ?? realResolve)(input),
        wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
        inboundMaxConnects: 1,
        inboundRetryIntervalMs: 50, // dead-lettered clicks retry promptly
        fetchImpl: async (url, init) => {
          if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
          posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` });
        },
      });
      stops.push(() => wire.stop()); wire.startServices?.();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      socket = sockets[0]!;
      socket.onopen?.();
      // Post the decision the way the outbound driver does, and wait for its receipt.
      const alert = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({}))[0];
      decisionId = (await repo.create({ ...request, humanIntent: "decision", humanQuestions: questions })).qitemId;
      wire.dispatcher.dispatch("post_message", human, await alert());
      await vi.waitFor(async () => expect(await alert()).toBeUndefined());
    });
    let decisionId: string;
    let resolveOverride: ((input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">) | undefined;
    // The inbound receipt ledger: every envelope ends with one typed disposition.
    const finals = (envelopeId: string) => new InboundReceiptStore(join(home, "state", "slack-inbound-receipts.jsonl")).readAll()
      .filter((r) => r.envelopeId === envelopeId && r.status !== "received");
    const threadAcks = () => posts.filter((p) => p.thread_ts === "1.1").map((p) => String(p.text));

    let clicks = 0;
    // A block_actions envelope, as Socket Mode delivers a button click on the root message "1.1".
    async function click(questionId: string, optionId: string, opts: { user?: string; actionTs?: string; root?: string } = {}): Promise<{ status: string; reason?: string }> {
      const actionTs = opts.actionTs ?? `${1000 + ++clicks}.5`;
      const before = finals(`e-${actionTs}`).length;
      socket.onmessage?.({ data: JSON.stringify({
        envelope_id: `e-${actionTs}`, type: "interactive",
        payload: {
          type: "block_actions", user: { id: opts.user ?? "UFOUNDER" }, channel: { id: "C-TEST" },
          container: { type: "message", message_ts: opts.root ?? "1.1", channel_id: "C-TEST" },
          message: { ts: opts.root ?? "1.1" },
          actions: [{ type: "button", block_id: `or-q:${questionId}`, action_id: `or-opt:${optionId}`, value: optionId, action_ts: actionTs }],
        },
      }) });
      await vi.waitFor(() => expect(finals(`e-${actionTs}`).length).toBe(before + 1));
      return finals(`e-${actionTs}`).at(-1)!;
    }
    const repliesToSeat = () => repo.list({ limit: 100 }).filter((q) => q.destinationSession === "author@rig");

    it("posts the buttons, records each click, and resolves back to the seat once every question is answered", async () => {
      expect(JSON.stringify(posts[0]?.blocks)).toContain("or-opt:pg");

      await click("db", "sqlite");
      await click("db", "pg"); // the human changes their mind before finishing
      expect(repo.getById(decisionId)).toMatchObject({ state: "pending", humanAnswers: { db: "pg" } });
      expect(repliesToSeat()).toEqual([]);

      await click("ship", "yes");
      expect(repo.getById(decisionId)).toMatchObject({ state: "done", humanAnswers: { db: "pg", ship: "yes" } });
      const [answer] = repliesToSeat();
      expect(answer?.sourceSession).toBe(human);
      expect(answer?.tags).toEqual(expect.arrayContaining([`reply-to:${decisionId}`, "human-answer"]));
      expect(answer?.body).toContain("Which database?: Postgres");
      expect(answer?.body).toContain("Ship this week?: Yes");
    });

    it("lands exactly one reply when the final click is replayed or clicked again", async () => {
      await click("db", "pg");
      await click("ship", "no", { actionTs: "2000.1" });
      await click("ship", "no", { actionTs: "2000.1" }); // Socket Mode redelivery
      await click("ship", "yes"); // a late click after the decision resolved
      expect(repliesToSeat()).toHaveLength(1);
      expect(repo.getById(decisionId)?.humanAnswers).toEqual({ db: "pg", ship: "no" });
    });

    it("refuses a click from someone who is not a registered human", async () => {
      await click("db", "pg", { user: "USTRANGER" });
      expect(repo.getById(decisionId)?.humanAnswers).toBeNull();
    });

    it("ignores a click naming a question or option the decision does not have", async () => {
      await click("db", "mysql");
      await click("region", "eu");
      expect(repo.getById(decisionId)?.humanAnswers).toBeNull();
    });

    it("with supplemental detail, the buttons ride the root post only, and a click there answers the decision", async () => {
      const withDetail = await repo.create({ ...request, humanIntent: "decision", humanQuestions: [questions[0]!], humanDetail: "Benchmarks: Postgres 2x faster on our load." });
      const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === withDetail.qitemId);
      wire.dispatcher.dispatch("post_message", human, alert);
      await vi.waitFor(() => expect(posts).toHaveLength(3));
      const [root, detail] = [posts[1]!, posts[2]!];
      expect(root.thread_ts).toBeUndefined();
      expect(JSON.stringify(root.blocks)).toContain("or-opt:pg");
      expect(detail.thread_ts).toBe("2.1");
      expect(JSON.stringify(detail.blocks)).not.toContain("or-opt:");
      expect(String(detail.text)).not.toContain("Which database?");

      await click("db", "pg", { root: "2.1" });
      expect(repo.getById(withDetail.qitemId)).toMatchObject({ state: "done", humanAnswers: { db: "pg" } });
      expect(repo.getById(decisionId)?.humanAnswers).toBeNull();
    });

    it("confirms each click in the decision's thread, naming what is still unanswered", async () => {
      await click("db", "pg");
      await vi.waitFor(() => expect(threadAcks()).toHaveLength(1));
      expect(threadAcks()[0]).toBe("Recorded: Which database?: Postgres. Still to answer: Ship this week?");
      await click("ship", "yes");
      await vi.waitFor(() => expect(threadAcks()).toHaveLength(2));
      expect(threadAcks()[1]).toBe("All answered, sent back: Which database?: Postgres; Ship this week?: Yes");
    });

    it("redacts secret-like question and option text in the click confirmations, as the question post does", async () => {
      const secretQuestions = [
        { id: "tok", question: "Rotate xoxb-LEAK-question?", options: [{ id: "a", label: "Use xoxb-LEAK-option" }, { id: "b", label: "Skip" }] },
        { id: "ship", question: "Ship this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      ];
      const secret = await repo.create({ ...request, humanIntent: "decision", humanQuestions: secretQuestions });
      const alert = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === secret.qitemId);
      wire.dispatcher.dispatch("post_message", human, await alert());
      await vi.waitFor(async () => expect(await alert()).toBeUndefined()); // posted and its thread mapped
      const acks = () => posts.filter((p) => p.thread_ts === "2.1").map((p) => String(p.text));

      await click("tok", "a", { root: "2.1" });
      await click("ship", "yes", { root: "2.1" });
      await vi.waitFor(() => expect(acks()).toHaveLength(2));
      expect(acks().join("\n")).not.toContain("xoxb-LEAK");
      expect(acks()[1]).toContain("[redacted-secret]");
    });

    it("recovers a failed hand-back without another click: the dead-letter retry lands it", async () => {
      const create = repo.create.bind(repo);
      vi.spyOn(repo, "create").mockImplementationOnce(async () => { throw new Error("database is locked"); }).mockImplementation(create);
      await click("db", "pg");
      expect(await click("ship", "yes")).toMatchObject({ status: "handler-failed" });
      await vi.waitFor(() => expect(repo.getById(decisionId)?.state).toBe("done"));
      expect(repliesToSeat()).toHaveLength(1);
    });

    it("does not report success when the resolve does not apply", async () => {
      resolveOverride = async () => "not-applicable";
      await click("db", "pg");
      expect(await click("ship", "yes")).toMatchObject({ status: "refused", reason: "resolve-not-applicable" });
      expect(threadAcks().some((t) => t.startsWith("All answered"))).toBe(false);
    });

    it("still resolves on a typed reply in the thread (the \"Other\" answer)", async () => {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-typed", type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "Neither — use DuckDB", ts: "3000.1", thread_ts: "1.1", channel: "C-TEST" } } }) });
      await vi.waitFor(() => expect(repo.getById(decisionId)?.state).toBe("done"));
      expect(repliesToSeat()[0]?.body).toContain("Neither — use DuckDB");
    });
  });
});
