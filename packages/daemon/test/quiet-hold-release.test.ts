// Quiet hours hold a person's routine asks and release them when quiet ends. The decision (one new outcome, `hold`),
// the exact hold note, the digest flush's re-check for asks decided before quiet began, and the release job that posts
// each still-eligible ask individually through the ordinary Slack path. Real SQLite (all migrations), the real queue,
// the real gateway wire over a recording fetch, and the real watchdog jobs table. No Slack. Native: NOT RUN.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { DispatchBuffer, dispatchBufferPath } from "../src/domain/gateway/dispatch-buffer.js";
import { SlackOutboundDriver } from "../src/domain/gateway/slack/outbound-driver.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { HumanQuietStore, quietHoldFor } from "../src/domain/gateway/human-quiet-windows.js";
import { decideDelivery, type DeliveryDecisionInput } from "../src/domain/gateway/delivery-rules-engine.js";
import { runDeliveryDigestFlush } from "../src/domain/policies/delivery-digest-flush.js";
import { formatQuietHoldNote, parseQuietHoldNote, QUIET_RELEASE_POLICY, runQuietRelease } from "../src/domain/policies/quiet-release.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";

const HUMAN = "human-founder";
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function registryWith(prefs: Record<string, unknown>) {
  return {
    ok: true as const,
    entities: [{
      entityId: HUMAN, class: "human" as const, displayName: "Founder", address: `${HUMAN}@external`,
      connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }],
      prefs,
    }],
  };
}

