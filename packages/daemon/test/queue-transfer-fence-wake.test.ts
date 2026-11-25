// A relinquished (fenced) source row has moved to the destination: its fence stops every dispatch
// path, not only the durable wake-intent drain. `retryUnroutableWakesOnReachable` retries an
// unroutable wake once the seat is reachable; on the legacy (no intent store) path that retry goes
// through `maybeNudge` → `transport.send`, which used to ignore the fence and wake a fenced row.
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

let db: Database.Database;
let repo: QueueRepository;
const sent: string[] = [];

beforeEach(() => {
  sent.length = 0;
  db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('fixture-rig','r');
    INSERT INTO nodes(id,rig_id,logical_id,runtime,profile) VALUES
      ('late-node','fixture-rig','late','codex','none'),
      ('other-node','fixture-rig','other','codex','none');
    INSERT INTO bindings(id,node_id,tmux_session) VALUES
      ('late-binding','late-node','late@r'),
      ('other-binding','other-node','other@r');`);
  // Legacy topology: a transport but no wake-intent store, so an unroutable retry takes `maybeNudge`.
  repo = new QueueRepository(db, new EventBus(db), {
    validateRig: () => true,
    loadHumanRegistry: () => ({ ok: true, entities: [] }),
    transport: { send: async (destination) => { sent.push(destination); return { ok: true, verified: true }; } },
  });
});
afterEach(() => { db.close(); });

function fence(qitemId: string): void {
  db.prepare(`INSERT INTO queue_transfer_ledger (record_id, side, kind, transfer_id, archive_digest, origin_host_id,
    origin_minted_at, destination_host_id, authorization_digest, mapping_digest, actor, recorded_at)
    VALUES (?, 'origin', 'relinquished', 'xfer-1', 'digest', 'origin', 'minted', 'target', 'auth', 'map', 'operator', '1')`)
    .run(`rel-${qitemId}`);
  db.prepare(`INSERT INTO queue_transfer_relinquished (qitem_id, record_id, archive_digest, destination_host_id, source_state)
    VALUES (?, ?, 'digest', 'target', 'pending')`).run(qitemId, `rel-${qitemId}`);
}

async function pendingUnroutable(destination: string): Promise<string> {
  const row = await repo.create({ sourceSession: "sender@r", destinationSession: destination, body: "work", nudge: false });
  db.prepare("UPDATE queue_items SET last_nudge_result = 'unroutable:no-pane' WHERE qitem_id = ?").run(row.qitemId);
  return row.qitemId;
}

it("does not wake a fenced row whose unroutable seat becomes reachable, while an unfenced row still does", async () => {
  const fenced = await pendingUnroutable("late@r");
  const alive = await pendingUnroutable("other@r");
  fence(fenced);

  await repo.retryUnroutableWakesOnReachable("late@r", "idle");
  await repo.retryUnroutableWakesOnReachable("other@r", "idle");

  expect(sent).toEqual(["other@r"]);
  expect(repo.getById(fenced)!.lastNudgeResult).toBe("unroutable:no-pane");
  expect(repo.getById(alive)!.lastNudgeResult).not.toMatch(/^unroutable:/);
});
