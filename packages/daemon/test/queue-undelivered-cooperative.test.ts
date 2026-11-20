// The stuck sweep reads its undelivered candidates as ids, in yielding windows on a file database, and derives each row
// by id between its own yields. The rows it finds, their order and their delivery outcomes are findUndelivered's; a
// request keeps moving during a long candidate read; and a row that changes while the read yields is judged as it is now.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

const FOUNDER = { entityId: "human-founder", class: "human", displayName: "F", address: "human-founder@external",
  connectorBindings: [{ connector: "slack", ref: "U0F", primary: true }], prefs: {} } as unknown as HumanFragment;

/** Counts the event loop's turns while something runs. */
function ticker() {
  let ticks = 0; let done = false;
  const spin = () => { if (done) return; ticks++; setImmediate(spin); };
  setImmediate(spin);
  return { now: () => ticks, stop: () => { done = true; } };
}

describe.each(["file", "memory"] as const)("the stuck sweep's undelivered candidates, on a %s database", (kind) => {
  let dir: string;
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "undelivered-"));
    db = kind === "file" ? new Database(join(dir, "openrig.sqlite")) : new Database(":memory:");
    if (kind === "file") db.pragma("journal_mode = WAL");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true,
      transport: { send: async () => ({ ok: true, verified: true }) }, loadHumanRegistry: () => ({ ok: true, entities: [FOUNDER] }) });
    repo.attachOutbox(new OutboxHandler(db));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000).toISOString();
  /** A pending row whose create-path wake failed ten minutes ago: a legacy undelivered row. */
  const insertFailed = (db0: Database.Database) => (id: string, destination = "worker@r", state = "pending", result = "failed: tmux send failed") => db0.prepare(
    `INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,last_nudge_attempt,last_nudge_result)
     VALUES (?, ?, ?, 'sender@r', ?, ?, '[]', 'body', ?, ?)`).run(id, tenMinutesAgo(), tenMinutesAgo(), destination, state, tenMinutesAgo(), result);
  const receipt = (id: string, outcome: "posted" | "transport-failed") => repo.update({ qitemId: id, actorSession: "daemon@kernel",
    transitionNote: `slack-owner-notification-${outcome} notification_key=${id}:${repo.transitionLog.latestOwnerNotificationForQitem(id)!.transitionId} level=ALERT${outcome === "posted" ? " message_ts=1.2" : " detail=http-500"}` });
  const ask = async () => (await repo.create({ sourceSession: "lead@rig", destinationSession: "human-founder@external", body: "b", summary: "s",
    priority: "routine", humanIntent: "decision", humanAlert: true } as never) as unknown as { qitemId: string }).qitemId;

  /** Every class the derivation tells apart: a posted receipt, a transport failure, an episode with no receipt yet,
   *  legacy failed and unroutable wakes, a gateway-owned wake, closed rows and another rig's rows. */
  async function seed(): Promise<void> {
    const add = insertFailed(db);
    receipt(await ask(), "posted");
    receipt(await ask(), "transport-failed");
    await ask();
    add("qitem-legacy-failed");
    add("qitem-legacy-unroutable", "worker@r", "pending", "unroutable: no pane");
    add("qitem-gateway-owned", "worker@r", "pending", "gateway-owned: slack");
    add("qitem-closed-failed", "worker@r", "done");
    add("qitem-other-rig", "worker@other");
    add("qitem-other-rig-blocked", "worker@other", "blocked");
  }
  const outcomes = (rows: Array<{ qitemId: string; deliveryOutcome?: string }>) => rows.map((r) => [r.qitemId, r.deliveryOutcome ?? null]);

  it("derives findUndelivered's rows, in its order and with its outcomes, from the ids alone", async () => {
    await seed();
    for (const opts of [{}, { rig: "other" }]) {
      const ids = await repo.undeliveredCandidateIds(opts);
      const derived = ids.flatMap((id) => repo.findUndelivered({ qitemId: id, waiting: false }));
      expect(outcomes(derived)).toEqual(outcomes(repo.findUndelivered({ ...opts, waiting: false })));
    }
    expect(outcomes(repo.findUndelivered({ waiting: false })).length).toBeGreaterThan(2);
    // A legacy failed wake is a candidate only on a pending row, as in findUndelivered's filter: the blocked one isn't.
    expect(await repo.undeliveredCandidateIds({ rig: "other" })).toEqual(["qitem-other-rig"]);
  });

  it("finds every candidate of a long set, and on a file database lets other work run while it reads", async () => {
    const add = insertFailed(db);
    db.transaction(() => { for (let i = 0; i < 2_000; i++) add(`qitem-many-${String(i).padStart(4, "0")}`); })();
    const clock = ticker();
    let ids: string[] = [];
    let ticks = 0;
    try {
      ids = await repo.undeliveredCandidateIds();
      ticks = clock.now();
    } finally { clock.stop(); }
    expect(ids).toHaveLength(2_000);
    expect(new Set(ids).size).toBe(2_000);
    // The read takes 2,000 rowids in windows of 256 and yields between them on a WAL file; in memory it stays one read.
    if (kind === "file") expect(ticks).toBeGreaterThan(0);
    else expect(ticks).toBe(0);
  });

  it("judges a row that is closed while the read yields as it is now, and finds the rest", async () => {
    const add = insertFailed(db);
    db.transaction(() => { for (let i = 0; i < 600; i++) add(`qitem-row-${String(i).padStart(4, "0")}`); })();
    const target = "qitem-row-0599";
    const close = () => db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'no-follow-on' WHERE qitem_id = ?").run(target);
    // The row's owner closes it once, at a point the test controls: on a file database at the candidate read's first
    // yield between windows (600 rows are three windows of 256); in memory, where the read doesn't yield, right after it.
    // Either way the read's snapshot still lists the row as pending, and the sweep hasn't derived any row yet.
    const read = repo.undeliveredCandidateIds.bind(repo);
    let closedAt: "read-yield" | "after-read" | undefined;
    let listed: boolean | undefined;
    vi.spyOn(repo, "undeliveredCandidateIds").mockImplementation(async (opts) => {
      const atYield = setImmediate(() => { closedAt ??= "read-yield"; close(); });
      const ids = await read(opts);
      if (!closedAt) { clearImmediate(atYield); closedAt = "after-read"; close(); }
      listed = ids.includes(target);
      return ids;
    });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => "orch@r" });
    expect(closedAt).toBe(kind === "file" ? "read-yield" : "after-read");
    expect(listed).toBe(true);
    const found = new Set(result.findings.filter((f) => f.kind === "undelivered-wake").map((f) => f.qitemId));
    expect(found.has(target)).toBe(false);
    expect(found.size).toBe(599);
  });
});
