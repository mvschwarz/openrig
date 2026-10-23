// An ask to a person lands on Steering with no Slack alert unless it's marked alert-worthy (humanAlert): the same item,
// visible and answerable on Steering either way, with one Slack post only for the alert-worthy one. The existing
// classifier stores the choice with the create (RECORD for Steering only, ALERT for an alert), and the existing Slack
// selection, posting dial, quiet hours and stuck sweep act on it. Real SQLite (all migrations), the real queue, the real
// gateway wire and its own outbound driver over a recording fetch, the real quiet-hours store and release job. No Slack.
// Native: NOT RUN.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { QUIET_RELEASE_POLICY, runQuietRelease } from "../src/domain/policies/quiet-release.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { Hono } from "hono";
import { attentionRoutes } from "../src/routes/attention.js";
import { queueRoutes } from "../src/routes/queue.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import type { AttentionRead } from "../src/attention-surface.js";

const HUMAN = "human-founder";
/** The people, with their Slack subscription's preset (absent = the default). */
const registryWith = (preset?: "every-ask" | "urgent-only") => ({
  ok: true as const,
  entities: [{
    entityId: HUMAN, class: "human" as const, displayName: "Founder", address: `${HUMAN}@external`,
    connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }],
    prefs: { deliveryClass: "B" as const, availability: "available" as const },
    ...(preset ? { subscriptions: [{ destination: { connector: "slack" as const }, filter: { preset } }] } : {}),
  }, {
    // A registered person addressed as a kernel alias, which no human-* name pattern matches.
    entityId: "operator-admin", class: "human" as const, displayName: "Operator", address: "operator-admin@external",
    connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UOPERATOR" }],
    prefs: { deliveryClass: "B" as const, availability: "available" as const },
    ...(preset ? { subscriptions: [{ destination: { connector: "slack" as const }, filter: { preset } }] } : {}),
  }],
});
// Most cases here are a person whose Slack subscription is urgent-only (plain asks wait on Steering); the default cases reset it.
let registry = registryWith("urgent-only");
const QUESTION = [{ id: "q1", question: "A or B?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }];

describe("an ask to a person is on Steering and the TUI; Slack gets it by their Slack subscription", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let bus: EventBus;
  let home: string;
  const posts: Array<Record<string, unknown>> = [];
  /** A destination whose rig has left the topology, so the queue refuses rows to it. */
  let unreachable: string | null = null;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    unreachable = null;
    registry = registryWith("urgent-only");
    repo = newRepo();
    home = mkdtempSync(join(tmpdir(), "steering-only-"));
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    posts.length = 0;
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  function newRepo(): QueueRepository {
    bus = new EventBus(db);
    return new QueueRepository(db, bus, { validateRig: (session) => session !== unreachable, loadHumanRegistry: () => registry });
  }
  let n = 0;
  async function ask(opts: { alert?: boolean; questions?: boolean } = {}): Promise<QueueItem> {
    n += 1;
    return repo.create({ sourceSession: "orch-lead@r", destinationSession: `${HUMAN}@kernel`, body: `ask body ${n}`,
      summary: `Ask ${n}`, evidenceRef: `/proof/${n}.md`, nudge: false,
      ...(opts.alert !== undefined ? { humanAlert: opts.alert } : {}), ...(opts.questions ? { humanQuestions: QUESTION } : {}) });
  }
  function wire() {
    return buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, outboundIntervalMs: 20,
      fetchImpl: async (url, init) => {
        if (String(url).includes("chat.postMessage")) {
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, ts: `1724.9${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  }
  /** The real wire with its own outbound driver, for several of its sweeps; then stopped. */
  async function runGateway(during?: (w: ReturnType<typeof wire>) => Promise<unknown>): Promise<void> {
    const w = wire();
    w.startServices?.();
    try {
      await during?.(w);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally { w.stop(); }
  }
  const posted = (row: QueueItem) => JSON.stringify(posts).includes(String(row.body));
  const onSteering = () => repo.listAttention({}).map((item) => item.qitemId);
  const owner = (row: QueueItem) => repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
  /** The daemon's own readers as the TUI and Steering call them: the queue list, the Feed, and the mission-control write. */
  function readers() {
    const app = new Hono();
    const eventBus = bus;
    const writeContract = new MissionControlWriteContract({ db, eventBus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo as never);
      c.set("eventBus" as never, eventBus as never);
      c.set("missionControlWriteContract" as never, writeContract as never);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    app.route("/api/attention", attentionRoutes());
    app.route("/api/mission-control", missionControlRoutes());
    return app;
  }
  type Feed = { items: Array<{ id: string; recipient?: string; answer?: { verb: "approve"; actorSession: string } }>; detail: { lines: string[] } | null };
  const feed = async (app: Hono, row?: QueueItem) =>
    (await app.request(`/api/attention${row ? `?item=${encodeURIComponent(`queue:${row.qitemId}`)}` : ""}`)).json() as Promise<Feed>;

  it("an ordinary ask is on Steering and answerable there, with no Slack alert", async () => {
    const row = await ask();
    expect(owner(row)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "RECORD" });
    expect(onSteering()).toContain(row.qitemId);
    await runGateway();
    expect(posts).toHaveLength(0);
    expect(repo.waitingView(row.qitemId)!.nextBackstop).toMatchObject({ mechanism: expect.stringMatching(/^none \(on Steering/) });
    repo.update({ qitemId: row.qitemId, actorSession: `${HUMAN}@kernel`, state: "done", closureReason: "no-follow-on",
      resolution: "B", transitionNote: "answered on Steering" });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "done", resolution: "B" });
  });

  it("an alert reaches only the ask marked alert-worthy: one post of the same item, which stays on Steering", async () => {
    const quiet = await ask();
    const urgent = await ask({ alert: true });
    expect(owner(urgent)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    await runGateway();
    expect(posts).toHaveLength(1);
    expect(posted(urgent)).toBe(true);
    expect(posted(quiet)).toBe(false);
    expect(JSON.stringify(posts[0])).toContain("<@UFOUNDER>"); // an alerted ask stands out: an interrupt, with a mention
    const receipts = (row: QueueItem) => repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
    expect(receipts(urgent)).toHaveLength(1);
    expect(receipts(urgent)[0]!.transitionNote).toContain(`notification_key=${urgent.qitemId}:`);
    expect(receipts(quiet)).toHaveLength(0);
    expect(onSteering()).toEqual(expect.arrayContaining([quiet.qitemId, urgent.qitemId]));
    // An update and an agent destination can't be marked: an alert is for an ask to a person.
    await expect(repo.create({ sourceSession: "orch-lead@r", destinationSession: `${HUMAN}@kernel`, body: "fyi", summary: "FYI",
      evidenceRef: "/proof/fyi.md", humanIntent: "update", humanAlert: true, nudge: false })).rejects.toThrow(/humanAlert/);
    await expect(repo.create({ sourceSession: "orch-lead@r", destinationSession: "dev@r", body: "work", humanAlert: true, nudge: false }))
      .rejects.toThrow(/humanAlert/);
  });

  it("an answer is recorded once, from Steering or from Slack", async () => {
    const quiet = await ask({ questions: true });
    const urgent = await ask({ alert: true, questions: true });
    await runGateway();
    expect(posts).toHaveLength(1);
    // Steering: the quiet ask is answered and closed there; a second answer, from either surface, records nothing more.
    repo.update({ qitemId: quiet.qitemId, actorSession: `${HUMAN}@kernel`, state: "done", closureReason: "no-follow-on",
      resolution: "A", transitionNote: "answered on Steering" });
    expect(() => repo.update({ qitemId: quiet.qitemId, actorSession: `${HUMAN}@kernel`, state: "done", closureReason: "no-follow-on",
      resolution: "B", transitionNote: "answered again" })).toThrow();
    expect(repo.recordHumanAnswer({ qitemId: quiet.qitemId, actorSession: `${HUMAN}@kernel`, questionId: "q1", optionId: "b" }))
      .toMatchObject({ status: "not-applicable", reason: "state-done" });
    expect(repo.getById(quiet.qitemId)).toMatchObject({ resolution: "A" });
    // Slack: the alerted ask's button answer is recorded on the same item, once, and Steering reads it there.
    expect(repo.recordHumanAnswer({ qitemId: urgent.qitemId, actorSession: `${HUMAN}@kernel`, questionId: "q1", optionId: "a" }))
      .toMatchObject({ status: "recorded", complete: true });
    expect(repo.recordHumanAnswer({ qitemId: urgent.qitemId, actorSession: `${HUMAN}@kernel`, questionId: "q1", optionId: "b" }))
      .toMatchObject({ status: "recorded", answers: { q1: "a" } });
    expect(repo.getById(urgent.qitemId)!.humanAnswers).toEqual({ q1: "a" });
    expect(posts).toHaveLength(1);
  });

  it("a handoff to a person lands on Steering too, and --alert on it alerts the same item once", async () => {
    const work = () => repo.create({ sourceSession: "orch-lead@r", destinationSession: "dev@r", body: "work", nudge: false });
    const quiet = (await repo.handoff({ qitemId: (await work()).qitemId, fromSession: "dev@r", toSession: `${HUMAN}@kernel`,
      body: "handed body quiet", summary: "Pick", evidenceRef: "/proof/h1.md", nudge: false })).created;
    const urgent = (await repo.handoffAndComplete({ qitemId: (await work()).qitemId, fromSession: "dev@r", toSession: `${HUMAN}@kernel`,
      body: "handed body urgent", summary: "Approve now", evidenceRef: "/proof/h2.md", humanAlert: true, nudge: false })).created;
    expect(owner(quiet)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "RECORD" });
    expect(owner(urgent)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    await runGateway();
    expect(posts).toHaveLength(1);
    expect(posted(urgent)).toBe(true);
    expect(onSteering()).toEqual(expect.arrayContaining([quiet.qitemId, urgent.qitemId]));
    await expect(repo.handoff({ qitemId: (await work()).qitemId, fromSession: "dev@r", toSession: "qa@r", body: "x", humanAlert: true, nudge: false }))
      .rejects.toThrow(/humanAlert/);
  });

  it("a quiet ask to a registered person's alias is on Steering and the Feed, which say it wasn't sent to Slack", async () => {
    const row = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "operator-admin@kernel", body: "alias ask body",
      summary: "Alias ask", evidenceRef: "/proof/alias.md", nudge: false });
    expect(owner(row)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "RECORD" });
    expect(onSteering()).toContain(row.qitemId);
    expect(repo.waitingView(row.qitemId)!.nextBackstop).toMatchObject({ mechanism: expect.stringMatching(/^none \(on Steering/) });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); await next(); });
    app.route("/api/attention", attentionRoutes());
    const read = await (await app.request(`/api/attention?item=${encodeURIComponent(`queue:${row.qitemId}`)}`)).json() as {
      items: Array<{ id: string; recipient: string }>; detail: { lines: string[] } | null };
    expect(read.items).toContainEqual(expect.objectContaining({ id: `queue:${row.qitemId}`, recipient: "operator-admin@kernel" }));
    expect(read.detail!.lines).toContain("Slack: not sent: created without --alert, and this person's Slack subscription is urgent-only");
    await runGateway();
    expect(posts).toHaveLength(0);
  });

  it("a quiet ask rerouted to an agent returns to agent rules: off Steering, and the unclaimed sweep watches it", async () => {
    const row = await ask();
    repo.routeToFallback(row.qitemId, "dev@r", "the person is unavailable");
    expect(repo.humanAskWithoutAlert(row.qitemId)).toBe(false);
    expect(onSteering()).not.toContain(row.qitemId);
    expect(repo.waitingView(row.qitemId)!.nextBackstop?.mechanism ?? "").not.toMatch(/on Steering/);
    const past = new Date(Date.now() - 120 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, row.qitemId);
    await runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60, log: () => {}, isRegisteredHost: () => false });
    const findings = repo.list({ limit: 500 }).filter((item) => (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG)
      && (item.tags ?? []).some((tag) => tag.endsWith(`:${row.qitemId}`)));
    expect(findings.length).toBeGreaterThan(0);
  });

  it("an ask posts to Slack only with --alert, whatever Slack's posting dial says", async () => {
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: join(home, "slack.env"), minimumLevelThatPosts: "RECORD" }, home);
    const quiet = await ask();
    const urgent = await ask({ alert: true });
    await runGateway();
    expect(posts).toHaveLength(1);
    expect(posted(urgent)).toBe(true);
    expect(posted(quiet)).toBe(false);
    expect(repo.deliveryOutcomeFor(quiet.qitemId)).toBeNull();
    expect(repo.waitingView(quiet.qitemId)!.nextBackstop).toMatchObject({ mechanism: expect.stringMatching(/^none \(on Steering/) });
  });

  it("every attention reader shares one membership: alias asks are in ?attention=1, and an alerted one stays in the Feed after its post", async () => {
    const aliasAsk = (alert: boolean) => repo.create({ sourceSession: "orch-lead@r", destinationSession: "operator-admin@kernel",
      body: `alias ask ${alert ? "urgent" : "quiet"}`, summary: "Alias ask", evidenceRef: "/proof/alias.md", nudge: false, ...(alert ? { humanAlert: true } : {}) });
    const quiet = await aliasAsk(false);
    const urgent = await aliasAsk(true);
    await runGateway();
    expect(posted(urgent)).toBe(true);
    expect(posted(quiet)).toBe(false);
    const app = readers();
    const listed = await (await app.request("/api/queue/list?attention=1")).json() as Array<{ qitemId: string }>;
    expect(listed.map((row) => row.qitemId)).toEqual(expect.arrayContaining([quiet.qitemId, urgent.qitemId]));
    expect((await feed(app)).items.map((item) => item.id)).toEqual(expect.arrayContaining([`queue:${quiet.qitemId}`, `queue:${urgent.qitemId}`]));
  });

  it("the Feed shows an alerted ask's real receipt: none yet, then its transport failure", async () => {
    const row = await ask({ alert: true });
    const app = readers();
    expect((await feed(app, row)).detail!.lines).toContain("Slack: no receipt yet");
    const key = `${row.qitemId}:${owner(row)!.transitionId}`;
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-transport-failed notification_key=${key} level=ALERT detail=http-500` });
    expect((await feed(app, row)).detail!.lines.find((line) => line.startsWith("Slack: "))).toMatch(/^Slack: transport-failed: .*http-500/);
  });

  it("an ask is answered in the TUI as on Steering: the Feed serves Approve as the person, and it closes that same row", async () => {
    const row = await ask();
    const twin = await ask();
    const parked = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "dev@r", body: "work", nudge: false });
    repo.update({ qitemId: parked.qitemId, actorSession: "dev@r", state: "blocked", blockedOn: `${HUMAN}@kernel`, summary: "Parked",
      evidenceRef: "/proof/parked.md", transitionNote: "parked on the person" });
    const app = readers();
    const read = await feed(app, row);
    const item = read.items.find((entry) => entry.id === `queue:${row.qitemId}`)!;
    expect(item.answer).toEqual({ verb: "approve", actorSession: `${HUMAN}@kernel` });
    expect(read.items.find((entry) => entry.id === `queue:${parked.qitemId}`)?.answer).toBeUndefined();
    const act = (body: Record<string, unknown>) => app.request("/api/mission-control/action", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    // The TUI posts the served answer; Steering's Approve posts its own card's body for the twin.
    expect((await act({ verb: item.answer!.verb, qitemId: row.qitemId, actorSession: item.answer!.actorSession })).ok).toBe(true);
    expect((await act({ verb: "approve", qitemId: twin.qitemId, actorSession: `${HUMAN}@kernel` })).ok).toBe(true);
    const closing = (id: string) => {
      const last = repo.listTransitions(id).at(-1)!;
      return { state: last.state, closureReason: last.closureReason, actorSession: last.actorSession, identityProvenance: last.identityProvenance };
    };
    expect(closing(row.qitemId)).toEqual(closing(twin.qitemId));
    expect(closing(row.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on", actorSession: `${HUMAN}@kernel` });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "done" });
    expect(onSteering()).not.toContain(row.qitemId);
    // Neither answered ask ever went to Slack (the row parked on the person alerts, as parks do).
    await runGateway();
    expect(posted(row) || posted(twin)).toBe(false);
  });

  /** The TUI itself over these readers: its daemon client, its Feed model, and an act's write as its driver loop sends it. */
  async function tui(app: Hono) {
    const { DaemonClient } = await import("../../tui/src/daemon-client.js");
    const { attentionLines, replyAct } = await import("../../tui/src/attention/attention-model.js");
    const { createViewState, emptySnapshot } = await import("../../tui/src/state.js");
    const client = new DaemonClient({ baseUrl: "http://tui.test", fetchImpl: ((input: string, init?: RequestInit) => app.request(String(input), init)) as typeof fetch });
    const open = async (row: QueueItem) => {
      const id = `queue:${row.qitemId}`;
      const read = await client.humanAttention(id) as AttentionRead;
      const lines = attentionLines({ ...createViewState({ instanceId: "fixture" }).get(), attentionOpen: id }, { ...emptySnapshot(), attentionRead: read }, 400);
      return { read, lines, act: (label: string) => lines.find((line) => line.text.includes(label))?.action };
    };
    const run = (action: unknown) => {
      const { type: _type, act: _act, ...input } = action as { type: "act"; act: "answer" } & Parameters<typeof client.missionControlAction>[0];
      return client.missionControlAction(input);
    };
    const reply = async (row: QueueItem, words: string) => run(replyAct((await open(row)).read, `queue:${row.qitemId}`, words));
    return { open, run, reply };
  }
  const replies = (row: QueueItem) => repo.list({ limit: 500 }).filter((q) => q.replyTo === row.qitemId && (q.tags ?? []).includes("human-answer"));
  const resolved = (row: QueueItem) => repo.listTransitions(row.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").length;

  it("a quiet ask's questions are answered in the TUI: each choice stays on its row, and the last returns them to the asker and closes it once", async () => {
    const questions = [{ id: "q1", question: "Which name?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta", recommended: true }] },
      { id: "q2", question: "Ship today?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }];
    const row = await repo.create({ sourceSession: "orch-lead@r", destinationSession: `${HUMAN}@kernel`, body: "two questions",
      summary: "Name and date", evidenceRef: "/proof/q.md", humanQuestions: questions, nudge: false });
    const app = readers();
    const t = await tui(app);
    // Both daemon attention readers serve the questions; the TUI lists them with one act per option, and no bare Approve.
    const listed = await (await app.request("/api/queue/list?attention=1")).json() as Array<Record<string, unknown>>;
    expect(listed.find((r) => r.qitemId === row.qitemId)).toMatchObject({ humanQuestions: questions });
    const first = await t.open(row);
    expect(first.read.items.find((i) => i.id === `queue:${row.qitemId}`)).toMatchObject({ humanQuestions: questions, humanAnswers: {},
      asker: "orch-lead@r", answer: { verb: "answer", actorSession: `${HUMAN}@kernel` } });
    expect(first.lines.map((l) => l.text).join("\n")).toContain("1. Which name? (unanswered)");
    expect(first.act("Approve as")).toBeUndefined();
    // One choice: kept on the row, which stays open, and nothing goes back yet.
    expect(await t.run(first.act('Answer "Which name?": Beta'))).toMatchObject({ answer: { outcome: "recorded", unanswered: ["Ship today?"] } });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", humanAnswers: { q1: "b" } });
    expect(replies(row)).toEqual([]);
    const second = await t.open(row);
    expect(second.lines.map((l) => l.text).join("\n")).toContain("1. Which name? (answered: Beta)");
    expect(second.act('Answer "Which name?"')).toBeUndefined();
    // The last choice: the answers go back to the asking seat once, and the ask closes on its own row.
    expect(await t.run(second.act('Answer "Ship today?": Yes'))).toMatchObject({ answer: { outcome: "answered" } });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on", humanAnswers: { q1: "b", q2: "y" } });
    expect(replies(row)).toHaveLength(1);
    expect(replies(row)[0]).toMatchObject({ destinationSession: "orch-lead@r", sourceSession: `${HUMAN}@kernel` });
    expect(replies(row)[0]!.body).toContain("Which name?: Beta\nShip today?: Yes");
    expect(resolved(row)).toBe(1);
    expect(onSteering()).not.toContain(row.qitemId);
    // A repeated tap on the same view records, sends and closes nothing more.
    await expect(t.run(second.act('Answer "Ship today?": No'))).rejects.toThrow();
    expect(replies(row)).toHaveLength(1);
    expect(resolved(row)).toBe(1);
    expect(repo.getById(row.qitemId)!.humanAnswers).toEqual({ q1: "b", q2: "y" });
    await runGateway();
    expect(posts).toHaveLength(0);
  });

  it("a typed answer in the TUI goes back to the asker in the person's words and closes the ask once, an alias's ask too", async () => {
    const typed = await ask({ questions: true });
    const alias = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "operator-admin@kernel", body: "what should we call it?",
      summary: "Name it", evidenceRef: "/proof/name.md", nudge: false });
    const t = await tui(readers());
    const words = "Neither: call it Gamma";
    expect(await t.reply(typed, words)).toMatchObject({ answer: { outcome: "answered" } });
    expect(repo.getById(typed.qitemId)).toMatchObject({ state: "done",
      humanAnswers: { q1: { kind: "typed-reply", text: words, placement: "first-unanswered", unansweredCount: 0 } } });
    expect(replies(typed)).toHaveLength(1);
    expect(replies(typed)[0]).toMatchObject({ destinationSession: "orch-lead@r" });
    expect(replies(typed)[0]!.body).toContain(words);
    expect(resolved(typed)).toBe(1);
    // An ask to a registered person's alias, with no questions: their words close it the same way.
    expect(await t.reply(alias, "Call it Delta")).toMatchObject({ answer: { outcome: "answered" } });
    expect(repo.getById(alias.qitemId)).toMatchObject({ state: "done" });
    expect(replies(alias)[0]!.body).toContain("Call it Delta");
    expect(resolved(alias)).toBe(1);
    // A repeat records, sends and closes nothing more.
    await expect(t.reply(typed, "changed my mind")).rejects.toThrow();
    expect(replies(typed)).toHaveLength(1);
    expect(resolved(typed)).toBe(1);
    expect((repo.getById(typed.qitemId)!.humanAnswers!.q1 as { text: string }).text).toBe(words);
  });

  it("an answer set whose return failed is sent again from the Feed with its recorded choice, never closed by a bare Approve", async () => {
    const row = await ask({ questions: true });
    const t = await tui(readers());
    unreachable = "orch-lead@r"; // the asking seat's rig left the topology, so the return is refused
    await expect(t.run((await t.open(row)).act('Answer "A or B?": B'))).rejects.toThrow();
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", humanAnswers: { q1: "b" } });
    expect(replies(row)).toEqual([]);
    // Reopened: every question is answered, so the Feed offers to send the answers back, not Approve.
    const reopened = await t.open(row);
    expect(reopened.read.items.find((i) => i.id === `queue:${row.qitemId}`)?.answer).toEqual({ verb: "answer", actorSession: `${HUMAN}@kernel` });
    expect(reopened.act("Approve as")).toBeUndefined();
    unreachable = null;
    expect(await t.run(reopened.act("Send the recorded answers back"))).toMatchObject({ answer: { outcome: "answered" } });
    expect(replies(row)).toHaveLength(1);
    expect(replies(row)[0]!.body).toContain("A or B?: B");
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "done", humanAnswers: { q1: "b" } });
    expect(resolved(row)).toBe(1);
  });

  it("a typed retry in other words than the answer already returned is refused, not closed on; the same words close it", async () => {
    const row = await ask();
    const t = await tui(readers());
    // The first answer went back to the asker, and then its close didn't commit.
    vi.spyOn(repo, "resolveDirectHumanReply").mockReturnValueOnce(false);
    await expect(t.reply(row, "Yes, ship it")).rejects.toThrow();
    expect(replies(row)).toHaveLength(1);
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending" });
    // Other words: nothing is sent, nothing closes, and the asker still holds the first answer.
    await expect(t.reply(row, "No, hold it")).rejects.toThrow();
    expect(replies(row)).toHaveLength(1);
    expect(replies(row)[0]!.body).toContain("Yes, ship it");
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending" });
    expect(resolved(row)).toBe(0);
    // The same words: the same reply row, and the ask closes once.
    expect(await t.reply(row, "Yes, ship it")).toMatchObject({ answer: { outcome: "answered" } });
    expect(replies(row)).toHaveLength(1);
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "done" });
    expect(resolved(row)).toBe(1);
  });

  it("the wake ladder leaves a quiet handoff to a person on Steering: past its window nothing posts, while an alerted one still escalates", async () => {
    const work = () => repo.create({ sourceSession: "orch-lead@r", destinationSession: "dev@r", body: "work", nudge: false });
    const quiet = (await repo.handoff({ qitemId: (await work()).qitemId, fromSession: "dev@r", toSession: `${HUMAN}@kernel`,
      body: "handed quiet", summary: "Pick", evidenceRef: "/proof/l1.md", nudge: false })).created;
    const urgent = (await repo.handoff({ qitemId: (await work()).qitemId, fromSession: "dev@r", toSession: `${HUMAN}@kernel`,
      body: "handed urgent", summary: "Approve now", evidenceRef: "/proof/l2.md", humanAlert: true, nudge: false })).created;
    // The wake a handoff to a person records: the gateway owns it, so the ladder reads it as unconfirmed.
    for (const row of [quiet, urgent]) {
      db.prepare("UPDATE queue_items SET last_nudge_result = ?, last_nudge_attempt = ? WHERE qitem_id = ?")
        .run(`gateway-owned: '${HUMAN}@kernel' is a virtual paneless human destination`, new Date().toISOString(), row.qitemId);
    }
    const escalated: string[] = [];
    const deliveryEngine = { dispatchEscalation: async (row: QueueItem) => { escalated.push(row.qitemId); return { decision: "post", resolved: true, dispatched: true }; } };
    for (let k = 1; k <= 6; k++) {
      await runWakeLadderTick({ db, queueRepo: repo, deliveryEngine: deliveryEngine as never, resolveOrchestrator: () => null, humanRung: "always",
        attemptWake: async () => "gateway-owned: test", loadHumanRegistry: () => registry, now: new Date(Date.now() + k * 40 * 60_000), log: () => {} });
    }
    expect(escalated).toContain(urgent.qitemId);
    expect(escalated).not.toContain(quiet.qitemId);
    expect(onSteering()).toContain(quiet.qitemId);
  });

  it("stays unalerted across quiet hours, a restart, the gateway's retries and the stuck sweep", async () => {
    const quietHours = new HumanQuietStore(db);
    const now = new Date();
    quietHours.setUntil(HUMAN, { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "test", now });
    const quiet = await ask();
    const urgent = await ask({ alert: true });
    await runGateway();
    expect(posts).toHaveLength(0);
    const notes = (row: QueueItem) => repo.listTransitions(row.qitemId).map((t) => t.transitionNote ?? "");
    expect(notes(urgent).some((note) => note.startsWith("delivery-decision: quiet-hold"))).toBe(true);
    expect(notes(quiet).some((note) => note.startsWith("delivery-decision:"))).toBe(false);

    // A restart: new repositories over the same database and home, and the gateway sweeping again.
    repo = newRepo();
    await runGateway();
    expect(posts).toHaveLength(0);

    // Quiet ends: the release posts the held alert, and only it, while the gateway keeps sweeping.
    quietHours.end(HUMAN, { endedBy: "test", now: new Date() });
    const [job] = new WatchdogJobsRepository(db).listActive().filter((j) => j.policy === QUIET_RELEASE_POLICY);
    await runGateway((w) => runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: () => registry }, dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) }));
    expect(posts).toHaveLength(1);
    expect(posted(urgent)).toBe(true);
    expect(posted(quiet)).toBe(false);

    // Hours later the quiet ask is still a plain wait on the person: no failed delivery, no stuck finding, no post.
    const past = new Date(Date.now() - 120 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, quiet.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, quiet.qitemId);
    expect(repo.deliveryOutcomeFor(quiet.qitemId)).toBeNull();
    await runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60, log: () => {}, isRegisteredHost: () => false });
    const findings = repo.list({ limit: 500 }).filter((item) => (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG));
    expect(findings.filter((item) => (item.tags ?? []).some((tag) => tag.endsWith(`:${quiet.qitemId}`)))).toEqual([]);
    await runGateway();
    expect(posts).toHaveLength(1);
    expect(onSteering()).toContain(quiet.qitemId);
  });

  it("by default (no Slack subscription authored, as on upgrade) every ask posts to Slack as before, and an alerted one stands out", async () => {
    registry = registryWith(); // a person with Slack configured before the setting existed
    const plain = await ask();
    const urgent = await ask({ alert: true });
    expect(owner(plain)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    expect(owner(urgent)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    expect(repo.getById(urgent.qitemId)!.tags).toContain("human-alert");
    // Not a quiet ask: the stuck sweep, the ladder and the waiting view treat it as before.
    expect(repo.humanAskWithoutAlert(plain.qitemId)).toBe(false);
    // The classification is the create's: changing the preset to urgent-only afterwards doesn't take back an ask already made.
    registry = registryWith("urgent-only");
    await runGateway();
    expect(posts).toHaveLength(2);
    expect(posted(plain)).toBe(true);
    expect(posted(urgent)).toBe(true);
    const postOf = (row: QueueItem) => JSON.stringify(posts.find((p) => JSON.stringify(p).includes(String(row.body))));
    expect(postOf(urgent)).toContain("<@UFOUNDER>");
    expect(postOf(plain)).not.toContain("<@UFOUNDER>");
    expect(repo.deliveryOutcomeFor(plain.qitemId)).toMatchObject({ outcome: "posted" });
    expect(repo.waitingView(plain.qitemId)!.nextBackstop?.mechanism ?? "").not.toMatch(/on Steering/);
    // Both are on Steering and the Feed, as every ask to a person is.
    expect(onSteering()).toEqual(expect.arrayContaining([plain.qitemId, urgent.qitemId]));
    const read = await feed(readers(), plain);
    expect(read.detail!.lines).toContain("Slack: posted (posted isn't read)");
  });

  it("--alert decides per item: an alerted ask handed to another person without --alert posts to them with no mention", async () => {
    registry = registryWith();
    const urgent = await ask({ alert: true });
    const handed = (await repo.handoff({ qitemId: urgent.qitemId, fromSession: `${HUMAN}@kernel`, toSession: "operator-admin@kernel",
      body: "handed on, not urgent", summary: "Handed on", evidenceRef: "/proof/handed.md", nudge: false })).created;
    expect(repo.getById(handed.qitemId)!.tags ?? []).not.toContain("human-alert");
    await runGateway();
    const post = posts.find((p) => JSON.stringify(p).includes("handed on, not urgent"));
    expect(post).toBeDefined();
    expect(JSON.stringify(post)).not.toContain("<@UOPERATOR>");
  });
});
