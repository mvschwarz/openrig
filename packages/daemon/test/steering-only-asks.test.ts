// An ask to a person lands on Steering with no Slack alert unless it's marked alert-worthy (humanAlert): the same item,
// visible and answerable on Steering either way, with one Slack post only for the alert-worthy one. The existing
// classifier stores the choice with the create (RECORD for Steering only, ALERT for an alert), and the existing Slack
// selection, posting dial, quiet hours and stuck sweep act on it. Real SQLite (all migrations), the real queue, the real
// gateway wire and its own outbound driver over a recording fetch, the real quiet-hours store and release job. No Slack.
// Native: NOT RUN.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const HUMAN = "human-founder";
const registry = {
  ok: true as const,
  entities: [{
    entityId: HUMAN, class: "human" as const, displayName: "Founder", address: `${HUMAN}@external`,
    connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }],
    prefs: { deliveryClass: "B", availability: "available" },
  }],
};
const QUESTION = [{ id: "q1", question: "A or B?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }];

describe("an ask lands on Steering; Slack alerts only when it's marked alert-worthy", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  const posts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = newRepo();
    home = mkdtempSync(join(tmpdir(), "steering-only-"));
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    posts.length = 0;
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  function newRepo(): QueueRepository {
    return new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => registry });
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
});
