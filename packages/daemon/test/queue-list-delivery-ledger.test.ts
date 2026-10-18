// The queue listing derives every row's delivery ledger in a few batched reads. Each seeded shape's outcome is pinned
// (the per-row derivation this batching replaced gave the same), and a row's ledger in a listing is the one it has on
// its own (deliveryOutcomeFor, the batch of one that show and the sweeps read), byte for byte.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";

const FOUNDER = { entityId: "human-founder", class: "human", displayName: "F", address: "human-founder@external",
  connectorBindings: [{ connector: "slack", ref: "U0F", primary: true }], prefs: {} } as unknown as HumanFragment;

type Outcome = "posted" | "transport-failed" | "never-posted" | null;

describe("queue list: delivery ledgers", () => {
  let db: ReturnType<typeof createDb>, repo: QueueRepository, loadRegistry: ReturnType<typeof vi.fn<() => LoadResult>>;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    loadRegistry = vi.fn(() => ({ ok: true as const, entities: [FOUNDER] }));
    repo = new QueueRepository(db, new EventBus(db), { transport: { send: async () => ({ ok: true, verified: true }) }, loadHumanRegistry: loadRegistry });
    repo.attachOutbox(new OutboxHandler(db));
  });

  const latestKey = (id: string) => `${id}:${repo.transitionLog.latestOwnerNotificationForQitem(id)!.transitionId}`;
  const receipt = (id: string, kind: "posted" | "transport-failed", key = latestKey(id)) => repo.update({ qitemId: id, actorSession: "daemon@kernel",
    transitionNote: `slack-owner-notification-${kind} notification_key=${key} level=ALERT${kind === "posted" ? " message_ts=1.2" : " detail=http-500"}` });
  async function create(destinationSession: string, extra: Record<string, unknown> = {}): Promise<string> {
    const item = await repo.create({ sourceSession: "lead@rig", destinationSession, body: "b", summary: "s", priority: "routine",
      ...extra } as never);
    return (item as unknown as { qitemId: string }).qitemId;
  }
  const closeByHuman = (id: string) => repo.update({ qitemId: id, actorSession: "human-founder@external", state: "done", closureReason: "no-follow-on",
    transitionNote: "direct human reply received", ownerNotificationKind: "human-decision-resolved" } as never);
  const ARCHIVE_COLUMNS = "transition_id, qitem_id, ts, state, transition_note, actor_session, owner_notification_kind, owner_notification_level";
  /** Moves one transition to the archive table, as retention does a closed row's. */
  function archive(transitionId: number): void {
    db.prepare(`INSERT INTO queue_transitions_archive (${ARCHIVE_COLUMNS}, archived_at) SELECT ${ARCHIVE_COLUMNS}, ts FROM queue_transitions WHERE transition_id = ?`).run(transitionId);
    db.prepare("DELETE FROM queue_transitions WHERE transition_id = ?").run(transitionId);
  }

  /** Every ledger the derivation knows, each row with its outcome when the human registry loads and when it fails:
   *  posted, transport-failed, never-posted, a closed row's resolved notice, a row parked on the human, legacy
   *  gateway-owned nudges, a receipt of an earlier episode, owner notices in the archive table, ids JSON and LIKE treat
   *  specially, rows inside the post window, and rows with no ledger. */
  async function seed(): Promise<Array<{ id: string; ok: Outcome; failed: Outcome }>> {
    const rows: Array<{ id: string; ok: Outcome; failed: Outcome }> = [];
    const add = (id: string, ok: Outcome, failed: Outcome = null) => rows.push({ id, ok, failed });
    for (let i = 0; i < 2; i++) {
      const posted = await create("human-founder@external", { humanIntent: "decision" });
      receipt(posted, "posted");
      add(posted, "posted");
      const failed = await create("human-founder@external", { humanIntent: "decision" });
      receipt(failed, "transport-failed");
      add(failed, "transport-failed");
      add(await create("human-founder@external", { humanIntent: "decision" }), "never-posted");
      const closed = await create("human-founder@external", { humanIntent: "decision" });
      receipt(closed, "posted");
      closeByHuman(closed);
      add(closed, "posted");
      const unposted = await create("human-founder@external", { humanIntent: "decision" });
      closeByHuman(unposted);
      add(unposted, "never-posted");
      const parked = await create("dev@rig");
      repo.update({ qitemId: parked, actorSession: "dev@rig", state: "blocked", blockedOn: "human-founder@external", transitionNote: "needs the owner" } as never);
      receipt(parked, "posted", `${parked}:0`);
      add(parked, "never-posted");
      const legacy = await create("dev@rig");
      repo.recordNudgeAttempt(legacy, "gateway-owned: slack");
      receipt(legacy, "transport-failed", "none");
      add(legacy, "transport-failed", "transport-failed");
      // No owner history and no receipt: only last_nudge_result (a compact column) makes it never-posted. Created
      // without its wake, which would overwrite that result.
      const legacyUnposted = await create("dev@rig", { nudge: false });
      repo.recordNudgeAttempt(legacyUnposted, "gateway-owned: slack");
      add(legacyUnposted, "never-posted", "never-posted");
      add(await create("dev@rig"), null);
      // A closed row whose posted ask lives in the archive table: the resolved notice falls back to it.
      const archivedAsk = await create("human-founder@external", { humanIntent: "decision" });
      const ask = repo.transitionLog.latestOwnerNotificationForQitem(archivedAsk)!.transitionId;
      receipt(archivedAsk, "posted");
      closeByHuman(archivedAsk);
      archive(ask);
      add(archivedAsk, "posted");
      // A newer ask in the archive table than the live receipt's: the receipt is an earlier episode's.
      const archivedLatest = await create("human-founder@external", { humanIntent: "decision" });
      receipt(archivedLatest, "posted");
      const asksAgain = db.prepare(`INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session, owner_notification_kind, owner_notification_level)
        VALUES (?, ?, 'pending', 'asks again', 'lead@rig', 'human-required', 'ALERT')`).run(archivedLatest, new Date().toISOString());
      archive(Number(asksAgain.lastInsertRowid));
      add(archivedLatest, "never-posted");
      for (const odd of [`q%${i}`, `q_${i}`, `q\\${i}`, `q"${i}`]) {
        await create("human-founder@external", { qitemId: odd, humanIntent: "decision" });
        receipt(odd, i === 0 ? "posted" : "transport-failed");
        add(odd, i === 0 ? "posted" : "transport-failed");
      }
    }
    for (const table of ["queue_transitions", "queue_transitions_archive"]) db.prepare(`UPDATE ${table} SET ts = datetime('now', '-1 hour')`).run();
    db.prepare("UPDATE queue_items SET ts_created = datetime('now', '-1 hour')").run();
    // Inside the post window: no verdict yet.
    add(await create("human-founder@external", { humanIntent: "decision" }), null);
    const legacyFresh = await create("dev@rig", { nudge: false });
    repo.recordNudgeAttempt(legacyFresh, "gateway-owned: slack");
    add(legacyFresh, null);
    return rows;
  }

  /** The listing as each row's own ledger builds it: each item's own fields, then its ledger's. */
  function perRow<T extends { qitemId: string; deliveryOutcome?: unknown; deliveryFailureDetail?: unknown }>(from: QueueRepository, items: T[]): unknown[] {
    return items.map(({ deliveryOutcome: _outcome, deliveryFailureDetail: _detail, ...item }) => {
      const ledger = from.deliveryOutcomeFor(item.qitemId);
      return { ...item, deliveryOutcome: ledger?.outcome ?? null, ...(ledger && ledger.outcome !== "posted" ? { deliveryFailureDetail: ledger.detail } : {}) };
    });
  }

  it("gives each seeded shape its outcome, and each row the ledger it has on its own, byte for byte", async () => {
    const rows = await seed();
    const items = repo.list({ limit: 1000 });
    expect(items).toHaveLength(rows.length);
    const outcomes = new Map(items.map((item) => [item.qitemId, item.deliveryOutcome]));
    expect(rows.map((row) => [row.id, outcomes.get(row.id)])).toEqual(rows.map((row) => [row.id, row.ok]));
    expect(JSON.stringify(items)).toBe(JSON.stringify(perRow(repo, items)));
    const compact = repo.list({ limit: 1000, compact: true });
    expect(compact.map((item) => [item.qitemId, item.deliveryOutcome, (item as { deliveryFailureDetail?: string }).deliveryFailureDetail]))
      .toEqual(items.map((item) => [item.qitemId, item.deliveryOutcome, item.deliveryFailureDetail]));
  });

  it("gives no human episode a verdict when the human registry fails to load", async () => {
    const rows = await seed();
    const failing = new QueueRepository(db, new EventBus(db), { transport: { send: async () => ({ ok: true, verified: true }) },
      loadHumanRegistry: () => ({ ok: false, error: "unreadable" }) as unknown as LoadResult });
    const items = failing.list({ limit: 1000 });
    const outcomes = new Map(items.map((item) => [item.qitemId, item.deliveryOutcome]));
    expect(rows.map((row) => [row.id, outcomes.get(row.id)])).toEqual(rows.map((row) => [row.id, row.failed]));
    expect(JSON.stringify(items)).toBe(JSON.stringify(perRow(failing, items)));
  });

  it.each([true, false])("reads the ledgers of a whole listing with statements prepared once, and the human registry once (compact: %s)", async (compact) => {
    await seed();
    repo.list({ limit: 1000, compact });
    const prepare = vi.spyOn(db, "prepare");
    loadRegistry.mockClear();
    // A full row's waiting view asks, for a pending row, whether its ask was posted to its human: from the listing's reads.
    const items = repo.list({ limit: 1000, compact });
    expect(items.some((item) => item.state === "pending" && item.deliveryOutcome === "posted")).toBe(true);
    expect(prepare.mock.calls.filter(([sql]) => /slack-owner-notification|owner_notification_level IS NOT NULL/.test(sql))).toEqual([]);
    expect(loadRegistry).toHaveBeenCalledTimes(1);
    prepare.mockRestore();
  });

  it("reads a row's latest owner notification and its latest outbound one, not its whole history", async () => {
    const id = await create("human-founder@external", { humanIntent: "decision" });
    const insert = db.prepare(`INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session, owner_notification_kind, owner_notification_level)
      VALUES (?, ?, 'pending', ?, 'lead@rig', ?, 'ALERT')`);
    for (let n = 0; n < 6; n++) insert.run(id, new Date().toISOString(), `notice ${n}`, n % 2 ? "human-decision-resolved" : "human-required");
    const owners = repo.transitionLog.ownerNotificationsForQitems([id]).get(id)!;
    expect(owners.map((t) => t.transitionNote)).toEqual(["notice 5", "notice 4"]);
    expect(owners[0]).toEqual(repo.transitionLog.latestOwnerNotificationForQitem(id));
  });

  describe("a single row, with a receipt committed while the human registry loads", () => {
    /** A pending ask to the human, past its post window, with no receipt yet: the next registry load commits its
     *  posted receipt, as a second connection could while the ledger works out its episode. */
    async function askPostedDuringRegistryLoad(): Promise<string> {
      const id = await create("human-founder@external", { humanIntent: "decision" });
      db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-1 hour') WHERE qitem_id = ?").run(id);
      db.prepare("UPDATE queue_items SET ts_created = datetime('now', '-1 hour') WHERE qitem_id = ?").run(id);
      const key = latestKey(id);
      loadRegistry.mockImplementationOnce(() => {
        db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session) VALUES (?, ?, 'pending', ?, 'daemon@kernel')")
          .run(id, new Date().toISOString(), `slack-owner-notification-posted notification_key=${key} level=ALERT message_ts=1.2`);
        return { ok: true as const, entities: [FOUNDER] };
      });
      return id;
    }

    it("reads the receipt in its ledger", async () => {
      const id = await askPostedDuringRegistryLoad();
      expect(repo.deliveryOutcomeFor(id)?.outcome).toBe("posted");
    });

    it("finds its ask posted to its human", async () => {
      expect(repo.humanNotificationPostedThisEpisode(await askPostedDuringRegistryLoad())).toBe(true);
    });

    it("names no unclaimed sweep in its waiting view, alone or shown", async () => {
      const awaiting = "none (posted to the human; awaiting their decision)";
      expect(repo.waitingView(await askPostedDuringRegistryLoad())?.nextBackstop?.mechanism).toBe(awaiting);
      const shown = repo.getById(await askPostedDuringRegistryLoad());
      expect(shown?.waiting?.nextBackstop?.mechanism).toBe(awaiting);
      expect(shown?.deliveryOutcome).toBe("posted");
    });

    it("is not listed undelivered", async () => {
      const id = await askPostedDuringRegistryLoad();
      expect(repo.findUndelivered({ compact: true }).map((item) => item.qitemId)).not.toContain(id);
    });
  });

  it("tells a full row's waiting view its ask was posted to its human, as the row alone does", async () => {
    await seed();
    const listed = repo.list({ limit: 1000 }).filter((item) => item.state === "pending");
    const awaiting = listed.filter((item) => item.waiting?.nextBackstop?.mechanism.startsWith("none (posted to the human"));
    expect(awaiting.length).toBeGreaterThan(0);
    expect(listed.map((item) => item.waiting)).toEqual(listed.map((item) => repo.waitingView(item.qitemId)));
  });
});
