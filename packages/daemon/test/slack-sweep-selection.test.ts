import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts, seedBacklogAsHistory } from "../src/domain/gateway/slack/queue-access.js";
import { SlackOutboundDriver } from "../src/domain/gateway/slack/outbound-driver.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";

const registry = { ok: true as const, entities: [{ entityId: "human-owner", class: "human" as const,
  displayName: "Owner", address: "human-owner@external", connectorBindings: [], prefs: {} }] };
const questions = [{ id: "continue", question: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }];

describe("Slack sweep selection", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let home: string;
  let serial: number;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-selection-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    serial = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(home, { recursive: true, force: true }); });
  const ports = () => makeQueuePorts(repo, { loadHumanRegistry: () => registry });
  function row(id: string, state = "pending", destination = "human-owner@external") {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, serial++)).toISOString();
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body,summary,tags,human_detail,reply_to,human_questions)
      VALUES (?, ?, ?, 'author@rig', ?, ?, ?, ?, '[]', 'full detail', 'prior', ?)`)
      .run(id, ts, ts, destination, state, `full body ${id}`, `summary ${id}`, JSON.stringify(questions));
  }
  function notify(id: string, level = "ALERT", kind = "human-required", archive = false) {
    const r = db.prepare(`INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,owner_notification_level,owner_notification_kind)
      VALUES (?, '2026-01-01T00:00:00Z', 'pending', 'human-owner@kernel', ?, ?)`).run(id, level, kind);
    const transitionId = Number(r.lastInsertRowid);
    if (archive) {
      db.prepare(`INSERT INTO queue_transitions_archive(transition_id,qitem_id,ts,state,actor_session,owner_notification_level,owner_notification_kind,archived_at)
        SELECT transition_id,qitem_id,ts,state,actor_session,owner_notification_level,owner_notification_kind,'2026-01-02' FROM queue_transitions WHERE transition_id=?`).run(transitionId);
      db.prepare("DELETE FROM queue_transitions WHERE transition_id=?").run(transitionId);
    }
    return `${id}:${transitionId}`;
  }
  function receipt(id: string, key: string, archive = false) {
    const table = archive ? "queue_transitions_archive" : "queue_transitions";
    db.prepare(`INSERT INTO ${table}(qitem_id,ts,state,actor_session,transition_note${archive ? ",archived_at" : ""})
      VALUES (?, '2026-01-02', 'pending', 'daemon@kernel', ?${archive ? ", '2026-01-03'" : ""})`)
      .run(id, `slack-owner-notification-posted notification_key=${key}`);
  }

  it("preserves routing, complete fields, levels, active states and creation ordering", async () => {
    row("direct"); const direct = notify("direct");
    row("alias", "in-progress", "human-owner@kernel"); notify("alias", "NOTICE");
    row("blocked", "blocked", "worker@rig"); notify("blocked");
    db.prepare("UPDATE queue_items SET blocked_on='human-owner@kernel' WHERE qitem_id='blocked'").run();
    row("resolved", "pending", "worker@rig"); notify("resolved", "NOTICE", "human-decision-resolved");
    row("ordinary"); row("nonhuman", "pending", "worker@rig"); notify("nonhuman");
    row("record"); notify("record", "RECORD");
    for (const state of ["done", "failed", "handed-off", "denied", "canceled"]) { row(state, state); notify(state); }
    const selected = await ports().listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(selected.map(q => q.qitemId)).toEqual(["resolved", "blocked", "alias", "direct"]);
    expect(selected.find(q => q.qitemId === "direct")).toEqual({ qitemId: "direct", destinationSession: "human-owner@external",
      sourceSession: "author@rig", tags: [], state: "pending", tier: null, humanIntent: null, humanDetail: "full detail",
      replyTo: "prior", humanQuestions: questions, summary: "summary direct", body: "full body direct", evidenceRef: null,
      notificationKey: direct, ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    expect(selected.slice(0, 2).map(q => q.sourceSession)).toEqual(["worker@rig", "worker@rig"]);
    expect((await ports().listHumanAlerts({ minimumLevel: "ALERT" })).map(q => q.qitemId)).toEqual(["blocked", "direct"]);
  });

  it("builds full views only after exact episode receipts and absent notifications are excluded", async () => {
    row("ordinary"); row("posted"); receipt("posted", notify("posted"));
    row("fresh"); const old = notify("fresh"); receipt("fresh", old); const current = notify("fresh");
    const full = vi.spyOn(repo, "waitingView"); const get = vi.spyOn(repo, "getById");
    const selected = await ports().listHumanAlerts({});
    expect(selected.map(q => q.notificationKey)).toEqual([current]);
    expect(full.mock.calls.map(([id]) => id)).toEqual(["fresh"]);
    expect(get.mock.calls.map(([id]) => id)).toEqual(["fresh"]);
  });

  it("honors archived owner transitions and exact receipts without hiding a newer episode", async () => {
    row("archived"); const first = notify("archived", "ALERT", "human-required", true);
    expect((await ports().listHumanAlerts({})).map(q => q.notificationKey)).toEqual([first]);
    receipt("archived", first, true);
    expect(await ports().listHumanAlerts({})).toEqual([]);
    const newer = notify("archived");
    expect((await ports().listHumanAlerts({})).map(q => q.notificationKey)).toEqual([newer]);
  });

  it("keeps a legacy schema without owner classification quiet", async () => {
    row("legacy");
    for (const table of ["queue_transitions", "queue_transitions_archive"]) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN owner_notification_level; ALTER TABLE ${table} DROP COLUMN owner_notification_kind`);
    }
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    expect(await ports().listHumanAlerts({})).toEqual([]);
  });

  it.each(["missing", "inactive"])("never returns a %s survivor", async (mode) => {
    row("changed"); notify("changed");
    const get = repo.getById.bind(repo);
    vi.spyOn(repo, "getById").mockImplementation(id => mode === "missing" ? null : { ...get(id)!, state: "done" });
    expect(await ports().listHumanAlerts({})).toEqual([]);
  });

  it.each(["selection", "transition", "receipt", "row"])("propagates a thrown %s read instead of returning empty success", async (where) => {
    row("unreadable"); notify("unreadable");
    const fail = () => { throw new Error("fixture read unavailable"); };
    if (where === "selection") vi.spyOn(db, "prepare").mockImplementation(fail);
    if (where === "transition") vi.spyOn(repo.transitionLog, "latestOwnerNotificationForQitem").mockImplementation(fail);
    if (where === "receipt") vi.spyOn(repo.transitionLog, "hasOwnerNotificationReceipt").mockImplementation(fail);
    if (where === "row") vi.spyOn(repo, "getById").mockImplementation(fail);
    await expect(ports().listHumanAlerts({})).rejects.toThrow("fixture read unavailable");
  });

  it("retains registry failure behavior without reading queue rows", async () => {
    const read = vi.spyOn(db, "prepare");
    expect(await makeQueuePorts(repo, { loadHumanRegistry: () => ({ ok: false, error: "fixture registry unavailable" }) }).listHumanAlerts({})).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("enable seeds selected episodes; an old seen key does not hide a newer episode", async () => {
    row("seed"); const first = notify("seed");
    const seen = new SeenStore(join(home, "seen")); const dispatch = vi.fn((..._args: unknown[]) => ({ ok: true as const, decisionId: "d" }));
    expect((await seedBacklogAsHistory({ queue: ports(), seen, filter: {} })).seeded).toBe(1);
    const driver = new SlackOutboundDriver({ home, queue: ports(), seen, filter: {}, dispatch });
    expect((await driver.sweepOnce()).dispatched).toEqual([]);
    const second = notify("seed");
    expect((await driver.sweepOnce()).dispatched).toEqual(["seed"]);
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({ notificationKey: second });
    expect(seen.load().has(first)).toBe(true); expect(seen.load().has(second)).toBe(false);
    expect((await driver.sweepOnce()).dispatched).toEqual([]);
  });

  it("dispatch refusal retries, while pending-buffer reconstruction suppresses a duplicate dispatch", async () => {
    row("retry"); const key = notify("retry");
    const seen = new SeenStore(join(home, "seen"));
    const dispatch = vi.fn(() => ({ ok: false as const, error: "fixture refusal" }));
    const driver = new SlackOutboundDriver({ home, queue: ports(), seen, filter: {}, dispatch });
    expect((await driver.sweepOnce()).refused).toHaveLength(1);
    expect((await driver.sweepOnce()).refused).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(2); expect(seen.load().size).toBe(0);
    const [alert] = await ports().listHumanAlerts({});
    new DispatchBuffer(home).enqueue({ kind: "outbound_decision", decisionId: "pending", op: "post_message", entityBindingRef: "human-owner@external", payload: alert });
    const next = new SlackOutboundDriver({ home, queue: ports(), seen, filter: {}, dispatch, intervalMs: 60000 });
    next.start();
    try { expect((await next.sweepOnce()).dispatched).toEqual([]); expect(dispatch).toHaveBeenCalledTimes(2); }
    finally { next.stop(); }
    expect(repo.transitionLog.hasOwnerNotificationReceipt("retry", key)).toBe(false);
  });
});
