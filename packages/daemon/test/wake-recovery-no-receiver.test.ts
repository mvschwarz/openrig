import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { physicalSessionName } from "../src/domain/session-registry.js";
import { createWakeRecovery } from "../src/domain/wake-recovery.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const MISSING = (session: string) =>
  `Session '${session}' not found: tmux reports no session with this name. No text was sent. Check available sessions with: rig ps --nodes`;

/** One running seat, one stopped on purpose (exited), one whose tmux session was gone at start (detached), and an
 *  address no transport holds. The transport behaves like tmux: only the running seat has a session. */
function team() {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig1')").run();
  for (const [seat, status] of [["a", "running"], ["b", "exited"], ["c", "detached"]] as const) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'rig-1', ?, 'claude-code')").run(`node-${seat}`, `dev.${seat}`);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)").run(`sess-${seat}`, `node-${seat}`, `dev-${seat}@rig1`, status);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session) VALUES (?, ?, 'tmux', ?)").run(`binding-${seat}`, `node-${seat}`, `dev-${seat}@rig1`);
  }
  const outbox = new OutboxHandler(db);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true as const, entities: [] }) });
  repo.attachOutbox(outbox);
  const live = new Set(["dev-a@rig1"]);
  const send = vi.fn(async (session: string, _text?: string) => live.has(session)
    ? { ok: true, verified: true }
    : { ok: false, sent: false, reason: "session_missing", inputPhase: "not_reached" as const, error: MISSING(session) });
  const state = (qitemId: string) => outbox.getById(`${WAKE_INTENT_PREFIX}${qitemId}`)!.deliveryState;
  const transitions = (qitemId: string) => (db.prepare("SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id = ?").get(qitemId) as { n: number }).n;
  /** The seat starts again: a newer running session. */
  const start = (seat: "b" | "c", id: string) => {
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')").run(id, `node-${seat}`, `dev-${seat}@rig1`);
    live.add(`dev-${seat}@rig1`);
  };
  return { db, outbox, repo, send, live, state, transitions, start };
}

/** Rows owed by each address, each with its notification already tried once and failed (the daemon was up). */
async function owe(t: ReturnType<typeof team>, destinations: string[]) {
  t.repo.attachTransport({ send: t.send });
  const wasLive = [...t.live];
  t.live.clear();
  const ids: string[] = [];
  for (const [i, destinationSession] of destinations.entries()) {
    ids.push((await t.repo.create({ sourceSession: "lead@rig1", destinationSession, body: `work ${i}` })).qitemId);
  }
  await vi.waitFor(() => expect(ids.map(t.state).every((s) => s === "failed")).toBe(true));
  for (const seat of wasLive) t.live.add(seat);
  t.send.mockClear();
  return ids;
}

