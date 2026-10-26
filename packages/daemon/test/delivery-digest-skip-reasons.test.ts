// #800: when the delivery digest sends nothing, its watchdog skip reason says why, instead of "nothing to flush" for
// every case. A flush that dispatches keeps its result and its reason exactly as before. Real SQLite (all migrations)
// and the real queue; dispatch is a recorder.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { loadHumanRegistry } from "../src/domain/gateway/human-registry.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { makeDeliveryDigestFlushPolicy, runDeliveryDigestFlush } from "../src/domain/policies/delivery-digest-flush.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const person = (id: string) => ({
  entityId: id, class: "human" as const, displayName: id, address: `${id}@external`,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: `U${id.toUpperCase()}` }],
  prefs: { deliveryClass: "C", availability: "available" },
});

describe("delivery digest skip reasons (#800)", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let people: string[];
  let registryOk: boolean;
  const registry = () => registryOk ? { ok: true as const, entities: people.map(person) } : { ok: false as const, error: "unreadable (test)" };
  let dispatchOk: boolean;
  const sent: unknown[] = [];
  const dispatch = (_op: string, _ref: string, payload: unknown) => {
    sent.push(payload);
    return dispatchOk ? { ok: true } : { ok: false, error: "connector down (test)" };
  };

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    people = ["human-founder"];
    registryOk = true;
    dispatchOk = true;
    sent.length = 0;
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: registry as never });
    home = mkdtempSync(join(tmpdir(), "digest-skip-"));
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const job = { jobId: "j", policy: "delivery-digest-flush", target: { session: "daemon@kernel" }, intervalSeconds: 60,
    activeWakeIntervalSeconds: null, scanIntervalSeconds: null, context: { window: "4h" } } as unknown as PolicyJob;
  const evaluate = () => makeDeliveryDigestFlushPolicy({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, dispatch }).evaluate(job);

  let n = 0;
  async function inDigest(row: QueueItem): Promise<void> {
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: registry } as never).listHumanAlerts({ minimumLevel: "NOTICE" }))
      .find((a) => a.qitemId === row.qitemId)!;
    expect(alert, "the row is a human alert").toBeDefined();
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
      transitionNote: `delivery-decision: digest window=4h notification_key=${alert.notificationKey ?? alert.qitemId}` });
  }
  async function ask(): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: "asker@r", destinationSession: "orch-lead@r", body: `decision ${++n}`, nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@r", state: "blocked", blockedOn: "human-founder@kernel",
      summary: `Choose ${n}`, evidenceRef: `/proof/${n}.md`, transitionNote: "parked" });
    await inDigest(row);
    return row;
  }
  async function notice(): Promise<QueueItem> {
    // A decision resolved while its row stays active: an ordinary notice, aggregated into the digest.
    const row = await repo.create({ sourceSession: "asker@r", destinationSession: "worker@r", body: `resolved ${++n}`, nudge: false });
    db.prepare(`INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,owner_notification_level,owner_notification_kind)
      VALUES (?, ?, 'pending', 'human-founder@kernel', 'NOTICE', 'human-decision-resolved')`).run(row.qitemId, new Date().toISOString());
    await inDigest(row);
    return row;
  }

  it("nothing marked for the digest still reads 'nothing to flush'", async () => {
    expect(await evaluate()).toEqual({ action: "skip", reason: "nothing to flush" });
  });

  it("an unreadable registry says so", async () => {
    registryOk = false;
    expect(await evaluate()).toEqual({ action: "skip", reason: "the human registry can't be read" });
  });

  it("a fresh home with no registered people says no person is registered", async () => {
    const freshRegistry = { loadHumanRegistry: (home: string) => loadHumanRegistry(home, { readOnly: true }) };
    expect(freshRegistry.loadHumanRegistry(home)).toMatchObject({ ok: false, noHumans: true });
    const policy = makeDeliveryDigestFlushPolicy({ queueRepo: repo, registry: freshRegistry, home, dispatch });
    expect(await policy.evaluate(job)).toEqual({ action: "skip", reason: "no person is registered" });
    expect(sent).toHaveLength(0);
  });

  it("an empty registry says no person is registered", async () => {
    people = [];
    expect(await evaluate()).toEqual({ action: "skip", reason: "no person is registered" });
  });

  it("asks held for quiet hours say how many were held", async () => {
    await ask();
    await ask();
    const now = new Date();
    new HumanQuietStore(db).setUntil("human-founder", { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "test", now });
    expect(await evaluate()).toEqual({ action: "skip", reason: "2 item(s) held for quiet hours" });
    expect(sent).toHaveLength(0);
  });

  it("notices waiting for a default person say why", async () => {
    await notice();
    people = ["human-founder", "human-other"];
    expect(await evaluate()).toEqual({ action: "skip",
      reason: "1 notice(s) wait: several people are registered and none is the default; choose one with `rig gateway default <id>`" });
    expect(sent).toHaveLength(0);
  });

  it("a failed dispatch names the error", async () => {
    await ask();
    dispatchOk = false;
    expect(await evaluate()).toEqual({ action: "skip", reason: "digest dispatch failed: connector down (test)" });
  });

  it("a failed digest post names the error", async () => {
    await notice();
    dispatchOk = false;
    expect(await evaluate()).toEqual({ action: "skip", reason: "digest dispatch failed: connector down (test)" });
  });

  it("a flush that dispatches keeps its result shape and reason", async () => {
    await ask();
    await notice();
    const r = await runDeliveryDigestFlush({ queueRepo: repo, registry: { loadHumanRegistry: registry as never }, home, dispatch, window: "4h" });
    expect(r).toEqual({ dispatched: 2, members: 2 });
  });
});
