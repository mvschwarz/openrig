import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";

const registry = {
  ok: true as const,
  entities: [
    {
      entityId: "human-founder",
      class: "human" as const,
      displayName: "Founder",
      address: "human-founder@external",
      connectorBindings: [
        {
          kind: "slack" as const,
          connectorRef: "primary",
          secretsRef: "env:SLACK_BOT_TOKEN",
          role: "primary" as const,
          handle: "UFOUNDER",
        },
      ],
      prefs: { deliveryClass: "A" as const },
    },
  ],
};

function ensureNotificationColumns(db: Database.Database): void {
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    const names = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!names.has("owner_notification_kind")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_kind TEXT`);
    if (!names.has("owner_notification_level")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_level TEXT`);
  }
}

// Noise rows are NEWER than the eligible row and far outnumber any window a
// bounded newest-first read could have taken: with the old cap they crowded the
// eligible row out of both views.
const NOISE_ROWS = 1100;
const NOISE_EPOCH = Date.parse("2026-10-01T00:00:00.000Z");
const ELIGIBLE_EPOCH = Date.parse("2026-09-01T00:00:00.000Z");

describe("queue-access owner-notification episodes", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureNotificationColumns(db);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  /** Active rows with no owner-notification transition at all: the pathological
   *  backlog that used to pay two per-row lookups each on every sweep. */
  const seedNoise = (): void => {
    const insert = db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
       VALUES (?, ?, ?, 'orch-lead@v-openrig-build', 'human-founder@external', 'pending', ?)`,
    );
    const seed = db.transaction(() => {
      for (let i = 0; i < NOISE_ROWS; i += 1) {
        const id = `qitem-noise-${String(i).padStart(7, "0")}`;
        const ts = new Date(NOISE_EPOCH + i).toISOString();
        insert.run(id, ts, ts, `noise ${i}`);
      }
    });
    seed();
  };

  /** One eligible human-required ALERT row with the OLDEST timestamp — older than
   *  every noise row, so a newest-first bounded read would leave it out. */
  const seedOldestEligible = (id: string, notificationKind = "human-required"): number => {
    const ts = new Date(ELIGIBLE_EPOCH).toISOString();
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
       VALUES (?, ?, ?, 'orch-lead@v-openrig-build', 'human-founder@external', 'pending', ?)`,
    ).run(id, ts, ts, `eligible ${id}`);
    const transition = db
      .prepare(
        `INSERT INTO queue_transitions (qitem_id, ts, state, actor_session, owner_notification_kind, owner_notification_level)
         VALUES (?, ?, 'pending', 'orch-lead@v-openrig-build', ?, 'ALERT')`,
      )
      .run(id, ts, notificationKind);
    return Number(transition.lastInsertRowid);
  };

  it("an eligible item older than every noise row still appears in BOTH views", async () => {
    seedNoise();
    seedOldestEligible("qitem-eligible-oldest");

    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const alerts = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alerts.map((a) => a.qitemId)).toContain("qitem-eligible-oldest");

    const openAsks = await ports.listOpenAsks({ minimumLevel: "NOTICE" });
    expect(openAsks.map((a) => a.item.qitemId)).toContain("qitem-eligible-oldest");
    expect(openAsks.find((a) => a.item.qitemId === "qitem-eligible-oldest")?.posted).toBe(false);
  });

  it("a posted eligible row leaves the alert sweep but stays in the open-asks view with posted=true", async () => {
    const transitionId = seedOldestEligible("qitem-eligible-posted");
    db.prepare(
      `INSERT INTO queue_transitions (qitem_id, ts, state, actor_session, transition_note)
       VALUES ('qitem-eligible-posted', ?, 'pending', 'daemon@kernel', ?)`,
    ).run(
      new Date(ELIGIBLE_EPOCH + 1000).toISOString(),
      `slack-owner-notification-posted notification_key=qitem-eligible-posted:${transitionId} level=ALERT kind=human-required message_ts=T1 thread_ts=T1`,
    );

    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const alerts = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alerts.map((a) => a.qitemId)).not.toContain("qitem-eligible-posted");

    const openAsks = await ports.listOpenAsks({ minimumLevel: "NOTICE" });
    const posted = openAsks.find((a) => a.item.qitemId === "qitem-eligible-posted");
    expect(posted).toBeDefined();
    expect(posted!.posted).toBe(true);
    expect(posted!.item.ownerNotificationKind).toBe("human-required");
  });

  it("fewer lookups: the noise backlog reaches zero per-row lookups; only eligible rows are read", async () => {
    seedNoise();
    seedOldestEligible("qitem-eligible-a");
    seedOldestEligible("qitem-eligible-b");

    const getById = vi.spyOn(repo, "getById");
    const notificationLookup = vi.spyOn(repo.transitionLog, "latestOwnerNotificationForQitem");

    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    await ports.listOpenAsks({ minimumLevel: "NOTICE" });

    // Two views × two eligible rows = four row reads; the 1100-row noise backlog
    // costs zero per-row lookups because eligibility was decided in SQL.
    expect(getById.mock.calls.length).toBeLessThanOrEqual(4);
    expect(notificationLookup).not.toHaveBeenCalled();
  });
});