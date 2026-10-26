// #1679: after Slack is enabled, `rig slack post-open-asks` shows the asks still open that enable seeded as history, through
// ordinary delivery, and reports what became of each. Real SQLite (all migrations), the real queue, the real gateway wire
// over a recording fetch, the real dispatch buffer, seen store and quiet-hours release job. No Slack.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { makeQueuePorts, seedBacklogAsHistory } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { OUTBOUND_OP, toPayload } from "../src/domain/gateway/slack/outbound-driver.js";
import { DispatchBuffer, dispatchBufferPath } from "../src/domain/gateway/dispatch-buffer.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { resolveSlackHandle, addHumanFragment } from "../src/domain/gateway/human-registry.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { QUIET_RELEASE_POLICY, runQuietRelease } from "../src/domain/policies/quiet-release.js";
import { postOpenAsks, rePresentDecisionId } from "../src/domain/gateway/slack/open-asks.js";
import { gatewayRoutes } from "../src/routes/gateway.js";

const HUMAN = "human-alex";

function registryWith(prefs: Record<string, unknown>, subscriptions?: unknown[]) {
  return {
    ok: true as const,
    entities: [{
      entityId: HUMAN, class: "human" as const, displayName: "Alex", address: `${HUMAN}@external`,
      connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UALEX" }],
      prefs,
      ...(subscriptions ? { subscriptions } : {}),
    }],
  };
}