// ─── The decision ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("the hold decision", () => {
  const quiet = { windowId: "w-1", occurrence: "2026-10-20", revision: 3 };
  const cells: DeliveryDecisionInput[] = [];
  for (const deliveryClass of ["A", "B", "C", "D"] as const) {
    for (const availability of ["available", "focus", "away", "off"] as const) {
      for (const escalation of [false, true]) {
        for (const level of ["RECORD", "NOTICE", "ALERT"] as const) {
          cells.push({ level, escalation, human: { entityId: HUMAN, deliveryClass, availability },
            dials: { minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT" } });
        }
      }
    }
  }

  it("outside quiet, every one of the 96 cells decides exactly as today", () => {
    for (const cell of cells) expect(decideDelivery({ ...cell, quiet: null })).toEqual(decideDelivery(cell));
  });

  it("during quiet, every routine ask that would post is held, class A included, with no mention", () => {
    for (const cell of cells.filter((c) => !c.escalation)) {
      const today = decideDelivery(cell);
      const held = decideDelivery({ ...cell, quiet });
      if (today.outcome === "log") expect(held, JSON.stringify(cell)).toEqual(today); // the posting dial still logs only
      else expect(held, JSON.stringify(cell)).toEqual({ outcome: "hold", mention: false, quietHold: quiet });
    }
  });

  it("during quiet, an urgent (escalation) ask decides exactly as outside it: at once, away's 30 minutes, off's no mention", () => {
    for (const cell of cells.filter((c) => c.escalation)) expect(decideDelivery({ ...cell, quiet })).toEqual(decideDelivery(cell));
    const away = decideDelivery({ ...cells.find((c) => c.escalation && c.human.availability === "away" && c.human.deliveryClass === "B" && c.level === "ALERT")!, quiet });
    expect(away).toMatchObject({ outcome: "interrupt", deferMinutes: 30 });
    const off = decideDelivery({ ...cells.find((c) => c.escalation && c.human.availability === "off" && c.level === "ALERT")!, quiet });
    expect(off).toMatchObject({ outcome: "notify", mention: false });
  });
});

describe("the hold note", () => {
  it("has one exact, parseable form that the 4h/daily flush's digest selection can't match", () => {
    const note = formatQuietHoldNote({ windowId: "w-1", occurrence: "2026-10-20", revision: 3, notificationKey: "q-1:7" });
    expect(note).toBe("delivery-decision: quiet-hold window=w-1 occurrence=2026-10-20 revision=3 notification_key=q-1:7");
    expect(note.startsWith("delivery-decision: digest")).toBe(false);
    expect(parseQuietHoldNote(note)).toEqual({ windowId: "w-1", occurrence: "2026-10-20", revision: 3, notificationKey: "q-1:7" });
    expect(parseQuietHoldNote("delivery-decision: digest window=4h notification_key=q-1:7")).toBeNull();
    expect(parseQuietHoldNote(`${note} extra=1`)).toBeNull();
  });
});

// ─── Through the real gateway ───────────────────────────────────────────────────────────────────────────────────────

describe("holding and releasing through the gateway", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let quiet: HumanQuietStore;
  let prefs: Record<string, unknown>;
  const posts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    prefs = { deliveryClass: "B", availability: "available" };
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => registryWith(prefs) });
    home = mkdtempSync(join(tmpdir(), "quiet-hold-"));
    quiet = new HumanQuietStore(db);
    posts.length = 0;
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  let n = 0;
  async function park(opts: { tags?: string[] } = {}): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: "dev-qa@r", destinationSession: "orch-lead@r", body: `decision body ${++n}`,
      ...(opts.tags ? { tags: opts.tags } : {}), nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@r", state: "blocked", blockedOn: `${HUMAN}@kernel`,
      summary: `Choose ${n}`, evidenceRef: `/proof/${n}.md`, transitionNote: "parked" });
    return row;
  }
  function wire() {
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    return buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registryWith(prefs), resolveSlackHandle }, outboundIntervalMs: 60_000,
      fetchImpl: async (url, init) => {
        if (String(url).includes("chat.postMessage")) {
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, ts: `1724.9${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  async function alertFor(row: QueueItem) {
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registryWith(prefs) } as never);
    return (await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).find((a) => a.qitemId === row.qitemId)!;
  }
  const notes = (row: QueueItem) => repo.listTransitions(row.qitemId).map((t) => t.transitionNote ?? "");
  const releaseJobs = () => new WatchdogJobsRepository(db).listActive().filter((j) => j.policy === QUIET_RELEASE_POLICY);
  async function release(w: ReturnType<typeof wire>, now = new Date()) {
    const [job] = releaseJobs();
    if (!job) return null;
    return runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job.jobId, now,
      registry: { loadHumanRegistry: () => registryWith(prefs) },
      dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
  }
  function quietNow() {
    const now = new Date();
    quiet.setUntil(HUMAN, { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "test", now });
    return quiet.quietStateFor(HUMAN, now) as { windowId: string; revision: number };
  }

  it("during quiet a routine ask posts nothing, carries the exact hold note, and arms one release job", async () => {
    const state = quietNow();
    const row = await park();
    const alert = await alertFor(row);
    const w = wire();
    try {
      w.startServices?.();
      w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, alert);
      await settle();
      expect(posts).toHaveLength(0);
      const key = alert.notificationKey ?? alert.qitemId;
      expect(notes(row)).toContain(`delivery-decision: quiet-hold window=${state.windowId} occurrence=until revision=${state.revision} notification_key=${key}`);
      expect(releaseJobs()).toHaveLength(1);
    } finally { w.stop(); }
  });

  it("review J3: a row parked on the person and held for quiet shows its quiet custody; the blocker and its own timer stay", async () => {
    quietNow();
    const row = await park();
    repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@r", state: "blocked", blockedOn: `${HUMAN}@kernel`, wakeAfterSeconds: 7200,
      transitionNote: "parked with a reminder" } as never);
    const alert = await alertFor(row);
    const w = wire();
    try {
      w.startServices?.();
      w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, alert);
      await settle();
      expect(posts).toHaveLength(0);
      let view = repo.waitingView(row.qitemId)!;
      expect(view.blocker).toMatchObject({ ref: `${HUMAN}@kernel` });
      expect(view.nextBackstop).toMatchObject({ mechanism: expect.stringMatching(/^quiet-release:/), note: expect.stringMatching(/^Held by quiet hours until /) });
      expect(view.laterBackstop?.mechanism, "the row's own reminder is kept").toMatch(/^watchdog:/);
      quiet.end(HUMAN, { endedBy: "test", now: new Date() });
      const [job] = releaseJobs();
      await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
        registry: { loadHumanRegistry: () => registryWith(prefs) }, dispatch: () => ({ ok: true }) }); // dispatched; the post not yet made
      view = repo.waitingView(row.qitemId)!;
      expect(view.nextBackstop).toMatchObject({ note: expect.stringMatching(/waiting for transport/) });
      expect(view.blocker).toMatchObject({ ref: `${HUMAN}@kernel` });
    } finally { w.stop(); }
  });

  it("during quiet an urgent ask posts at once", async () => {
    quietNow();
    const row = await park({ tags: ["escalation"] });
    const w = wire();
    try {
      w.startServices?.();
      w.dispatcher.dispatch(OUTBOUND_OP, `${HUMAN}@external`, await alertFor(row));
      await settle();
      expect(posts).toHaveLength(1);
      expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold"))).toBe(false);
    } finally { w.stop(); }
  });

  it("nothing is released while quiet is on, even when the window is extended; once it ends each held ask posts individually, once, with no mention", async () => {
    quietNow();
    const rows = [await park(), await park()];
    const w = wire();
    try {
      w.startServices?.();
      for (const row of rows) w.dispatcher.dispatch(OUTBOUND_OP, `${HUMAN}@external`, await alertFor(row));
      await settle();
      expect(await release(w)).toMatchObject({ state: "quiet", released: 0 });
      quiet.setUntil(HUMAN, { until: new Date(Date.now() + 7_200_000), timezone: "UTC", setBy: "test", now: new Date() }); // extend
      expect(await release(w)).toMatchObject({ state: "quiet", released: 0 });
      await settle();
      expect(posts).toHaveLength(0);

      quiet.end(HUMAN, { endedBy: "test", now: new Date() }); // "I'm back"
      expect(await release(w)).toMatchObject({ state: "pending", released: 2 });
      await settle();
      expect(posts).toHaveLength(2);
      for (const row of rows) expect(JSON.stringify(posts)).toContain(String(row.body));
      expect(JSON.stringify(posts)).not.toContain("<@UFOUNDER>");
      for (const row of rows) expect(notes(row).filter((n) => n.startsWith("slack-owner-notification-posted "))).toHaveLength(1);
      // The next pass sees every receipt and retires the job; nothing posts twice.
      expect(await release(w)).toMatchObject({ state: "released", released: 0 });
      await settle();
      expect(posts).toHaveLength(2);
      expect(releaseJobs()).toHaveLength(0);
    } finally { w.stop(); }
  });

  it("an ask whose row closed during quiet gets a visible disposition, not a post", async () => {
    quietNow();
    const [kept, closed] = [await park(), await park()];
    const w = wire();
    try {
      w.startServices?.();
      for (const row of [kept, closed]) w.dispatcher.dispatch(OUTBOUND_OP, `${HUMAN}@external`, await alertFor(row));
      await settle();
      repo.update({ qitemId: closed.qitemId, actorSession: "orch-lead@r", state: "done", closureReason: "no-follow-on", transitionNote: "answered elsewhere" });
      quiet.clear(HUMAN, { clearedBy: "test", now: new Date() });
      expect(await release(w)).toMatchObject({ released: 1, dispositions: 1 });
      await settle();
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts)).toContain(String(kept.body));
      expect(notes(closed).some((n) => n.startsWith("quiet-release-disposition ") && n.includes("reason=row-not-active"))).toBe(true);
    } finally { w.stop(); }
  });

  it("after a restart (new repositories over the same database) a release that is due catches up", async () => {
    quietNow();
    const row = await park();
    const w = wire();
    try {
      w.startServices?.();
      w.dispatcher.dispatch(OUTBOUND_OP, `${HUMAN}@external`, await alertFor(row));
      await settle();
      quiet.end(HUMAN, { endedBy: "test", now: new Date() });
      repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => registryWith(prefs) });
      expect(await release(w)).toMatchObject({ released: 1 });
      await settle();
      expect(posts).toHaveLength(1);
    } finally { w.stop(); }
  });

  it("an ask put in the digest before quiet began is held at flush time instead of posted, and released individually after", async () => {
    prefs = { deliveryClass: "C", availability: "available" };
    const row = await park();
    const alert = await alertFor(row);
    const key = alert.notificationKey ?? alert.qitemId;
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${key}` });
    const state = quietNow();
    const w = wire();
    try {
      w.startServices?.();
      const flushed = await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: () => registryWith(prefs) }, home, window: "4h",
        dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
      await settle();
      expect(flushed).toMatchObject({ dispatched: 0 });
      expect(posts).toHaveLength(0);
      expect(notes(row)).toContain(`delivery-decision: quiet-hold window=${state.windowId} occurrence=until revision=${state.revision} notification_key=${key}`);
      quiet.end(HUMAN, { endedBy: "test", now: new Date() });
      expect(await release(w)).toMatchObject({ released: 1 });
      await settle();
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts)).not.toContain("Delivery digest"); // individually, not a second digest
    } finally { w.stop(); }
  });

  it("outside quiet the digest flush posts as today", async () => {
    prefs = { deliveryClass: "C", availability: "available" };
    const row = await park();
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey ?? alert.qitemId}` });
    const w = wire();
    try {
      w.startServices?.();
      const flushed = await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: () => registryWith(prefs) }, home, window: "4h",
        dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
      await settle();
      expect(flushed.dispatched).toBe(1);
      expect(posts).toHaveLength(1);
    } finally { w.stop(); }
  });

  it("the operator rung's escalation still dispatches during quiet (it is always urgent)", async () => {
    quietNow();
    const row = await park();
    const dispatched: unknown[] = [];
    const engine = makeOperatorDeliveryEngine({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registryWith(prefs) },
      dispatch: (_op, _ref, payload) => { dispatched.push(payload); return { ok: true, decisionId: "d" } as never; } });
    const out = await engine.dispatchEscalation(row, "test");
    expect(out).toMatchObject({ dispatched: true, decision: "interrupt" });
    expect(dispatched).toHaveLength(1);
  });
});

// ─── After QA: a buffered release re-checked at post time, and quiet per actual recipient in the digest flush ──────

describe("after QA: changed circumstances and a second person", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let quiet: HumanQuietStore;
  let order: string[];
  const posts: Array<Record<string, unknown>> = [];
  const wires: Array<ReturnType<typeof buildSlackGatewayWire>> = [];
  let failPosts = false;
  let loseResponses = false; // the post lands in Slack, but its response never reaches the gateway
  let historyIncomplete = false; // the reconciler's history scan stops early (more pages, no cursor): "maybe"
  let failFromPost = 0; // when set, the Nth post and every one after it fail before posting
  let registryOk = true;
  const person = (id: string) => ({
    entityId: id, class: "human" as const, displayName: id, address: `${id}@external`,
    prefs: id === "person" ? { deliveryClass: "C", availability: "available" } : { deliveryClass: "B", availability: "available" },
    connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: id === "person" ? "UPERSON" : "UOTHER" }],
  });
  const registry = () => registryOk ? { ok: true as const, entities: order.map(person) } : { ok: false as const, error: "registry unavailable (test)" };

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    order = ["person", "other"];
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    home = mkdtempSync(join(tmpdir(), "quiet-qa-"));
    quiet = new HumanQuietStore(db);
    posts.length = 0;
    failPosts = false;
    loseResponses = false;
    historyIncomplete = false;
    failFromPost = 0;
    registryOk = true;
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
          if (failPosts || (failFromPost && posts.length + 1 >= failFromPost)) throw new Error("connector down before the post");
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (loseResponses) throw new Error("response lost after the post landed (test)");
          return new Response(JSON.stringify({ ok: true, ts: `1724.${100 + posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (historyIncomplete) {
          return new Response(JSON.stringify({ ok: true, messages: [], has_more: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        // Channel history for the reconciler's marker scan: what actually landed.
        const messages = posts.map((post, i) => ({ ts: `1724.${101 + i}`, text: String(post.text ?? "") }));
        return new Response(JSON.stringify({ ok: true, messages }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    w.startServices?.();
    wires.push(w);
    return w;
  }
  let n = 0;
  const ask = (extra: Record<string, unknown> = {}) => repo.create({ sourceSession: "asker@r", destinationSession: "person@external",
    body: `Full question ${++n}: choose the window`, summary: `Choose ${n}`, evidenceRef: `/proof/${n}.md`, humanIntent: "decision", ...extra, nudge: false } as never) as Promise<QueueItem>;
  const alertFor = async (row: QueueItem) =>
    (await makeQueuePorts(repo, { loadHumanRegistry: registry } as never).listHumanAlerts({ minimumLevel: "RECORD" })).find((a) => a.qitemId === row.qitemId)!;
  const quietOn = () => { const now = new Date(); quiet.setUntil("person", { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "t", now }); };
  const notes = (row: QueueItem) => repo.listTransitions(row.qitemId).map((t) => t.transitionNote ?? "");
  const releaseJobs = () => new WatchdogJobsRepository(db).listActive().filter((j) => j.policy === QUIET_RELEASE_POLICY);

  it.each(["quiet back on", "posting threshold raised", "recipient changed"])(
    "a release dispatched but not yet posted is re-checked when it's replayed: %s posts nothing", async (change) => {
      quietOn();
      const row = await ask(change === "posting threshold raised" ? { humanIntent: "update" } : {});
      const first = wire();
      const alert = await alertFor(row);
      first.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
      await settle();
      expect(posts).toHaveLength(0);
      quiet.end("person", { endedBy: "t", now: new Date() });
      // The release is dispatched while the connector is down: it waits in the durable buffer.
      const buffer = new DispatchBuffer(home);
      const [job] = releaseJobs();
      const released = await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
        registry: { loadHumanRegistry: registry as never },
        dispatch: (op, ref, payload, opts) => { buffer.enqueue({ kind: "outbound_decision", decisionId: opts!.decisionId!, op, entityBindingRef: ref, payload }); return { ok: true }; } });
      expect(released).toMatchObject({ state: "pending", released: 1 });
      expect(buffer.pending()).toHaveLength(1);
      if (change === "quiet back on") quietOn();
      else if (change === "posting threshold raised") saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: join(home, "slack.env"), minimumLevelThatPosts: "ALERT" }, home);
      else db.prepare("UPDATE queue_items SET destination_session = ? WHERE qitem_id = ?").run("other@external", row.qitemId);
      first.stop();
      wire(); // restart: the gateway replays what's buffered
      await settle();
      expect(posts, `nothing posts after: ${change}`).toHaveLength(0);
      const expected = change === "quiet back on" ? "quiet-release-returned " : "quiet-release-disposition ";
      expect(notes(row).some((n) => n.startsWith(expected))).toBe(true);
      if (change === "quiet back on") expect(releaseJobs()).toHaveLength(1); // still held, still owned by the job
    });

  it("full flow: the real release fails to post, quiet comes back under a newer window, and the restart's replay posts nothing", async () => {
    quietOn();
    const row = await ask();
    const first = wire();
    const alert = await alertFor(row);
    first.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
    await settle();
    quiet.end("person", { endedBy: "t", now: new Date() });
    failPosts = true;
    const [job] = releaseJobs();
    expect(await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never },
      dispatch: (op, ref, payload, opts) => first.dispatcher.dispatch(op, ref, payload, opts as never) })).toMatchObject({ state: "pending", released: 1 });
    await settle();
    expect(posts).toHaveLength(0);
    expect(new DispatchBuffer(home).pending().filter((d) => d.decisionId.startsWith("quiet-release:"))).toHaveLength(1);
    quietOn(); // a newer quiet revision
    first.stop();
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    failPosts = false;
    wire(); // restart: startup replays the buffered release
    await settle();
    expect(posts).toHaveLength(0);
    expect(notes(row).some((n) => n.startsWith("quiet-release-returned "))).toBe(true);
    expect(releaseJobs()).toHaveLength(1);
  });

  it("after review: a registry that can't be loaded at release time leaves the ask held and open; it posts once when it loads", async () => {
    quietOn();
    const row = await ask();
    const w = wire();
    const alert = await alertFor(row);
    w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
    await settle();
    quiet.end("person", { endedBy: "t", now: new Date() });
    const [job] = releaseJobs();
    const run = () => runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    registryOk = false;
    expect(await run()).toMatchObject({ state: "pending", released: 0, dispositions: 0 });
    expect(notes(row).some((n) => n.startsWith("quiet-release-disposition "))).toBe(false);
    expect(releaseJobs()).toHaveLength(1);
    registryOk = true;
    expect(await run()).toMatchObject({ released: 1 });
    await settle();
    expect(posts).toHaveLength(1);
  });

  it("after review: a registry that fails between dispatch and post writes nothing and posts nothing; the job's next pass posts it once", async () => {
    quietOn();
    const row = await ask();
    const w = wire();
    const alert = await alertFor(row);
    w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
    await settle();
    quiet.end("person", { endedBy: "t", now: new Date() });
    const [job] = releaseJobs();
    const run = (flip: boolean) => runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never },
      dispatch: (op, ref, payload, opts) => { if (flip) registryOk = false; return w.dispatcher.dispatch(op, ref, payload, opts as never); } });
    await run(true);
    await settle();
    expect(posts).toHaveLength(0);
    expect(notes(row).some((n) => n.startsWith("quiet-release-disposition ") || n.startsWith("quiet-release-returned "))).toBe(false);
    expect(releaseJobs()).toHaveLength(1);
    registryOk = true;
    await run(false);
    await settle();
    expect(posts).toHaveLength(1);
  });

  it("after review: a quiet-hours read that fails during quiet posts nothing; a missing quiet-hours table still reads as not quiet", async () => {
    quietOn();
    const row = await ask();
    const w = wire();
    const alert = await alertFor(row);
    const spy = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("disk I/O error (test)"); });
    try {
      expect(() => quietHoldFor(db, "person", new Date())).toThrow(/disk I\/O error/);
      w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
      await settle();
      expect(posts).toHaveLength(0);
      expect(notes(row).some((n) => n.startsWith("delivery-decision: "))).toBe(false); // nothing decided yet
    } finally { spy.mockRestore(); }
    w.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert)); // the sweep offers it again
    await settle();
    expect(posts).toHaveLength(0);
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(true);
    const bare = new Database(":memory:");
    expect(quietHoldFor(bare, "person", new Date())).toBeNull();
    bare.close();
  });

  it("after QA: a decision deferred by a failed quiet read leaves the ask for the real sweep to offer again, and it's held then", async () => {
    quietOn();
    let driver: SlackOutboundDriver | undefined;
    const start = SlackOutboundDriver.prototype.start;
    const captured = vi.spyOn(SlackOutboundDriver.prototype, "start").mockImplementation(function (this: SlackOutboundDriver) { driver = this; start.call(this); });
    const row = await ask();
    wire();
    captured.mockRestore();
    const read = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("disk I/O error (test)"); });
    try {
      const first = await driver!.sweepOnce();
      await settle();
      expect(first.dispatched).toEqual([row.qitemId]);
      expect(posts).toHaveLength(0);
      expect(notes(row).some((n) => n.startsWith("delivery-decision: "))).toBe(false);
    } finally { read.mockRestore(); }
    const second = await driver!.sweepOnce(); // the quiet state is readable again
    await settle();
    expect(second.fresh, "the deferred ask is offered again without a restart").toBe(1);
    expect(posts).toHaveLength(0);
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(true);
    expect(releaseJobs()).toHaveLength(1);
  });

  it("review: a hold whose release job can't be registered leaves nothing half-written; the next flush holds it properly and it posts once", async () => {
    const row = await ask();
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    quietOn();
    const w = wire();
    const flush = () => runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    const register = vi.spyOn(WatchdogJobsRepository.prototype, "register").mockImplementationOnce(() => { throw new Error("job table busy (test)"); });
    await expect(flush()).rejects.toThrow(/job table busy/);
    register.mockRestore();
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(false); // no note without its job
    expect(releaseJobs()).toHaveLength(0);
    await flush(); // the next flush holds it, with its job
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(true);
    expect(releaseJobs()).toHaveLength(1);
    quiet.end("person", { endedBy: "t", now: new Date() });
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: releaseJobs()[0]!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(1);
  });

  it("review: a digest post decided before quiet began and replayed during it holds its routine ask; an escalation in it still posts", async () => {
    const routine = await ask();
    const urgent = await ask({ tags: ["escalation"] }); // escalated since its digest decision
    for (const row of [routine, urgent]) {
      const a = await alertFor(row);
      repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${a.notificationKey}` });
    }
    const first = wire();
    failPosts = true; // (2) transport fails before the digest posts: it stays in the durable buffer
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => first.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(0);
    expect(new DispatchBuffer(home).pending().length).toBeGreaterThan(0);
    quietOn(); // (3)
    first.stop();
    failPosts = false;
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    const second = wire(); // (4) the restart replays the buffered digest during quiet
    await settle();
    expect(posts.map((p) => JSON.stringify(p)).filter((p) => p.includes(String(routine.body)))).toHaveLength(0);
    expect(posts.map((p) => JSON.stringify(p)).filter((p) => p.includes(String(urgent.body)))).toHaveLength(1);
    expect(notes(routine).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(true);
    quiet.end("person", { endedBy: "t", now: new Date() });
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: releaseJobs()[0]!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => second.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts.map((p) => JSON.stringify(p)).filter((p) => p.includes(String(routine.body)))).toHaveLength(1);
  });

  it("review 4 (a): a digest that landed but lost its response, replayed into quiet, is reconciled, not held and posted again", async () => {
    const row = await ask();
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    const first = wire();
    loseResponses = true;
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => first.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(1); // it landed
    expect(notes(row).some((n) => n.startsWith("slack-owner-notification-posted "))).toBe(false); // but nobody knows
    quietOn();
    first.stop();
    loseResponses = false;
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    wire(); // restart during quiet: the replay
    await settle();
    expect(notes(row).filter((n) => n.startsWith("slack-owner-notification-posted "))).toHaveLength(1); // reconciled
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(false);
    quiet.end("person", { endedBy: "t", now: new Date() });
    for (const job of releaseJobs()) {
      await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job.jobId,
        registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => wires.at(-1)!.dispatcher.dispatch(op, ref, payload, opts as never) });
    }
    await settle();
    expect(posts).toHaveLength(1); // exactly one message, ever
  });

  it("review 4b: an attempted digest whose scan can't finish, replayed into quiet, is held, not posted into quiet", async () => {
    const row = await ask();
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    const first = wire();
    loseResponses = true;
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => first.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(1); // attempted (it may or may not be in Slack: the scan below can't tell)
    quietOn();
    first.stop();
    loseResponses = false;
    historyIncomplete = true;
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    wire(); // restart during quiet: the replay
    await settle();
    expect(posts, "nothing posts into quiet").toHaveLength(1);
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(true);
    quiet.end("person", { endedBy: "t", now: new Date() });
    for (const job of releaseJobs()) {
      await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job.jobId,
        registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => wires.at(-1)!.dispatcher.dispatch(op, ref, payload, opts as never) });
    }
    await settle();
    expect(posts.length - 1, "at most one post after quiet").toBeLessThanOrEqual(1);
  });

  it("review 4b: an attempted release whose scan can't finish, replayed after quiet came back, is declined, not posted", async () => {
    quietOn();
    const row = await ask();
    const first = wire();
    const alert = await alertFor(row);
    first.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, toPayload(alert));
    await settle();
    quiet.end("person", { endedBy: "t", now: new Date() });
    loseResponses = true;
    const [job] = releaseJobs();
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job!.jobId,
      registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => first.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(1); // the release was attempted; its response was lost
    quietOn(); // quiet came back on
    first.stop();
    loseResponses = false;
    historyIncomplete = true;
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    wire(); // restart: the buffered release replays
    await settle();
    expect(posts, "no post into quiet").toHaveLength(1);
    expect(notes(row).some((n) => n.startsWith("quiet-release-returned "))).toBe(true);
  });

  // A routine two-part ask (primary plus supplemental detail) to a person who is posted to straight away: the primary
  // lands outside quiet, the supplemental part fails, and the decision stays in the buffer.
  async function partlyPosted(extra: Record<string, unknown> = {}) {
    const row = await ask({ destinationSession: "other@external", humanDetail: "The full supplemental detail for this decision.", ...extra });
    const first = wire();
    failFromPost = 2;
    first.dispatcher.dispatch(OUTBOUND_OP, "other@external", toPayload((await alertFor(row)) as never));
    await settle();
    expect(posts).toHaveLength(1); // the primary is in Slack; the supplemental part isn't
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    failFromPost = 0;
    return { row, first };
  }
  const quietOnFor = (id: string) => { const now = new Date(); quiet.setUntil(id, { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "t", now }); };
  const restart = (w: ReturnType<typeof wire>) => {
    w.stop();
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    return wire();
  };
  const release = async () => {
    for (const job of releaseJobs()) {
      await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job.jobId,
        registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => wires.at(-1)!.dispatcher.dispatch(op, ref, payload, opts as never) });
    }
    await settle();
  };
  const finishedAsContinuation = (row: QueueItem) => {
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ channel: posts[0]!.channel, thread_ts: "1724.101" }); // in the primary's thread and channel
    expect(String(posts[1]!.text)).toMatch(/:part:2\)$/); // the original decision's own second part
    expect(posts.filter((post) => /:part:1\)$/.test(String(post.text)))).toHaveLength(1); // the primary, never again
    expect(notes(row).filter((n) => n.startsWith("slack-owner-notification-posted "))).toHaveLength(1);
  };

  it("review 7: a partly posted ask replayed during quiet finishes as itself: only its missing part, in its thread", async () => {
    const { row, first } = await partlyPosted();
    quietOnFor("other");
    restart(first); // the replay, during quiet
    await settle();
    finishedAsContinuation(row); // part 2 once in the primary's thread and channel, part 1 never again, one receipt
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold ")), "a started post isn't held").toBe(false);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("review 7: a partly posted notice finishes during quiet even after the posting dial was raised", async () => {
    const { row, first } = await partlyPosted({ humanIntent: "update" });
    quietOnFor("other");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: join(home, "slack.env"), minimumLevelThatPosts: "ALERT" }, home);
    restart(first);
    await settle();
    finishedAsContinuation(row);
  });

  it("review 7: a partly posted ask finishes without reading quiet hours, so a failed quiet read doesn't stop it", async () => {
    const { row, first } = await partlyPosted();
    quietOnFor("other");
    const read = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("disk I/O error (test)"); });
    try {
      restart(first);
      await settle();
    } finally { read.mockRestore(); }
    finishedAsContinuation(row);
  });

  it("review 7: a partly posted digest replayed during quiet finishes whole, never trimmed", async () => {
    const a = await ask({ destinationSession: "other@external" });
    const b = await ask({ destinationSession: "other@external" });
    const member = async (r: QueueItem) => ({ qitemId: r.qitemId, notificationKey: (await alertFor(r)).notificationKey!, level: "NOTICE", kind: "human-required" });
    const memberReceipts = [await member(a), await member(b)];
    const first = wire();
    failFromPost = 2;
    first.dispatcher.dispatch(OUTBOUND_OP, "other@external", {
      deliveryDigestPost: true, digestId: "agg2", qitemId: a.qitemId, destinationSession: "other@external", humanDetail: "Both items in full.",
      summary: "Delivery digest (4h) — 2 item(s)", body: `• ${a.summary} [${a.qitemId}]\n• ${b.summary} [${b.qitemId}]`, memberReceipts,
    }, { decisionId: "digest:agg2-test" } as never);
    await settle();
    failFromPost = 0;
    expect(posts).toHaveLength(1);
    quietOnFor("other");
    restart(first); // during quiet
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ channel: posts[0]!.channel, thread_ts: "1724.101" });
    expect(String(posts[1]!.text)).toMatch(/:part:2\)$/);
    for (const r of [a, b]) {
      expect(notes(r).filter((n) => n.startsWith("slack-owner-notification-posted "))).toHaveLength(1);
      expect(notes(r).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(false);
    }
  });

  it("review 7: a two-part release that partly posted finishes as itself, even after quiet came back on", async () => {
    quietOn();
    const row = await ask({ humanDetail: "The full supplemental detail for this decision." });
    const first = wire();
    first.dispatcher.dispatch(OUTBOUND_OP, "person@external", toPayload(await alertFor(row)));
    await settle();
    expect(posts).toHaveLength(0); // never started: held
    quiet.end("person", { endedBy: "t", now: new Date() });
    failFromPost = 2;
    await release(); // the release's primary lands; its supplemental part fails
    failFromPost = 0;
    expect(posts).toHaveLength(1);
    quietOn(); // quiet comes back on
    restart(first); // the buffered release replays
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ channel: posts[0]!.channel, thread_ts: "1724.101" });
    expect(posts.filter((post) => /:part:1\)$/.test(String(post.text)))).toHaveLength(1);
    expect(notes(row).filter((n) => n.startsWith("slack-owner-notification-posted "))).toHaveLength(1);
  });

  it.each(["maybe", "absent"])("review 8: an attempted digest that reads %s, whose quiet read fails, stays pending as it is; the next flush leaves it", async (landing) => {
    const row = await ask();
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    const first = wire();
    if (landing === "maybe") loseResponses = true; else failPosts = true;
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => first.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    loseResponses = false;
    failPosts = false;
    const [original] = new DispatchBuffer(home).pending();
    expect(original!.decisionId.startsWith("digest:")).toBe(true);
    const before = posts.length;
    if (landing === "maybe") historyIncomplete = true;
    const read = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("disk I/O error (test)"); });
    try {
      restart(first); // the replay: not found in Slack, then quiet hours can't be read
      await settle();
    } finally { read.mockRestore(); }
    expect(posts.length, "nothing posts").toBe(before);
    expect(notes(row).some((n) => n.startsWith("slack-owner-notification-posted "))).toBe(false);
    expect(new DispatchBuffer(home).pending(), "the original, id and payload, is still pending").toEqual([original]);
    const flushed = await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: () => { throw new Error("the next flush must not re-mint it"); } });
    expect(flushed.dispatched).toBe(0);
  });

  it("review 8 (control): a never-attempted digest whose quiet read fails is acked; the next flush selects it again", async () => {
    const row = await ask();
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    const buffer = new DispatchBuffer(home);
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => { buffer.enqueue({ kind: "outbound_decision", decisionId: opts!.decisionId!, op, entityBindingRef: ref, payload }); return { ok: true }; } });
    expect(buffer.pending()).toHaveLength(1); // buffered, never attempted
    const read = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("disk I/O error (test)"); });
    try {
      wire(); // startup replays it: never attempted, then quiet hours can't be read
      await settle();
    } finally { read.mockRestore(); }
    expect(posts).toHaveLength(0);
    expect(buffer.pending(), "acked").toHaveLength(0);
    let dispatched = 0;
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: () => { dispatched++; return { ok: true }; } });
    expect(dispatched, "the next flush selects it again").toBe(1);
  });

  it.each(["absent", "maybe"])("review 7: an attempted routine ask whose landing reads %s hasn't started, so quiet holds it", async (landing) => {
    const row = await ask({ destinationSession: "other@external" });
    const first = wire();
    if (landing === "absent") failPosts = true; // attempted; the connector was down before the post
    else loseResponses = true; // it may be in Slack, but the scan below can't finish
    first.dispatcher.dispatch(OUTBOUND_OP, "other@external", toPayload(await alertFor(row)));
    await settle();
    failPosts = false;
    loseResponses = false;
    const before = posts.length;
    quietOnFor("other");
    if (landing === "maybe") historyIncomplete = true;
    restart(first); // the replay, during quiet
    await settle();
    expect(posts.length, "nothing posts into quiet").toBe(before);
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(true);
    expect(notes(row).some((n) => n.startsWith("slack-owner-notification-posted "))).toBe(false);
  });

  it("review 7: an attempted post that never landed, whose quiet read fails, is retained; once reads recover it's held, then released once", async () => {
    const row = await ask({ destinationSession: "other@external" });
    const first = wire();
    failPosts = true; // attempted, but the connector was down before the post: nothing reached Slack
    first.dispatcher.dispatch(OUTBOUND_OP, "other@external", toPayload(await alertFor(row)));
    await settle();
    failPosts = false;
    expect(posts).toHaveLength(0);
    quietOnFor("other");
    const read = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("disk I/O error (test)"); });
    let w: ReturnType<typeof wire>;
    try {
      w = restart(first); // the replay can't decide
      await settle();
    } finally { read.mockRestore(); }
    expect(posts).toHaveLength(0);
    expect(new DispatchBuffer(home).pending(), "retained, not acked").toHaveLength(1);
    w = restart(w); // reads recover: it hasn't started, so quiet holds it
    await settle();
    expect(posts).toHaveLength(0);
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold "))).toBe(true);
    quiet.end("other", { endedBy: "t", now: new Date() });
    await release();
    expect(posts).toHaveLength(1);
    expect(notes(row).filter((n) => n.startsWith("slack-owner-notification-posted "))).toHaveLength(1);
  });

  it("review 5: outside quiet, a partly posted ask replayed after a restart finishes as before", async () => {
    const { row, first } = await partlyPosted();
    restart(first);
    await settle();
    finishedAsContinuation(row);
    expect(releaseJobs()).toHaveLength(0);
  });

  // An aggregate digest of two members, dispatched as the flush would: A is routine, B has since become an escalation.
  async function aggregateOf(w: ReturnType<typeof wire>) {
    const a = await ask();
    const b = await ask({ tags: ["escalation"] });
    const member = async (row: QueueItem) => ({ qitemId: row.qitemId, notificationKey: (await alertFor(row)).notificationKey!, level: "NOTICE", kind: "human-required" });
    const memberReceipts = [await member(a), await member(b)];
    w.dispatcher.dispatch(OUTBOUND_OP, "person@external", {
      deliveryDigestPost: true, digestId: "agg", qitemId: a.qitemId, destinationSession: "person@external",
      summary: "Delivery digest (4h) — 2 item(s)", body: `• ${a.summary} [${a.qitemId}]\n• ${b.summary} [${b.qitemId}]`, memberReceipts,
    }, { decisionId: "digest:agg-test" } as never);
    return { a, b };
  }
  const receiptKeys = (row: QueueItem) => notes(row).filter((n) => n.startsWith("slack-owner-notification-posted "))
    .map((n) => n.split(/\s+/).find((t) => t.startsWith("notification_key="))!);

  it("review 4 (b): a trimmed digest's receipts bind to exactly the members posted under its id", async () => {
    quietOn();
    const first = wire();
    loseResponses = true;
    const { a, b } = await aggregateOf(first);
    await settle();
    expect(posts).toHaveLength(1); // the escalation went out under a new id, during quiet; its response was lost
    expect(JSON.stringify(posts[0])).not.toContain(String(a.summary));
    quiet.end("person", { endedBy: "t", now: new Date() });
    first.stop();
    loseResponses = false;
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    const second = wire(); // the replay after quiet: reconciles what landed
    await settle();
    expect(receiptKeys(b)).toHaveLength(1);
    expect(receiptKeys(a), "A was never posted, so it has no receipt").toHaveLength(0);
    for (const job of releaseJobs()) {
      await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job.jobId,
        registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => second.dispatcher.dispatch(op, ref, payload, opts as never) });
    }
    await settle();
    expect(receiptKeys(a)).toHaveLength(1); // A posted exactly once, by its release
    expect(posts.filter((p) => JSON.stringify(p).includes(String(a.body)))).toHaveLength(1);
  });

  it("review 4 (c): a trimmed digest post that fails, then the release, then a replay with quiet off: no second A", async () => {
    quietOn();
    const first = wire();
    failPosts = true;
    const { a } = await aggregateOf(first);
    await settle();
    expect(posts).toHaveLength(0);
    quiet.end("person", { endedBy: "t", now: new Date() });
    failPosts = false;
    for (const job of releaseJobs()) {
      await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: job.jobId,
        registry: { loadHumanRegistry: registry as never }, dispatch: (op, ref, payload, opts) => first.dispatcher.dispatch(op, ref, payload, opts as never) });
    }
    await settle();
    first.stop();
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    wire(); // replay with quiet off
    await settle();
    const aLines = posts.filter((p) => JSON.stringify(p).includes(String(a.summary)));
    expect(aLines, "A appears once: its release").toHaveLength(1);
  });

  it("the digest flush holds a pre-quiet ask for a quiet second person, under that person's window", async () => {
    order = ["other", "person"];
    const row = await ask();
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    quietOn();
    const w = wire();
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(0);
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold"))).toBe(true);
    expect(releaseJobs()).toHaveLength(1);
  });

  it("the digest flush doesn't capture a non-quiet person's ask under someone else's quiet window", async () => {
    const row = await ask({ destinationSession: "other@external" });
    const alert = await alertFor(row);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey}` });
    quietOn(); // the first registered person is quiet; the ask's recipient isn't
    const w = wire();
    await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, window: "4h",
      dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    await settle();
    expect(posts).toHaveLength(1);
    expect(notes(row).some((n) => n.startsWith("delivery-decision: quiet-hold"))).toBe(false);
    expect(releaseJobs()).toHaveLength(0);
  });
});

