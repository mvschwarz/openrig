import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { filterHumanAlerts, makeQueuePorts, type QueueItem } from "../src/domain/gateway/slack/queue-access.js";
import { SlackOutboundDriver } from "../src/domain/gateway/slack/outbound-driver.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/domain/gateway/slack/config.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";

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

  it("defines one ordered OWNER vocabulary, archive parity, and the ordinary/direct-human matrix", async () => {
    expect(levels()).toEqual(["RECORD", "NOTICE", "ALERT"]);
    expect(ALL_MIGRATIONS.at(-1)?.name).toBe("076_owner_notification_levels.sql");
    for (const table of ["queue_transitions", "queue_transitions_archive"]) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(columns).toContain("owner_notification_kind");
      expect(columns).toContain("owner_notification_level");
    }

    const ordinary = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "ordinary", nudge: false });
    expect(db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(ordinary.qitemId)).toEqual({ owner_notification_kind: null, owner_notification_level: null });

    const direct = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@kernel",
      body: "direct decision",
      summary: "Direct founder decision",
      evidenceRef: "/proof/direct.md",
      nudge: false,
    });
    expect(db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(direct.qitemId)).toEqual({ owner_notification_kind: "human-required", owner_notification_level: "ALERT" });

    const handed = await repo.handoff({
      qitemId: ordinary.qitemId,
      fromSession: "b@rig",
      toSession: "human-founder@kernel",
      body: "handoff decision",
      summary: "Handoff founder decision",
      evidenceRef: "/proof/handoff.md",
      nudge: false,
    });
    expect(db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(handed.created.qitemId)).toEqual({ owner_notification_kind: "human-required", owner_notification_level: "ALERT" });
  });

  it("defaults to posting NOTICE and interrupting ALERT, refuses an unknown level, and has no tag classifier", () => {
    const cfg = loadConfig(home) as Record<string, unknown>;
    expect(cfg.minimumLevelThatPosts).toBe("NOTICE");
    expect(cfg.minimumLevelThatInterrupts).toBe("ALERT");
    expect(DEFAULT_CONFIG).not.toHaveProperty("alertTag");
    writeFileSync(join(home, "slack-connector.json"), JSON.stringify({ ...DEFAULT_CONFIG, alertTag: "founder-alert" }));
    expect(loadConfig(home)).not.toHaveProperty("alertTag");
    expect(filterHumanAlerts([{
      qitemId: "qitem-legacy-tag",
      destinationSession: "human-founder@external",
      tags: ["founder-alert"],
      state: "pending",
    }], { alertTag: "founder-alert", minimumLevel: "NOTICE" } as never)).toEqual([]);
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
    const first = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
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
    const unchanged = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(unchanged[0]!.notificationKey).toBe(first[0]!.notificationKey);
    const quiet = new SlackOutboundDriver({
      home,
      queue: { async listHumanAlerts() { return unchanged; } },
      seen,
      filter: { minimumLevel: "NOTICE" },
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
    const reparks = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(reparks[0]!.notificationKey).not.toBe(first[0]!.notificationKey);
    const next = new SlackOutboundDriver({
      home,
      queue: { async listHumanAlerts() { return reparks; } },
      seen,
      filter: { minimumLevel: "NOTICE" },
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
    const notices = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(notices).toEqual([
      expect.objectContaining({
        qitemId: row.qitemId,
        destinationSession: "human-founder@external",
        sourceSession: "orch-lead@v-openrig-build",
        ownerNotificationLevel: "NOTICE",
      }),
    ] satisfies QueueItem[]);
  });

  it("writes a same-row receipt for root and threaded posts; ALERT interrupts while NOTICE stays quiet", async () => {
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
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();

    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    const posts: Array<Record<string, unknown>> = [];
    const wire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: `1724.000${posts.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      wire.startServices?.();
      expect(wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(JSON.stringify(posts[0])).toContain("<@UFOUNDER>");
      expect(await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).toEqual([]);

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
      const [notice] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
      expect(notice?.ownerNotificationLevel).toBe("NOTICE");
      expect(wire.dispatcher.dispatch(OUTBOUND_OP, notice!.destinationSession!, notice)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(JSON.stringify(posts[1])).not.toContain("<@UFOUNDER>");
      expect(await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).toEqual([]);

      const receipts = repo.listTransitions(row.qitemId).filter((transition) =>
        transition.transitionNote?.startsWith("slack-owner-notification-posted "),
      );
      expect(receipts).toHaveLength(2);
      expect(receipts[0]!.transitionNote).toContain(`notification_key=${alert!.notificationKey}`);
      expect(receipts[1]!.transitionNote).toContain(`notification_key=${notice!.notificationKey}`);
    } finally {
      wire.stop();
    }
  });

  it("retains and replays an ok response without a message timestamp before writing the row receipt", async () => {
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
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();

    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    let postCalls = 0;
    const fetchImpl = async (url: string | URL) => {
      if (String(url).includes("conversations.history")) {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      postCalls++;
      return new Response(JSON.stringify(postCalls === 1 ? { ok: true } : { ok: true, ts: "1724.9002" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const firstWire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl,
    });
    try {
      expect(firstWire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(postCalls).toBe(1);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);
      expect(repo.listTransitions(row.qitemId).filter((transition) =>
        transition.transitionNote?.startsWith("slack-owner-notification-posted "),
      )).toEqual([]);
    } finally {
      firstWire.stop();
    }

    const replayWire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl,
    });
    try {
      replayWire.startServices?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(postCalls).toBe(2);
      expect(new DispatchBuffer(home).pending()).toEqual([]);
      expect(repo.listTransitions(row.qitemId).filter((transition) =>
        transition.transitionNote?.startsWith("slack-owner-notification-posted "),
      )).toHaveLength(1);
    } finally {
      replayWire.stop();
    }
  });
});
