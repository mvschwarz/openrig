// Quiet hours, custody: how the stuck sweep, the wake ladder and the waiting view read an ask held for quiet hours.
// A healthy hold (its window's release job live) is held, not stuck and not picked up; a hold whose job is gone is
// found; a release turned back because quiet came on again is held; after the post, the row reads as any posted ask.
// Digest-held and ordinary rows read as before. Real SQLite (all migrations), the real queue and gateway wire with a
// recording fetch, the real watchdog jobs table. No Slack. Native: NOT RUN.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { OUTBOUND_OP, toPayload } from "../src/domain/gateway/slack/outbound-driver.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { confirmReleaseAtPost, QUIET_RELEASE_POLICY, runQuietRelease } from "../src/domain/policies/quiet-release.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { quietHoldCustody } from "../src/domain/quiet-hold-custody.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const LATER = () => new Date(Date.now() + 2 * 3_600_000); // past every age and window threshold below

describe("custody of asks held for quiet hours", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let quiet: HumanQuietStore;
  let prefs: Record<string, unknown>;
  const posts: Array<Record<string, unknown>> = [];
  const wires: Array<ReturnType<typeof buildSlackGatewayWire>> = [];
  const registry = () => ({ ok: true as const, entities: [{
    entityId: "person", class: "human" as const, displayName: "Person", address: "person@external", prefs,
    connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UPERSON" }],
  }] });

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    prefs = { deliveryClass: "B", availability: "available" };
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    home = mkdtempSync(join(tmpdir(), "quiet-custody-"));
    quiet = new HumanQuietStore(db);
    posts.length = 0;
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
  });
  afterEach(() => { for (const w of wires.splice(0)) w.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  function wire() {
    const w = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: registry as never, resolveSlackHandle }, outboundIntervalMs: 3_600_000,
      fetchImpl: async (url, init) => {
        if (String(url).includes("chat.postMessage")) {
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, ts: `1724.${100 + posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    w.startServices?.();
    wires.push(w);
    return w;
  }
  let n = 0;
  const ask = () => repo.create({ sourceSession: "asker@r", destinationSession: "person@external", body: `Question ${++n}: pick one`,
    summary: `Pick ${n}`, evidenceRef: `/proof/${n}.md`, humanIntent: "decision", nudge: false } as never) as Promise<QueueItem>;
  const alertFor = async (row: QueueItem) =>
    (await makeQueuePorts(repo, { loadHumanRegistry: registry } as never).listHumanAlerts({ minimumLevel: "RECORD" })).find((a) => a.qitemId === row.qitemId)!;
  const quietOn = () => { const now = new Date(); quiet.setUntil("person", { until: new Date(now.getTime() + 24 * 3_600_000), timezone: "UTC", setBy: "t", now }); };
  const releaseJobs = () => new WatchdogJobsRepository(db).listActive().filter((j) => j.policy === QUIET_RELEASE_POLICY);
  async function held(): Promise<QueueItem> {
    quietOn();
    const row = await ask();
    const w = wire();
    const alert = await alertFor(row);
    w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
    await settle();
    expect(posts).toHaveLength(0);
    expect(releaseJobs()).toHaveLength(1);
    return row;
  }
  const sweep = () => runStuckSweep({ db, queueRepo: repo, unclaimedAgeMinutes: 5, now: LATER(), resolveOrchestrator: () => "orch@r", log: () => {} });
  const findingFor = (r: Awaited<ReturnType<typeof sweep>>, row: QueueItem) => r.findings.filter((f) => f.qitemId === row.qitemId);
  const findingWhy = (row: QueueItem) => {
    const found = db.prepare("SELECT body FROM queue_items WHERE tags LIKE ? ORDER BY ts_created DESC LIMIT 1").get(`%recovery-for:${row.qitemId}%`) as { body: string } | undefined;
    return found?.body ?? "";
  };
  // A baton handed to the person, whose gateway wake is unconfirmed: the case the wake ladder would climb.
  const asBaton = (row: QueueItem) => db.prepare("UPDATE queue_items SET handed_off_from = 'orch@r', last_nudge_result = 'gateway-owned: virtual destination' WHERE qitem_id = ?").run(row.qitemId);
  const ladder = () => runWakeLadderTick({ db, queueRepo: repo, now: LATER(), unconfirmedWindowMinutes: 1, retryIntervalSeconds: 1,
    resolveOrchestrator: () => "orch@r", attemptWake: async () => "verified", log: () => {} });
  const ladderTouched = (row: QueueItem) => repo.listTransitions(row.qitemId).some((t) => t.actorSession === "wake-ladder@system");

  it("a healthy hold aged past the thresholds is held: no stuck finding, and the waiting view says held by quiet hours until the boundary", async () => {
    const row = await held();
    expect(findingFor(await sweep(), row)).toEqual([]);
    const view = repo.waitingView(row.qitemId)!;
    expect(view.nextBackstop).toMatchObject({ mechanism: expect.stringMatching(/^quiet-release:/), dueAt: quiet.quietStateFor("person", new Date()).nextBoundary!.at });
    expect(String((view.nextBackstop as { note?: string }).note)).toMatch(/^Held by quiet hours until /);
  });

  it("a healthy hold isn't counted as picked up, and the wake ladder leaves it to its release job", async () => {
    const row = await held();
    asBaton(row);
    expect(await ladder()).toMatchObject({ outcome: "clean" });
    expect(ladderTouched(row)).toBe(false);
  });

  it("a hold whose release job is gone is found, by the sweep and by the ladder", async () => {
    const row = await held();
    asBaton(row);
    new WatchdogJobsRepository(db).markTerminal(releaseJobs()[0]!.jobId, "test: the job went away");
    const r = await sweep();
    expect(findingFor(r, row).length).toBeGreaterThan(0);
    expect(findingWhy(row)).toMatch(/held for quiet hours .* no release job is live/);
    await ladder();
    expect(ladderTouched(row), "an orphaned hold isn't pickup, so the ladder takes it up").toBe(true);
  });

  it("a release dispatched but never posted whose job is gone is orphaned and found, not left waiting for transport", async () => {
    const row = await held();
    quiet.end("person", { endedBy: "t", now: new Date() });
    const [job] = releaseJobs();
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: () => ({ ok: true }) }); // dispatched; the post never lands
    new WatchdogJobsRepository(db).markTerminal(job!.jobId, "test: the job was killed");
    expect(String((repo.waitingView(row.qitemId)!.nextBackstop as { note?: string }).note ?? "")).not.toMatch(/waiting for transport/);
    expect(findingFor(await sweep(), row).length).toBeGreaterThan(0);
    expect(findingWhy(row)).toMatch(/held for quiet hours .* no release job is live/);
  });

  it("a custody read that fails reads as held (never as no quiet), so the ladder doesn't escalate; a missing table is no custody", async () => {
    const row = await held();
    asBaton(row);
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("watchdog_jobs") && sql.includes("quiet-release")) throw new Error("database is locked (test)");
      return prepare(sql);
    }) as typeof db.prepare);
    try {
      expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "held" });
      await ladder();
      expect(ladderTouched(row)).toBe(false);
    } finally { spy.mockRestore(); }
    const bare = new Database(":memory:");
    expect(quietHoldCustody(bare, row.qitemId)).toBeNull();
    bare.close();
  });

  it("a release turned back because quiet came on again reads as held", async () => {
    const row = await held();
    quiet.end("person", { endedBy: "t", now: new Date() });
    const [job] = releaseJobs();
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: () => ({ ok: true }) }); // dispatched; not yet posted
    expect(repo.waitingView(row.qitemId)!.nextBackstop).toMatchObject({ note: expect.stringMatching(/waiting for transport/) });
    quietOn();
    const alert = await alertFor(row);
    expect(await confirmReleaseAtPost({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, registry: { loadHumanRegistry: registry as never },
      entityId: "person", qitemId: row.qitemId, notificationKey: alert.notificationKey ?? row.qitemId })).toBe("declined");
    expect(findingFor(await sweep(), row)).toEqual([]);
    expect(String((repo.waitingView(row.qitemId)!.nextBackstop as { note?: string }).note)).toMatch(/^Held by quiet hours/);
  });

  it("after release and its receipt, the row reads as any posted ask", async () => {
    const row = await held();
    quiet.end("person", { endedBy: "t", now: new Date() });
    const w = wires[0]!;
    const [job] = releaseJobs();
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(1);
    expect(repo.waitingView(row.qitemId)!.nextBackstop).toMatchObject({ mechanism: "none (posted to the human; awaiting their decision)" });
    expect(findingFor(await sweep(), row)).toEqual([]);
  });

  it("digest-held and ordinary unposted asks read exactly as before: aged, they are findings", async () => {
    const ordinary = await ask();
    const digest = await ask();
    const alert = await alertFor(digest);
    repo.update({ qitemId: digest.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    const r = await sweep();
    expect(findingFor(r, ordinary).length).toBeGreaterThan(0);
    expect(findingFor(r, digest).length).toBeGreaterThan(0);
    expect(findingWhy(digest)).not.toMatch(/quiet hours/);
  });
});
