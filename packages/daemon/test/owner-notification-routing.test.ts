import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import * as transitionModule from "../src/domain/queue-transition-log.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { makeQueuePorts, type QueueItem } from "../src/domain/gateway/slack/queue-access.js";
import { SlackOutboundDriver } from "../src/domain/gateway/slack/outbound-driver.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/domain/gateway/slack/config.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";

const registry = {
  ok: true as const,
  entities: [{
    entityId: "human-founder",
    class: "human" as const,
    displayName: "Founder",
    address: "human-founder@external",
    connectorBindings: [{
      kind: "slack" as const,
      connectorRef: "primary",
      secretsRef: "env:SLACK_BOT_TOKEN",
      role: "primary" as const,
      handle: "UFOUNDER",
    }],
    prefs: { deliveryClass: "B" as const },
  }],
};

function ensureFinalColumns(db: Database.Database): void {
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
    if (!names.has("owner_notification_kind")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_kind TEXT`);
    if (!names.has("owner_notification_level")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_level TEXT`);
  }
}

function levels(): readonly string[] | undefined {
  return (transitionModule as unknown as { OWNER_NOTIFICATION_LEVELS?: readonly string[] }).OWNER_NOTIFICATION_LEVELS;
}

describe("S14 owner notifications — system notices, not remembered tags", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db); // final test bytes can run against the pristine pre-076 base
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry } as never);
    home = mkdtempSync(join(tmpdir(), "s14-owner-notify-"));
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("defines one ordered OWNER vocabulary and registers additive migration 076 with archive parity", () => {
    expect(levels()).toEqual(["RECORD", "NOTICE", "ALERT"]);
    expect(ALL_MIGRATIONS.at(-1)?.name).toBe("076_owner_notification_levels.sql");
    for (const table of ["queue_transitions", "queue_transitions_archive"]) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(columns).toContain("owner_notification_kind");
      expect(columns).toContain("owner_notification_level");
    }
  });

  it("defaults to posting NOTICE and interrupting ALERT, and refuses an unknown level", () => {
    const cfg = loadConfig(home) as Record<string, unknown>;
    expect(cfg.minimumLevelThatPosts).toBe("NOTICE");
    expect(cfg.minimumLevelThatInterrupts).toBe("ALERT");
    expect(() => saveConfig({ ...DEFAULT_CONFIG, minimumLevelThatPosts: "LOUD" } as never, home)).toThrow(/minimumLevelThatPosts.*RECORD.*NOTICE.*ALERT/i);
  });

  it("routes the live human-blocker shape once, resolves aliases, and returns replies to the row owner", async () => {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "two founder decisions remain",
      priority: "critical",
      tier: "deep",
      tags: ["founder-gated"],
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "Founder decision required",
      evidenceRef: "/proof/SPEC.md",
      transitionNote: "parked with exact continuation",
    });

    const parked = db.prepare(
      "SELECT transition_id, owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(row.qitemId) as Record<string, unknown>;
    expect(parked).toMatchObject({ owner_notification_kind: "human-required", owner_notification_level: "ALERT" });

    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const first = await ports.listHumanAlerts({ alertTag: "founder-alert", minimumLevel: "NOTICE" } as never);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      qitemId: row.qitemId,
      destinationSession: "human-founder@external",
      sourceSession: "orch-lead@v-openrig-build",
      ownerNotificationLevel: "ALERT",
    });
    expect(first[0]!.notificationKey).toContain(`${row.qitemId}:`);

    const seen = new SeenStore(join(home, "seen.jsonl"));
    seen.mark(first[0]!.notificationKey!, "posted");
    repo.update({ qitemId: row.qitemId, actorSession: "watchdog@system", transitionNote: "unchanged 15m park wake" });
    const unchanged = await ports.listHumanAlerts({ alertTag: "founder-alert", minimumLevel: "NOTICE" } as never);
    expect(unchanged[0]!.notificationKey).toBe(first[0]!.notificationKey);
    const quiet = new SlackOutboundDriver({
      home,
      queue: { async listHumanAlerts() { return unchanged; } },
      seen,
      filter: { alertTag: "founder-alert", minimumLevel: "NOTICE" } as never,
      dispatch: () => ({ ok: true, decision: {} as never }),
    });
    expect((await quiet.sweepOnce()).fresh).toBe(0);

    repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@v-openrig-build", state: "in-progress", transitionNote: "decision consumed" });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      transitionNote: "a distinct later founder decision",
    });
    const reparks = await ports.listHumanAlerts({ alertTag: "founder-alert", minimumLevel: "NOTICE" } as never);
    expect(reparks[0]!.notificationKey).not.toBe(first[0]!.notificationKey);
    const next = new SlackOutboundDriver({
      home,
      queue: { async listHumanAlerts() { return reparks; } },
      seen,
      filter: { alertTag: "founder-alert", minimumLevel: "NOTICE" } as never,
      dispatch: () => ({ ok: true, decision: {} as never }),
    });
    expect((await next.sweepOnce()).fresh).toBe(1);
  });

  it("classifies the dedicated queue resolve act as NOTICE without re-reading its prose", async () => {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "await decision",
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "Choose A or B",
      evidenceRef: "/proof/decision.md",
      transitionNote: "parked",
    });
    const contract = new MissionControlWriteContract({
      db,
      eventBus: bus,
      queueRepo: repo,
      actionLog: new MissionControlActionLog(db),
    });
    await contract.act({
      verb: "resolve",
      qitemId: row.qitemId,
      actorSession: "human-founder@kernel",
      decision: "Choose A",
      notify: false,
    });

    const resolved = db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(row.qitemId) as Record<string, unknown>;
    expect(resolved).toEqual({ owner_notification_kind: "human-decision-resolved", owner_notification_level: "NOTICE" });

    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const notices = await ports.listHumanAlerts({ alertTag: "founder-alert", minimumLevel: "NOTICE" } as never);
    expect(notices).toEqual([
      expect.objectContaining({
        qitemId: row.qitemId,
        destinationSession: "human-founder@external",
        sourceSession: "orch-lead@v-openrig-build",
        ownerNotificationLevel: "NOTICE",
      }),
    ] satisfies QueueItem[]);
  });
});
