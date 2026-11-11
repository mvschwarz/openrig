// #2829 slice 1 — the queue-side wiring: a wake send that provably cannot land
// (unroutable destination, or a failed send re-classified by the same positive
// no-receiver rule) fires the cold-start notifier, and the notifier can never
// change the send's own outcome. This is the seam the daemon wires to
// SeatColdStarter; the starter's own gates are covered in seat-cold-start.test.ts.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

const SEED = `INSERT INTO rigs(id,name) VALUES ('r0','home');
  INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('n0','r0','dev.peer','pi');
  INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b0','n0','dev-peer@home','%0');
  INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s0','n0','dev-peer@home','running');`;

function repo(notifier: (destination: string) => void): { repo: QueueRepository; notified: string[]; db: Database.Database } {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  // Topology presence matters: hasTerminalTransport fail-opens on an empty DB, so
  // seed one unrelated live seat to make the unknown destinations honestly unroutable.
  db.exec(SEED);
  const queue = new QueueRepository(db, new EventBus(db), {});
  queue.attachTransport({} as never); // the unroutable classification never reaches the transport
  const notified: string[] = [];
  queue.attachWakeWithoutReceiverNotifier(destination => { notified.push(destination); notifier(destination); });
  return { repo: queue, notified, db };
}

describe("queue → cold-start notifier wiring (#2829 slice 1)", () => {
  it("a wake to an unroutable destination fires the notifier", async () => {
    const f = repo(() => {});
    await f.repo.maybeNudge("q-missing", "dev.impl@no-such-rig", undefined);
    expect(f.notified).toEqual(["dev.impl@no-such-rig"]);
    f.db.close();
  });

  it("fires once per unroutable send", async () => {
    const f = repo(() => {});
    await f.repo.maybeNudge("q-missing", "dev.impl@no-such-rig", undefined);
    await f.repo.maybeNudge("q-missing", "other@no-such-rig", undefined);
    expect(f.notified).toEqual(["dev.impl@no-such-rig", "other@no-such-rig"]);
    f.db.close();
  });

  it("a throwing notifier never breaks the send path", async () => {
    const f = repo(() => { throw new Error("notifier bug"); });
    await expect(f.repo.maybeNudge("q-missing", "dev.impl@no-such-rig", undefined)).resolves.toBeUndefined();
    expect(f.notified).toEqual(["dev.impl@no-such-rig"]);
    f.db.close();
  });
});