describe("start-up wake recovery and seats with nothing to receive a wake", () => {
  it("doesn't replay failed wakes to stopped seats or unroutable addresses; a running seat's failed wake is still replayed", async () => {
    const t = team();
    const ids = await owe(t, ["dev-a@rig1", "dev-b@rig1", "dev-b@rig1", "dev-c@rig1", "gone@rig1"]);
    const [a, ...waiting] = ids as [string, ...string[]];
    const before = waiting.map((id) => ({ result: t.repo.getById(id)!.lastNudgeResult, transitions: t.transitions(id) }));
    expect(before.map((b) => b.result)).toEqual([
      `failed:${MISSING("dev-b@rig1")}`, `failed:${MISSING("dev-b@rig1")}`, `failed:${MISSING("dev-c@rig1")}`,
      expect.stringMatching(/^unroutable: 'gone@rig1' has no terminal transport/),
    ]);

    const tally = await t.repo.drainPendingWakeIntents();

    // One wake, to the running seat. Main sent three more into tmux (b twice, c once) and re-failed all four.
    expect(t.send.mock.calls.map(([session]) => session)).toEqual(["dev-a@rig1"]);
    expect(t.state(a)).toBe("delivered");
    expect(tally).toEqual({ delivered: 1, indeterminate: 0, failed: 0, retained: 0,
      waiting: { notifications: 4, seats: ["dev-b@rig1", "dev-c@rig1", "gone@rig1"] } });
    // The waiting rows stay owed and untouched: same notification state, same last result, no new transitions.
    expect(waiting.map(t.state)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(waiting.map((id) => ({ result: t.repo.getById(id)!.lastNudgeResult, transitions: t.transitions(id) }))).toEqual(before);
    expect(waiting.map((id) => t.repo.getById(id)!.state)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("replays the waiting wakes once the seat is running again", async () => {
    const t = team();
    const [b] = await owe(t, ["dev-b@rig1"]);
    expect((await t.repo.drainPendingWakeIntents()).waiting).toEqual({ notifications: 1, seats: ["dev-b@rig1"] });
    expect(t.send).not.toHaveBeenCalled();
    // The seat starts again: a newer running session.
    t.db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('sess-b2', 'node-b', 'dev-b@rig1', 'running')").run();
    t.send.mockImplementation(async () => ({ ok: true, verified: true }));
    const tally = await t.repo.drainPendingWakeIntents();
    expect(tally).toEqual({ delivered: 1, indeterminate: 0, failed: 0, retained: 0 });
    expect(t.state(b!)).toBe("delivered");
  });

  it("still gives a never-tried wake to a stopped seat its one attempt, so its row records why it didn't land", async () => {
    const t = team();
    const [b] = [(await t.repo.create({ sourceSession: "lead@rig1", destinationSession: "dev-b@rig1", body: "work" })).qitemId];
    expect(t.state(b!)).toBe("pending");
    t.repo.attachTransport({ send: t.send });
    const tally = await t.repo.drainPendingWakeIntents();
    expect(t.send.mock.calls.map(([session]) => session)).toEqual(["dev-b@rig1"]);
    expect(tally).toEqual({ delivered: 0, indeterminate: 0, failed: 1, retained: 0 });
    expect(t.repo.getById(b!)!.lastNudgeResult).toBe(`failed:${MISSING("dev-b@rig1")}`);
  });

  it.each([
    ["separate", false, ["failed", "delivered", "delivered"], { waiting: { notifications: 1, seats: ["dev-b@rig1"] } }],
    // The later wake's group takes the earlier one along once the seat is back, so nothing is left waiting.
    ["sharing a return tag", true, ["delivered", "delivered", "delivered"], {}],
  ] as const)("a seat that starts while the pass is running gets its later failed wakes in that pass (%s)", async (_, shared, states, waiting) => {
    const t = team();
    const [b1, a1, b2] = await owe(t, ["dev-b@rig1", "dev-a@rig1", "dev-b@rig1"]);
    if (shared) {
      for (const id of [b1, b2]) {
        t.db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = ?").run(JSON.stringify(["queue:return:qitem-x"]), `${WAKE_INTENT_PREFIX}${id}`);
      }
    }
    // dev-b starts while the pass waits on dev-a's delivery.
    t.send.mockImplementation(async (session: string) => {
      if (session === "dev-a@rig1") t.start("b", "sess-b2");
      return t.live.has(session) ? { ok: true, verified: true }
        : { ok: false, sent: false, reason: "session_missing", inputPhase: "not_reached" as const, error: MISSING(session) };
    });
    const tally = await t.repo.drainPendingWakeIntents();
    expect(t.send.mock.calls.map(([session]) => session)).toEqual(["dev-a@rig1", "dev-b@rig1"]);
    expect([b1, a1, b2].map((id) => t.state(id!))).toEqual(states);
    expect(tally).toEqual({ delivered: 2, indeterminate: 0, failed: 0, retained: 0, ...waiting });
  });

  it("a never-tried wake goes alone: its group leaves a failed peer whose seat has no receiver, and only untouched wakes count as waiting", async () => {
    const t = team();
    const peer = (await t.repo.create({ sourceSession: "lead@rig1", destinationSession: "dev-b@rig1", body: "earlier work" })).qitemId;
    const fresh = (await t.repo.create({ sourceSession: "lead@rig1", destinationSession: "dev-b@rig1", body: "later work" })).qitemId;
    // No transport yet, so both are still pending. They share one return tag, and the earlier one was tried and failed.
    for (const id of [peer, fresh]) {
      t.db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = ?").run(JSON.stringify(["queue:return:qitem-x"]), `${WAKE_INTENT_PREFIX}${id}`);
    }
    expect(t.outbox.claimForDelivery(`${WAKE_INTENT_PREFIX}${peer}`)).toBe(true);
    t.outbox.finalizeDelivery(`${WAKE_INTENT_PREFIX}${peer}`, "failed");
    const untouched = () => ({ result: t.repo.getById(peer)!.lastNudgeResult, attempt: t.repo.getById(peer)!.lastNudgeAttempt, transitions: t.transitions(peer) });
    const before = untouched();
    t.repo.attachTransport({ send: t.send });
    const tally = await t.repo.drainPendingWakeIntents();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0]![1]).toContain(fresh);
    expect(t.send.mock.calls[0]![1]).not.toContain(peer);
    expect(t.state(peer)).toBe("failed");
    expect(untouched()).toEqual(before);
    expect(tally).toEqual({ delivered: 0, indeterminate: 0, failed: 1, retained: 0, waiting: { notifications: 1, seats: ["dev-b@rig1"] } });
  });

  it("a canonical address whose old session exited still gets its wake when its current physical session runs", async () => {
    const t = team();
    // dev-e@rig1 ran once under its own name; the same node then reconnected under the physical name e-phys.
    t.db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-e', 'rig-1', 'dev.e', 'claude-code')").run();
    t.db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('sess-e1', 'node-e', 'dev-e@rig1', 'exited')").run();
    t.db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('sess-e2', 'node-e', 'e-phys', 'running')").run();
    t.db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session) VALUES ('binding-e', 'node-e', 'tmux', 'e-phys')").run();
    // The transport sends to the current physical session.
    expect(physicalSessionName(t.db, "dev-e@rig1")).toBe("e-phys");
    const [e] = await owe(t, ["dev-e@rig1"]);
    t.live.add("dev-e@rig1");
    const tally = await t.repo.drainPendingWakeIntents();
    expect(t.send.mock.calls.map(([session]) => session)).toEqual(["dev-e@rig1"]);
    expect(t.state(e!)).toBe("delivered");
    expect(tally).toEqual({ delivered: 1, indeterminate: 0, failed: 0, retained: 0 });
  });

  it("names the waiting seats once in the start-up log line", async () => {
    const t = team();
    await owe(t, ["dev-b@rig1", "dev-c@rig1", "dev-c@rig1"]);
    const log = { log: vi.fn(), warn: vi.fn() };
    const recovery = createWakeRecovery(t.repo, 0, log);
    recovery.start();
    await vi.waitFor(() => expect(log.log).toHaveBeenCalled());
    await recovery.stop();
    expect(log.log).toHaveBeenCalledWith(
      "wake-intent recovery sweep: delivered=0 indeterminate=0 failed=0 reconciled=0 waiting=3 (not replayed: no session or transport for dev-b@rig1, dev-c@rig1)");
  });
});