describe("rig slack post-open-asks through the gateway", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let registry: ReturnType<typeof registryWith>;
  let failPosts: boolean;
  let historyFails: boolean;
  let historyReads: number;
  const posts: Array<Record<string, unknown>> = [];
  const stops: Array<() => void> = [];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    registry = registryWith({ deliveryClass: "B", availability: "available" });
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => registry });
    home = mkdtempSync(join(tmpdir(), "post-open-asks-"));
    posts.length = 0;
    failPosts = false;
    historyFails = false;
    historyReads = 0;
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  function wire() {
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    const w = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, outboundIntervalMs: 60_000,
      fetchImpl: async (url, init) => {
        if (String(url).includes("chat.postMessage")) {
          if (failPosts) throw new TypeError("fetch failed");
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, ts: `1724.9${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("conversations.")) {
          historyReads += 1;
          if (historyFails) return new Response(JSON.stringify({ ok: false, error: "internal_error" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    stops.push(() => w.stop());
    return w;
  }

  let n = 0;
  async function park(): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: "dev-qa@r", destinationSession: "orch-lead@r", body: `decision body ${++n}`, nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@r", state: "blocked", blockedOn: `${HUMAN}@kernel`,
      summary: `Choose ${n}`, evidenceRef: `/proof/${n}.md`, transitionNote: "parked" });
    return row;
  }
  const seenPath = () => join(home, "state", "slack-outbound-seen.jsonl");
  /** What `rig slack enable` does to the backlog: every open alert is seeded as history, nothing posts. */
  const enable = () => seedBacklogAsHistory({ queue: makeQueuePorts(repo, { loadHumanRegistry: () => registry }),
    seen: new SeenStore(seenPath()), filter: { minimumLevel: "NOTICE" } });
  const run = (w: ReturnType<typeof wire>, waitMs = 3_000) => postOpenAsks({
    queueRepo: repo, home, loadHumanRegistry: () => registry, minimumLevelThatPosts: "NOTICE", actor: "operator@rig", waitMs,
    dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts),
  });
  const notes = (row: QueueItem) => repo.listTransitions(row.qitemId).map((t) => t.transitionNote ?? "");
  const keyOf = (row: QueueItem) => `${row.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)!.transitionId}`;
  const resultFor = (r: Awaited<ReturnType<typeof run>>, row: QueueItem) => r.asks.find((a) => a.qitemId === row.qitemId);

  it("posts each ask enable seeded, through ordinary delivery as itself, and reports it posted from its receipt", async () => {
    const rows = [await park(), await park()];
    expect((await enable()).seeded).toBe(2);
    const w = wire();
    w.startServices?.();
    expect(posts, "enable alone posts nothing").toHaveLength(0);

    const result = await run(w);
    expect(result.counts).toEqual({ posted: 2 });
    expect(posts).toHaveLength(2);
    for (const row of rows) {
      const key = keyOf(row);
      expect(resultFor(result, row)).toMatchObject({ outcome: "posted", reshown: true, recipient: `${HUMAN}@external` });
      expect(JSON.stringify(posts)).toContain(String(row.body));
      // In order on the row: who asked for it, then its own thread stamp and posted receipt for the same episode.
      const own = notes(row);
      const requested = own.findIndex((n) => n === `slack-re-present-requested notification_key=${key} by=operator@rig`);
      const receipt = own.findIndex((n) => n.startsWith(`slack-owner-notification-posted notification_key=${key} `));
      expect(requested).toBeGreaterThan(-1);
      expect(receipt).toBeGreaterThan(requested);
      // Its own thread: a reply there reaches this row.
      expect(own.some((n) => n.startsWith("slack-posted ") && n.endsWith(`conversation=${row.qitemId}`))).toBe(true);
      expect(repo.getById(row.qitemId)?.state, "a post is never an answer").toBe("blocked");
    }
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("running it again, or the same decision replayed, posts nothing more and reports already posted", async () => {
    const row = await park();
    await enable();
    const w = wire();
    expect((await run(w)).counts).toEqual({ posted: 1 });
    const again = await run(w);
    expect(again.counts).toEqual({ "already-posted": 1 });
    expect(resultFor(again, row)?.reshown).toBe(false);
    // A restart replaying the same decision converges on the one post.
    const [alert] = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listOpenAsks({ minimumLevel: "NOTICE" }));
    w.dispatcher.dispatch(OUTBOUND_OP, `${HUMAN}@external`, toPayload(alert!.item), { decisionId: rePresentDecisionId(keyOf(row)) });
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
    expect(posts).toHaveLength(1);
  });

  it("reports an ask asked at RECORD as below the floor and leaves an open ask ordinary delivery hasn't offered yet to it", async () => {
    registry = registryWith({ deliveryClass: "B", availability: "available" }, [{ destination: { connector: "slack" }, filter: { preset: "urgent-only" } }]);
    const quietAsk = await repo.create({ sourceSession: "dev-qa@r", destinationSession: `${HUMAN}@external`, summary: "Steering only", body: "a plain ask", evidenceRef: "/proof/steering.md", nudge: false });
    await enable();
    const fresh = await park(); // after enable: unseen, so the sweep owns it
    const w = wire();
    const result = await run(w, 0);
    expect(resultFor(result, quietAsk)).toMatchObject({ outcome: "below-floor", reshown: false, detail: expect.stringMatching(/RECORD/) });
    expect(resultFor(result, fresh)).toMatchObject({ outcome: "queued", reshown: false, detail: expect.stringMatching(/next sweep/) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posts, "the command offers neither").toHaveLength(0);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("holds a routine ask in the person's quiet hours through the existing release, which posts it once quiet ends", async () => {
    const row = await park();
    await enable();
    const quiet = new HumanQuietStore(db);
    const now = new Date();
    quiet.setUntil(HUMAN, { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "test", now });
    const w = wire();
    const result = await run(w);
    expect(resultFor(result, row)).toMatchObject({ outcome: "held", detail: expect.stringMatching(/quiet hours/) });
    expect(posts).toHaveLength(0);
    const jobs = new WatchdogJobsRepository(db).listActive().filter((j) => j.policy === QUIET_RELEASE_POLICY);
    expect(jobs).toHaveLength(1);
    expect((await run(w)).counts, "a second run doesn't offer it again").toEqual({ held: 1 });

    quiet.end(HUMAN, { endedBy: "test", now: new Date() });
    await runQuietRelease({ queueRepo: repo, jobsRepo: new WatchdogJobsRepository(db), home, jobId: jobs[0]!.jobId,
      registry: { loadHumanRegistry: () => registry }, dispatch: (op, ref, payload, opts) => w.dispatcher.dispatch(op, ref, payload, opts as never) });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect((await run(w)).counts).toEqual({ "already-posted": 1 });
  });

  it("reports a transport failure per ask, keeps the row open with its receipt, and keeps the decision for another try", async () => {
    const row = await park();
    await enable();
    failPosts = true;
    const w = wire();
    const result = await run(w);
    expect(resultFor(result, row)).toMatchObject({ outcome: "transport-failed", reshown: true });
    expect(notes(row).some((n) => n.startsWith(`slack-owner-notification-transport-failed notification_key=${keyOf(row)} `))).toBe(true);
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(new DispatchBuffer(home).pending().map((d) => d.decisionId)).toEqual([rePresentDecisionId(keyOf(row))]);
    // Run again: still the same failure, from the kept decision; nothing new is minted.
    const again = await run(w, 0);
    expect(resultFor(again, row)).toMatchObject({ outcome: "transport-failed", reshown: false, detail: expect.stringMatching(/another try/) });
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
  });

  it("an ask whose delivery state can't be read before any attempt reads state unavailable, not posted or queued; a later run posts it", async () => {
    const row = await park();
    await enable();
    const w = wire();
    // The delivery rules can't read the person's quiet hours. (A missing table reads as no quiet hours, so the read throws.)
    const unreadable = vi.spyOn(HumanQuietStore.prototype, "quietStateFor").mockImplementation(() => { throw new Error("database is locked"); });
    const result = await run(w);
    expect(resultFor(result, row)).toMatchObject({ outcome: "state-unavailable", detail: "not posted: database is locked" });
    expect(posts).toHaveLength(0);
    expect(new DispatchBuffer(home).pending(), "nothing is left queued").toHaveLength(0);
    expect(notes(row).some((n) => n.startsWith(`slack-re-present-state-unavailable notification_key=${keyOf(row)} detail=`))).toBe(true);

    unreadable.mockRestore();
    const again = await run(w);
    expect(resultFor(again, row)).toMatchObject({ outcome: "posted", reshown: true });
    expect(posts).toHaveLength(1);
  });

  it("an earlier decision still waiting for delivery is reported queued and isn't offered under a second id", async () => {
    const row = await park();
    await enable();
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listOpenAsks({ minimumLevel: "NOTICE" });
    new DispatchBuffer(home).enqueue({ kind: "outbound_decision", decisionId: "earlier-1", op: OUTBOUND_OP, entityBindingRef: `${HUMAN}@external`, payload: toPayload(alert!.item) });
    const w = wire(); // services not started: the earlier decision stays in the buffer
    const result = await run(w, 0);
    expect(resultFor(result, row)).toMatchObject({ outcome: "queued", reshown: false });
    expect(new DispatchBuffer(home).pending().map((d) => d.decisionId)).toEqual(["earlier-1"]);
  });

  it("X-F1: a dispatch buffer it can't read isn't taken as empty: nothing is offered and the buffer is left as it was", async () => {
    const row = await park();
    await enable();
    const bufferPath = dispatchBufferPath(home);
    mkdirSync(dirname(bufferPath), { recursive: true });
    writeFileSync(bufferPath, "{ not json");
    const w = wire();
    const result = await run(w, 0);
    expect(resultFor(result, row)).toMatchObject({ outcome: "state-unavailable", reshown: false, detail: expect.stringMatching(/^not offered: the gateway's dispatch buffer couldn't be read/) });
    expect(readFileSync(bufferPath, "utf8"), "the unreadable buffer isn't replaced").toBe("{ not json");
    expect(notes(row).some((n) => n.startsWith("slack-re-present-requested "))).toBe(false);
  });

  it("X-F1: a seen store it can't read doesn't promise the ordinary sweep, and nothing is offered", async () => {
    const row = await park();
    await enable(); // the ask is seeded, so the ordinary sweep won't offer it
    renameSync(seenPath(), `${seenPath()}.away`);
    mkdirSync(seenPath()); // exists, can't be read as a file
    const w = wire();
    const result = await run(w, 0);
    expect(resultFor(result, row)).toMatchObject({ outcome: "state-unavailable", reshown: false, detail: expect.stringMatching(/^not offered: the gateway's seen store couldn't be read/) });
    expect(resultFor(result, row)?.detail).not.toMatch(/sweep/);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("X-F1: an earlier decision whose attempt record can't be read reads uncertain, not queued", async () => {
    const row = await park();
    await enable();
    const [open] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listOpenAsks({ minimumLevel: "NOTICE" });
    new DispatchBuffer(home).enqueue({ kind: "outbound_decision", decisionId: "earlier-2", op: OUTBOUND_OP, entityBindingRef: `${HUMAN}@external`, payload: toPayload(open!.item) });
    mkdirSync(join(home, "state", "slack-attempted-decisions.jsonl"), { recursive: true });
    const w = wire();
    const result = await run(w, 0);
    expect(resultFor(result, row)).toMatchObject({ outcome: "uncertain", reshown: false, detail: expect.stringMatching(/whether it reached Slack can't be read/) });
    expect(new DispatchBuffer(home).pending().map((d) => d.decisionId)).toEqual(["earlier-2"]);
  });

  it("X-F2: an attempted re-shown ask whose Slack outcome can't be confirmed, and whose state can't be read, stays uncertain and kept", async () => {
    const row = await park();
    await enable();
    const [open] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listOpenAsks({ minimumLevel: "NOTICE" });
    const decisionId = rePresentDecisionId(keyOf(row));
    // An earlier run offered it, the post was attempted, and its reply was lost: it's still in the buffer.
    new DispatchBuffer(home).enqueue({ kind: "outbound_decision", decisionId, op: OUTBOUND_OP, entityBindingRef: `${HUMAN}@external`, payload: toPayload(open!.item) });
    new SeenStore(join(home, "state", "slack-attempted-decisions.jsonl")).mark(decisionId, "attempted");
    const readable = registry;
    historyFails = true; // the replay's Slack scan is inconclusive
    registry = { ok: false, error: "the human registry couldn't be read" } as never; // and the current state can't be read
    const w = wire();
    w.startServices?.(); // replays the kept decision
    await vi.waitFor(() => expect(historyReads).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts, "never forced past the check").toHaveLength(0);
    expect(new DispatchBuffer(home).pending().map((d) => d.decisionId), "kept for its next replay").toEqual([decisionId]);
    expect(notes(row).some((n) => n.startsWith("slack-re-present-state-unavailable ") || n.startsWith("slack-re-present-disposition ")),
      "no not-posted record for an ask that may be in Slack").toBe(false);

    registry = readable;
    const result = await run(w, 0);
    expect(resultFor(result, row)).toMatchObject({ outcome: "uncertain", reshown: false });
  });

  it("X-F3: on replay, an attempt log that can't be read stays unknown: nothing posts, the decision is kept, no not-posted record", async () => {
    const row = await park();
    await enable();
    const [open] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listOpenAsks({ minimumLevel: "NOTICE" });
    const decisionId = rePresentDecisionId(keyOf(row));
    new DispatchBuffer(home).enqueue({ kind: "outbound_decision", decisionId, op: OUTBOUND_OP, entityBindingRef: `${HUMAN}@external`, payload: toPayload(open!.item) });
    mkdirSync(join(home, "state", "slack-attempted-decisions.jsonl"), { recursive: true }); // the attempt log exists, can't be read
    const readable = registry;
    registry = { ok: false, error: "the human registry couldn't be read" } as never; // and the current state can't be read
    const w = wire();
    w.startServices?.(); // replays the kept decision
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(posts).toHaveLength(0);
    expect(new DispatchBuffer(home).pending().map((d) => d.decisionId), "kept for its next replay").toEqual([decisionId]);
    expect(notes(row).some((n) => n.startsWith("slack-re-present-state-unavailable ") || n.startsWith("slack-re-present-disposition ")),
      "no not-posted record while whether it was attempted is unknown").toBe(false);

    registry = readable;
    const result = await run(w, 0);
    expect(resultFor(result, row)).toMatchObject({ outcome: "uncertain", reshown: false, detail: expect.stringMatching(/whether it reached Slack can't be read/) });
  });

  it("at post time, a re-shown ask that's no longer current posts nothing and its row says why", async () => {
    const superseded = await park();
    const closed = await park();
    await enable();
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry });
    const items = new Map((await ports.listOpenAsks({ minimumLevel: "NOTICE" })).map((e) => [e.item.qitemId, e.item]));
    const w = wire();
    // Dispatched, then the world moved before it posted: a newer ask on one row, the other row closed.
    repo.update({ qitemId: superseded.qitemId, actorSession: "orch-lead@r", state: "in-progress", transitionNote: "picked up" });
    repo.update({ qitemId: superseded.qitemId, actorSession: "orch-lead@r", state: "blocked", blockedOn: `${HUMAN}@kernel`, transitionNote: "parked again" });
    repo.update({ qitemId: closed.qitemId, actorSession: "orch-lead@r", state: "done", closureReason: "no-follow-on", transitionNote: "done" });
    for (const row of [superseded, closed]) {
      const item = items.get(row.qitemId)!;
      w.dispatcher.dispatch(OUTBOUND_OP, `${HUMAN}@external`, toPayload(item), { decisionId: rePresentDecisionId(item.notificationKey!) });
    }
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
    expect(posts).toHaveLength(0);
    expect(notes(superseded)).toContain(`slack-re-present-disposition notification_key=${items.get(superseded.qitemId)!.notificationKey} reason=superseded`);
    expect(notes(closed)).toContain(`slack-re-present-disposition notification_key=${items.get(closed.qitemId)!.notificationKey} reason=row-not-active`);
  });
});

describe("POST /slack/post-open-asks", () => {
  const homes: string[] = [];
  const databases: Database.Database[] = [];
  afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }));
  });

  function fixture(enabled: boolean) {
    const home = mkdtempSync(join(tmpdir(), "post-open-asks-route-"));
    homes.push(home);
    addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex", address: "alex@external",
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "env:private-pointer", role: "primary" }],
      prefs: { deliveryClass: "B" } }, home);
    saveConfig({ ...DEFAULT_CONFIG, enabled, secretsEnvFile: "private-pointer", channel: "C-private" }, home);
    const db = createDb();
    databases.push(db);
    migrate(db, ALL_MIGRATIONS);
    const queueRepo = new QueueRepository(db, new EventBus(db));
    /** An open ask to Alex, as the queue records one: the row and its ALERT notification. Returns its episode key. */
    const ask = (id: string) => {
      db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body,summary)
        VALUES (?, '2026-01-01', '2026-01-01', 'author@rig', 'alex@external', 'pending', 'an ask', 'Pick one')`).run(id);
      const result = db.prepare(`INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,owner_notification_level,owner_notification_kind)
        VALUES (?, '2026-01-01', 'pending', 'author@rig', 'ALERT', 'human-required')`).run(id);
      return `${id}:${result.lastInsertRowid}`;
    };
    const dispatched: Array<{ decisionId?: string }> = [];
    const buffer = new DispatchBuffer(home);
    const subsystem = {
      restart: () => {},
      status: () => ({ state: enabled ? "active" : "stopped", connector: { outboundReady: enabled } }),
      // Accepted into the buffer, never delivered here: the route reports it queued, awaiting its receipt.
      dispatch: (op: string, ref: string, payload: unknown, opts?: { decisionId?: string }) => {
        dispatched.push({ decisionId: opts?.decisionId });
        buffer.enqueue({ kind: "outbound_decision", decisionId: opts!.decisionId!, op, entityBindingRef: ref, payload });
        return { ok: true as const, decisionId: opts!.decisionId! };
      },
    };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, queueRepo as never);
      c.set("gatewaySubsystem" as never, subsystem as never);
      await next();
    });
    app.route("/", gatewayRoutes({ home }));
    const post = (body: object = {}) => app.request("/slack/post-open-asks", {
      method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator@rig" }, body: JSON.stringify(body),
    });
    return { home, ask, dispatched, post };
  }

  it("says nothing was shown when Slack isn't posting here, and changes nothing", async () => {
    const { post, dispatched } = fixture(false);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "slack_not_posting", message: expect.stringMatching(/rig slack enable first/) });
    expect(dispatched).toHaveLength(0);
  });

  it("offers a seeded ask under its fixed id, records the action with its actor and reason, and reports it queued", async () => {
    const { home, ask, dispatched, post } = fixture(true);
    const key = ask("q-open-1");
    new SeenStore(join(home, "state", "slack-outbound-seen.jsonl")).seed([key], "seeded-at-enable");

    const res = await post({ reason: "catching up after enable", waitSeconds: 0 });
    expect(res.status).toBe(200);
    const body = await res.json() as { asks: Array<Record<string, unknown>>; counts: Record<string, number>; receipt: Record<string, unknown> };
    expect(dispatched).toEqual([{ decisionId: `re-present:${key}` }]);
    expect(body.counts).toEqual({ queued: 1 });
    expect(body.asks[0]).toMatchObject({ qitemId: "q-open-1", outcome: "queued", reshown: true, recipient: "alex@external" });
    expect(body.receipt).toMatchObject({ action: "post-open-asks", actor: "operator@rig", reason: "catching up after enable", effect: "applied" });
  });
});
