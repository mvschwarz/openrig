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
import { quietCustodyBackstop, quietHoldCustody } from "../src/domain/quiet-hold-custody.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const LATER = () => new Date(Date.now() + 2 * 3_600_000); // past every age and window threshold below

describe("custody of asks held for quiet hours", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let quiet: HumanQuietStore;
  let prefs: Record<string, unknown>;
  const posts: Array<Record<string, unknown>> = [];
  let failPosts = false;
  let rejectPosts = false; // the connector answers, but refuses the post
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
    failPosts = false;
    rejectPosts = false;
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
          if (failPosts) throw new Error("connector down before the post");
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (rejectPosts) return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200, headers: { "content-type": "application/json" } });
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

  it("a hold whose release job was stopped from outside (the only way one loses its job) is found, by the sweep and by the ladder", async () => {
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

  it("an ordinary row whose custody read fails isn't reported held: it reads exactly as without quiet hours", async () => {
    const row = await ask(); // never held
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id")) throw new Error("database is locked (test)");
      return prepare(sql);
    }) as typeof db.prepare);
    try {
      expect(quietHoldCustody(db, row.qitemId)).toBeNull();
    } finally { spy.mockRestore(); }
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
    // Review J2: quiet ends again and the job dispatches the same release again, its post withheld: transport owns it.
    quiet.end("person", { endedBy: "t", now: new Date() });
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: () => ({ ok: true }) });
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "released" });
    expect(repo.waitingView(row.qitemId)!.nextBackstop).toMatchObject({ note: expect.stringMatching(/waiting for transport/) });
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

  it("an attempted ask kept in flight because quiet hours couldn't be read is neither held nor orphaned: it is ordinary in-flight work", async () => {
    const row = await ask();
    const w = wire();
    failPosts = true; // attempted, nothing reached Slack
    const alert = await alertFor(row);
    w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
    await settle();
    failPosts = false;
    quietOn();
    w.stop();
    const read = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("disk I/O error (test)"); });
    try {
      wire(); // the replay can't decide, so the attempted decision stays buffered with no hold
      await settle();
    } finally { read.mockRestore(); }
    expect(posts).toHaveLength(0);
    expect(repo.listTransitions(row.qitemId).some((t) => (t.transitionNote ?? "").startsWith("delivery-decision: quiet-hold "))).toBe(false);
    expect(quietHoldCustody(db, row.qitemId)).toBeNull();
    expect(String((repo.waitingView(row.qitemId)!.nextBackstop as { note?: string }).note ?? "")).not.toMatch(/quiet hours/);
  });

  // A failed wake on the row, so the sweep's undelivered-wake loop sees it.
  const failedWake = (row: QueueItem) => db.prepare("UPDATE queue_items SET last_nudge_result = 'failed: wake not delivered (test)' WHERE qitem_id = ?").run(row.qitemId);
  const undeliveredFor = (r: Awaited<ReturnType<typeof sweep>>, row: QueueItem) => findingFor(r, row).filter((f) => f.kind === "undelivered-wake");

  it("QA F1: an aged healthy hold (real timestamps past the post window, live job, no failed wake) gives no finding", async () => {
    const row = await held();
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ?, ts_updated = ? WHERE qitem_id = ?").run(old, old, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(old, row.qitemId);
    expect(repo.findUndelivered().find((u) => u.qitemId === row.qitemId)?.deliveryOutcome, "the ledger reads it as never posted").toBe("never-posted");
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "held" });
    expect(findingFor(await sweep(), row)).toEqual([]);
  });

  it("review J1: a released ask whose post the connector refused is one failed-delivery finding, named in the view; the ladder takes it up", async () => {
    const row = await held();
    asBaton(row);
    quiet.end("person", { endedBy: "t", now: new Date() });
    rejectPosts = true;
    const w = wires[0]!;
    const [job] = releaseJobs();
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(1); // the connector saw it, and refused it
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "release-failed", failure: expect.any(String) });
    expect(String((repo.waitingView(row.qitemId)!.nextBackstop as { note?: string }).note)).toMatch(/^Released when quiet ended, but its post failed \(/);
    const r = await sweep();
    expect(findingFor(r, row)).toHaveLength(1);
    expect(findingFor(r, row)[0]!.kind).toBe("undelivered-human-notice");
    expect(repo.getById(findingFor(r, row)[0]!.findingQitemId)?.destinationSession).toBe("asker@r");
    expect(findingWhy(row)).toMatch(/released after quiet hours; its post failed \(.+\); the release stays queued for redelivery/);
    await ladder();
    expect(ladderTouched(row), "a failed release is an ordinary failed delivery to the ladder").toBe(true);
  });

  it("review R2-F1: a refused release turned back by quiet and re-dispatched, refused again, still reads as a failed delivery: one finding", async () => {
    const row = await held();
    quiet.end("person", { endedBy: "t", now: new Date() });
    rejectPosts = true;
    const w = wires[0]!;
    const [job] = releaseJobs();
    const releaseVia = () => runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    await releaseVia(); // cycle 1: the post is refused, and its one failure note is written
    await settle();
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "release-failed" });
    quietOn();
    const alert = await alertFor(row);
    await confirmReleaseAtPost({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, registry: { loadHumanRegistry: registry as never },
      entityId: "person", qitemId: row.qitemId, notificationKey: alert.notificationKey ?? row.qitemId }); // quiet came back: returned
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "held" });
    quiet.end("person", { endedBy: "t", now: new Date() });
    w.stop();
    const w2 = wire(); // a restart: the buffered release replays, refused again
    await settle();
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => w2.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(repo.listTransitions(row.qitemId).filter((t) => (t.transitionNote ?? "").startsWith("quiet-release-dispatched ")), "cycle 2 is dispatched").toHaveLength(2);
    expect(posts, "cycle 2's post reached the connector and was refused too").toHaveLength(2);
    expect(repo.listTransitions(row.qitemId).some((t) => (t.transitionNote ?? "").startsWith("slack-owner-notification-posted "))).toBe(false);
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "release-failed" });
    const r = await sweep();
    expect(findingFor(r, row)).toHaveLength(1);
    expect(findingFor(r, row)[0]!.kind).toBe("undelivered-human-notice");
    expect(repo.getById(findingFor(r, row)[0]!.findingQitemId)?.destinationSession).toBe("asker@r");
  });

  it("QA F1: a release turned back by quiet, with a failed wake, gives no undelivered-wake finding", async () => {
    const row = await held();
    quiet.end("person", { endedBy: "t", now: new Date() });
    const [job] = releaseJobs();
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: () => ({ ok: true }) });
    quietOn();
    const alert = await alertFor(row);
    await confirmReleaseAtPost({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, registry: { loadHumanRegistry: registry as never },
      entityId: "person", qitemId: row.qitemId, notificationKey: alert.notificationKey ?? row.qitemId });
    failedWake(row);
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "held" });
    expect(findingFor(await sweep(), row)).toEqual([]);
  });

  it("QA F1: a held ask with a failed wake whose custody read fails reads as held: no undelivered-wake finding", async () => {
    const row = await held();
    failedWake(row);
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("watchdog_jobs") && sql.includes("quiet-release")) throw new Error("database is locked (test)");
      return prepare(sql);
    }) as typeof db.prepare);
    let r: Awaited<ReturnType<typeof sweep>>;
    try { r = await sweep(); } finally { spy.mockRestore(); }
    expect(undeliveredFor(r, row)).toEqual([]);
  });

  it("QA F1: an orphaned hold with a failed wake is one finding, with the quiet-hours reason", async () => {
    const row = await held();
    failedWake(row);
    new WatchdogJobsRepository(db).markTerminal(releaseJobs()[0]!.jobId, "test: the job was stopped from outside");
    const r = await sweep();
    expect(findingFor(r, row)).toHaveLength(1);
    expect(findingWhy(row)).toMatch(/held for quiet hours .* no release job is live/);
  });

  it("QA F1: an ordinary row with a failed wake is an undelivered-wake finding, as before", async () => {
    const row = await ask(); // never held
    failedWake(row);
    const r = await sweep();
    expect(undeliveredFor(r, row)).toHaveLength(1);
    expect(findingWhy(row)).toMatch(/^.*wake failed \(failed: wake not delivered \(test\)\) and nothing retried it/s);
  });

  it("review J4: once a daily window has ended, a held ask isn't promised tomorrow's start: the job posts it at its next pass", async () => {
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const now = Date.now();
    quiet.setDaily("person", { start: hhmm(now - 3_600_000), end: hhmm(now + 3_600_000), timezone: "UTC", setBy: "t", now: new Date() });
    const row = await ask();
    const w = wire();
    const alert = await alertFor(row);
    w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
    await settle();
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "held", nextBoundary: expect.any(String) });
    quiet.end("person", { endedBy: "t", now: new Date() }); // "I'm back": tonight's occurrence ends; the job hasn't run yet
    expect(quiet.quietStateFor("person", new Date()).nextBoundary).toMatchObject({ kind: "start" });
    expect(quietHoldCustody(db, row.qitemId)).toMatchObject({ state: "held", nextBoundary: null, quietOver: true });
    expect(repo.waitingView(row.qitemId)!.nextBackstop).toMatchObject({ dueAt: null,
      note: "Quiet hours have ended; the window's release job posts it at its next pass." });
  });

  it("review N2: custody that can't be read is worded as treated as held, not as a delivery promise", () => {
    expect(quietCustodyBackstop("o@r", { state: "held", windowId: "unknown", notificationKey: "k", nextBoundary: null, unreadable: true }))
      .toMatchObject({ dueAt: null, note: expect.stringMatching(/^Quiet-hours custody couldn't be read; the ask is treated as held for now/) });
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