// ─── After review: the real outbound sweep when a dispatch throws ───────────────────────────────────────────────────

describe("after review: the outbound sweep when a dispatch throws", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "sweep-throw-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const alerts = [
    { qitemId: "q-1", notificationKey: "q-1:11", destinationSession: "person@external", summary: "one" },
    { qitemId: "q-2", notificationKey: "q-2:12", destinationSession: "person@external", summary: "two" },
  ];
  function driverWith(dispatch: (payload: { notificationKey?: string; qitemId: string }) => { ok: true; decisionId: string }) {
    return new SlackOutboundDriver({
      home, queue: { listHumanAlerts: async () => alerts } as never, seen: new SeenStore(join(home, "seen.jsonl")), filter: { minimumLevel: "NOTICE" } as never,
      dispatch: (_op, _ref, payload) => dispatch(payload as { notificationKey?: string; qitemId: string }), log: () => {},
    });
  }

  it("a dispatch that throws before anything is persisted is offered again on the next sweep, and the rest of the sweep goes on", async () => {
    let calls: string[] = [];
    let failFirst = true;
    const driver = driverWith((p) => {
      calls.push(p.qitemId);
      if (failFirst && p.qitemId === "q-1") throw new Error("descriptor rejected (test)");
      return { ok: true, decisionId: `d-${p.qitemId}` };
    });
    const first = await driver.sweepOnce();
    expect(calls).toEqual(["q-1", "q-2"]); // the throw on the first alert didn't stop the second
    expect(first.dispatched).toEqual(["q-2"]);
    expect(first.refused.map((r) => r.qitemId)).toEqual(["q-1"]);
    failFirst = false; calls = [];
    const second = await driver.sweepOnce();
    expect(calls).toEqual(["q-1"]); // q-1 offered again; q-2 is in flight
    expect(second.dispatched).toEqual(["q-1"]);
  });

  // Faults that fail for every user, root included (permission bits don't stop root), and are never ENOENT.
  it.each(["a directory in its place", "corrupt"])("a dispatch that throws while the buffer file is %s stays in flight: can't tell is never 'nothing pending'", async (state) => {
    const buffer = new DispatchBuffer(home);
    buffer.enqueue({ kind: "outbound_decision", decisionId: "d-before", op: OUTBOUND_OP, entityBindingRef: "person@external", payload: alerts[0] });
    const path = dispatchBufferPath(home);
    const before = readFileSync(path, "utf8");
    let calls = 0;
    const driver = new SlackOutboundDriver({
      home, queue: { listHumanAlerts: async () => [alerts[0]] } as never, seen: new SeenStore(join(home, "seen.jsonl")), filter: { minimumLevel: "NOTICE" } as never,
      dispatch: () => { calls++; throw new Error("transport state unavailable (test)"); }, log: () => {},
    });
    if (state === "corrupt") writeFileSync(path, "{ not json");
    else { rmSync(path); mkdirSync(path); } // the read throws EISDIR
    try {
      const first = await driver.sweepOnce();
      const second = await driver.sweepOnce();
      expect(first.refused).toHaveLength(1);
      expect(second.fresh, "the key stays in flight rather than risk a second decision").toBe(0);
      expect(calls).toBe(1);
    } finally {
      if (state !== "corrupt") rmSync(path, { recursive: true, force: true });
      writeFileSync(path, before);
    }
    expect(buffer.pending().map((d) => d.decisionId)).toEqual(["d-before"]);
  });

  it("a stored decision whose directory is replaced by a file isn't 'no file': the strict read throws and the ask stays in flight", async () => {
    const buffer = new DispatchBuffer(home);
    buffer.enqueue({ kind: "outbound_decision", decisionId: "d-parent", op: OUTBOUND_OP, entityBindingRef: "person@external", payload: alerts[0] });
    const path = dispatchBufferPath(home);
    const parent = dirname(path);
    const before = readFileSync(path, "utf8");
    let calls = 0;
    const driver = new SlackOutboundDriver({
      home, queue: { listHumanAlerts: async () => [alerts[0]] } as never, seen: new SeenStore(join(home, "seen.jsonl")), filter: { minimumLevel: "NOTICE" } as never,
      dispatch: () => { calls++; throw new Error("transport state unavailable (test)"); }, log: () => {},
    });
    renameSync(parent, `${parent}.aside`);
    writeFileSync(parent, "not a directory"); // the read throws ENOTDIR
    try {
      expect(() => buffer.pendingStrict()).toThrow();
      await driver.sweepOnce();
      const second = await driver.sweepOnce();
      expect(second.fresh).toBe(0);
      expect(calls).toBe(1);
    } finally {
      rmSync(parent, { force: true });
      renameSync(`${parent}.aside`, parent);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(buffer.pending().map((d) => d.decisionId)).toEqual(["d-parent"]);
  });

  it("a buffer that doesn't exist yet, or whose directory doesn't, is still 'nothing pending' to the strict read", () => {
    expect(new DispatchBuffer(home).pendingStrict()).toEqual([]); // no gateway directory at all
    mkdirSync(dirname(dispatchBufferPath(home)), { recursive: true });
    expect(new DispatchBuffer(home).pendingStrict()).toEqual([]); // the directory, but no file
  });

  it("a dispatch that throws after its decision was persisted stays in flight: replay owns it, and no second decision is made", async () => {
    let calls = 0;
    const buffer = new DispatchBuffer(home);
    const driver = driverWith((p) => {
      calls++;
      if (p.qitemId === "q-1") {
        buffer.enqueue({ kind: "outbound_decision", decisionId: "d-q-1", op: OUTBOUND_OP, entityBindingRef: "person@external", payload: p });
        throw new Error("send failed after enqueue (test)");
      }
      return { ok: true, decisionId: `d-${p.qitemId}` };
    });
    await driver.sweepOnce();
    expect(calls).toBe(2);
    calls = 0;
    const second = await driver.sweepOnce();
    expect(calls).toBe(0);
    expect(second.fresh).toBe(0);
    expect(buffer.pending().filter((d) => (d.payload as { qitemId?: string }).qitemId === "q-1")).toHaveLength(1);
  });
});
