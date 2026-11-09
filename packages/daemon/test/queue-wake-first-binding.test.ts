// #2789: a queue wake committed while its seat had no pane froze a guard binding that could never match once the seat
// was bound, so every re-send was refused as "Committed wake recipient identity changed". These run through the real
// SessionTransport and SeatDeliveryGuard, with only tmux itself stubbed: its commands are recorded, never run.
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

/** A seat whose node and first occupant exist but whose pane isn't bound yet, as just after a restart. */
function unboundSeat() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g1','a',1,'occupant-1','fresh');`);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const writes: string[] = [];
  // The pane shows what was pasted into it, so the transport can confirm a wake rendered.
  let pane = "";
  const tmux = new TmuxAdapter(async (command) => {
    const line = String(command); writes.push(line);
    const loaded = /load-buffer .* '([^']+)'$/.exec(line);
    if (loaded) pane += readFileSync(loaded[1]!, "utf8");
    return line.includes("capture-pane") ? pane : "";
  });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
  vi.spyOn(tmux, "listPanes").mockImplementation(async (name) => [{ id: guard.target(name).pane! } as never]);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), sleep: async () => {} });
  const outbox = new OutboxHandler(db);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  /** The seat comes back: a new occupant, and its pane bound. */
  const relaunch = (occupant = "occupant-2", ordinal = 2, pane = "%1") => db.exec(`
    INSERT OR IGNORE INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('${occupant}','a',${ordinal},'${occupant}','fresh');
    INSERT OR REPLACE INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','${pane}');
    INSERT OR IGNORE INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');`);
  const intentOf = (qitemId: string) => outbox.getById(`wake-intent-${qitemId}`)!;
  /** Each test has one item, so a paste into the pane is its wake being sent. */
  const sendsFor = (_qitemId: string) => writes.filter((w) => w.includes("paste-buffer")).length;
  /** An item created while the seat has no pane: its wake fails unroutable, with a pane-less binding frozen on its intent. */
  const createUnbound = async () => {
    const item = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work" });
    await vi.waitFor(() => expect(intentOf(item.qitemId).deliveryState).toBe("failed"));
    expect(repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^unroutable:/);
    expect(intentOf(item.qitemId).guardBinding).toEqual({ nodeId: "a", session: "worker@test", occupant: "occupant-1", pane: null });
    expect(writes).toEqual([]);
    return item;
  };
  return { db, guard, tmux, outbox, repo, writes, relaunch, intentOf, sendsFor, createUnbound };
}

describe("a wake committed before its seat had a pane (#2789)", () => {
  it("reaches the relaunched seat exactly once: its first binding is the live one, and later passes send nothing", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.relaunch();

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.sendsFor(item.qitemId)).toBe(1);
    expect(f.intentOf(item.qitemId).deliveryState).toBe("delivered");
    expect(f.intentOf(item.qitemId).guardBinding).toEqual({ nodeId: "a", session: "worker@test", occupant: "occupant-2", pane: "%1" });
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).not.toMatch(/identity changed|^unroutable:/);

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    await f.repo.drainPendingWakeIntents();
    expect(f.sendsFor(item.qitemId)).toBe(1);
    expect(f.intentOf(item.qitemId).deliveryState).toBe("delivered");
  });

  it("control: a wake bound to an earlier occupant's pane is still refused when the seat is relaunched", async () => {
    const f = unboundSeat();
    f.relaunch("occupant-1", 1, "%1"); // bound from the start
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const bound = f.intentOf(item.qitemId).guardBinding;
    expect(bound).toMatchObject({ occupant: "occupant-1", pane: "%1" });
    f.relaunch("occupant-2", 2, "%2");

    await f.repo.drainPendingWakeIntents();
    expect(f.intentOf(item.qitemId).deliveryState).toBe("failed");
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toContain("identity changed");
    expect(f.intentOf(item.qitemId).guardBinding).toEqual(bound);
    expect(f.sendsFor(item.qitemId)).toBe(0);
  });

  it("control: a wake with an explicit expected identity keeps its pane-less binding and isn't sent", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.db.prepare("UPDATE outbox_entries SET guard_delivery = ? WHERE outbox_id = ?").run(
      JSON.stringify({ expectedIdentity: { nodeId: "a", sessionName: "worker@test", runtime: "claude-code", nativeId: "conversation-1" } }),
      `wake-intent-${item.qitemId}`);
    f.relaunch();

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.intentOf(item.qitemId).guardBinding).toMatchObject({ occupant: "occupant-1", pane: null });
    expect(f.sendsFor(item.qitemId)).toBe(0);
  });

  it("control: a wake that may already have been written isn't re-bound or replayed", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.db.prepare("UPDATE outbox_entries SET delivery_state = 'indeterminate' WHERE outbox_id = ?").run(`wake-intent-${item.qitemId}`);
    f.relaunch();

    await f.repo.drainPendingWakeIntents();
    expect(f.intentOf(item.qitemId).guardBinding).toMatchObject({ occupant: "occupant-1", pane: null });
    expect(f.intentOf(item.qitemId).deliveryState).toBe("indeterminate");
    expect(f.sendsFor(item.qitemId)).toBe(0);
  });

  it("control: when the seat changes again during delivery, the wake isn't sent elsewhere, and its binding isn't moved again", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.relaunch();
    // The occupant is replaced once the wake has taken its first binding, before its input is written.
    vi.mocked(f.tmux.probeSession).mockImplementationOnce(async () => { f.relaunch("occupant-3", 3, "%1"); return { state: "present" }; });

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.sendsFor(item.qitemId)).toBe(0);
    expect(f.intentOf(item.qitemId).guardBinding).toMatchObject({ occupant: "occupant-2", pane: "%1" });

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.sendsFor(item.qitemId)).toBe(0);
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^failed:.*changed/);
  });
});
