// A listing reads what every row needs once for all its rows instead of once per row: the last meaningful transitions
// in one windowed query, and (with it) the waiting view's statements, the owners' activity and the row itself. Each
// batched read must answer exactly what the per-row read answers, and a listing must project the same items.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { lastMeaningfulTransition, lastMeaningfulTransitionMany } from "../src/domain/queue-waiting.js";

let db: Database.Database;
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 9, 0, s)).toISOString();

function item(id: string, o: { state?: string; blockedOn?: string | null } = {}) {
  db.prepare(`INSERT INTO queue_items(qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, blocked_on)
    VALUES (?, ?, ?, 'sender@r', 'worker@r', ?, 'body', ?)`).run(id, at(0), at(0), o.state ?? "pending", o.blockedOn ?? null);
}
function transition(qitemId: string, state: string, actor: string, s: number): number {
  return Number(db.prepare(`INSERT INTO queue_transitions(qitem_id, ts, state, actor_session) VALUES (?, ?, ?, ?)`)
    .run(qitemId, at(s), state, actor).lastInsertRowid);
}
function wake(transitionId: number, qitemId: string, phase: "armed" | "fired") {
  db.prepare(`INSERT INTO queue_transition_wakes(transition_id, qitem_id, phase, wake_kind, wake_ref) VALUES (?, ?, ?, 'timer', 'job-1')`)
    .run(transitionId, qitemId, phase);
}
/** The batched answer and the per-row answer, for the same ids. */
function both(ids: string[]) {
  return {
    many: Object.fromEntries(lastMeaningfulTransitionMany(db, ids)),
    perRow: Object.fromEntries(ids.map((id) => [id, lastMeaningfulTransition(db, id)])),
  };
}

describe("lastMeaningfulTransitionMany answers what lastMeaningfulTransition answers", () => {
  beforeEach(() => { db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => db.close());

  it("covers a row without transitions, system actors repeating a state, a state change by a system actor, and an author note", () => {
    item("q-none");
    item("q-system-only");                        // every transition by a system actor, same state: the first one counts
    transition("q-system-only", "pending", "daemon@system", 1);
    transition("q-system-only", "pending", "watchdog@system", 2);
    transition("q-system-only", "pending", "wake-ladder@system", 3);
    item("q-mixed");                              // an author, then system bookkeeping in the same state
    transition("q-mixed", "pending", "sender@r", 1);
    transition("q-mixed", "in-progress", "worker@r", 2);
    transition("q-mixed", "in-progress", "daemon@kernel", 3);
    transition("q-mixed", "in-progress", "watchdog@system", 4);
    item("q-system-moves");                       // a system actor that changes the state is meaningful
    transition("q-system-moves", "pending", "sender@r", 1);
    transition("q-system-moves", "blocked", "worker@r", 2);
    transition("q-system-moves", "pending", "daemon@system", 3);
    const { many, perRow } = both(["q-none", "q-system-only", "q-mixed", "q-system-moves", "q-unknown"]);
    expect(many).toEqual(perRow);
    expect(many["q-none"]).toBeNull();
    expect(many["q-unknown"]).toBeNull();
    expect(many["q-system-only"]).not.toBeNull();
  });

  it("skips a transition whose wake fired, but not one whose wake is only armed", () => {
    item("q-fired");
    transition("q-fired", "pending", "sender@r", 1);
    const parked = transition("q-fired", "blocked", "worker@r", 2);
    wake(parked, "q-fired", "armed");
    const fired = transition("q-fired", "pending", "worker@r", 3);
    wake(fired, "q-fired", "fired");
    item("q-armed");
    const armed = transition("q-armed", "blocked", "worker@r", 1);
    wake(armed, "q-armed", "armed");
    const { many, perRow } = both(["q-fired", "q-armed"]);
    expect(many).toEqual(perRow);
    expect(many["q-fired"]).toEqual({ id: parked, at: at(2) });
  });

  it("an empty listing reads nothing and returns an empty map", () => {
    const spy = vi.spyOn(db, "prepare");
    expect(lastMeaningfulTransitionMany(db, []).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an id asked twice (a listed row that is also another row's blocker) maps to its one transition", () => {
    item("q-blocker");
    const t = transition("q-blocker", "in-progress", "worker@r", 1);
    item("q-waiter", { state: "blocked", blockedOn: "q-blocker" });
    transition("q-waiter", "blocked", "worker@r", 2);
    const ids = ["q-blocker", "q-waiter", "q-blocker"];
    const { many, perRow } = both(ids);
    expect(many).toEqual(perRow);
    expect(many["q-blocker"]).toEqual({ id: t, at: at(1) });
    expect(lastMeaningfulTransitionMany(db, ids).size).toBe(2);
  });

  it("reads in a constant number of statements, whatever the number of rows", () => {
    for (let i = 0; i < 40; i++) { item(`q-${i}`); transition(`q-${i}`, "pending", "sender@r", i); }
    const spy = vi.spyOn(db, "prepare");
    lastMeaningfulTransitionMany(db, Array.from({ length: 40 }, (_, i) => `q-${i}`));
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("lastMeaningfulTransitionMany on older schemas", () => {
  afterEach(() => db.close());

  it("a DB without queue_transition_wakes reads every transition as the per-row read does", () => {
    db = new Database(":memory:");
    migrate(db, [queueItemsSchema, queueTransitionsSchema]);
    item("q-a");
    transition("q-a", "pending", "sender@r", 1);
    transition("q-a", "pending", "watchdog@system", 2);
    item("q-b");
    const { many, perRow } = both(["q-a", "q-b"]);
    expect(many).toEqual(perRow);
    expect(many["q-a"]).not.toBeNull();
  });

  it("a DB without queue_transitions maps every id to null", () => {
    db = new Database(":memory:");
    migrate(db, [queueItemsSchema]);
    item("q-a");
    expect(Object.fromEntries(lastMeaningfulTransitionMany(db, ["q-a"]))).toEqual({ "q-a": lastMeaningfulTransition(db, "q-a") });
    expect(lastMeaningfulTransition(db, "q-a")).toBeNull();
  });
});

describe("a listing projects the same items with its shared reads as with per-row reads", () => {
  let repo: QueueRepository;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T09:30:00.000Z"));
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) } as never);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  /** The listing as it reads now, and the same listing with its shared reads withheld (every row read alone). */
  function listedBothWays(opts: Parameters<QueueRepository["list"]>[0]) {
    const shared = repo.list(opts);
    const own = repo as unknown as { listingReads: unknown };
    own.listingReads = () => undefined;
    try {
      return { shared, perRow: repo.list(opts) };
    } finally {
      delete (own as { listingReads?: unknown }).listingReads;
    }
  }

  async function seed() {
    const make = (destinationSession: string, body: string) =>
      repo.create({ sourceSession: "orch@r", destinationSession, body, nudge: false } as never).then((q) => q.qitemId);
    const fresh = await make("worker@r", "fresh");
    const claimed = await make("worker@r", "claimed");
    repo.update({ qitemId: claimed, actorSession: "worker@r", state: "in-progress" } as never);
    const blocker = await make("other@r", "the blocker");
    const waiter = await make("worker@r", "waits on the blocker");
    repo.update({ qitemId: waiter, actorSession: "worker@r", state: "blocked", blockedOn: blocker, transitionNote: "continuation: wait" } as never);
    const timed = await make("worker@r", "parked on a timer");
    repo.update({ qitemId: timed, actorSession: "worker@r", state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: CI",
      wakeAfterSeconds: 600 } as never);
    const done = await make("worker@r", "done");
    repo.update({ qitemId: done, actorSession: "worker@r", state: "done", closureReason: "no-follow-on" } as never);
    return { fresh, claimed, blocker, waiter, timed, done };
  }

  it("full and compact listings, with blockers inside and outside the listing", async () => {
    await seed();
    for (const opts of [{}, { compact: true as const }, { destinationSession: "worker@r" }, { destinationSession: "worker@r", compact: true as const },
      { state: ["blocked" as const] }, { rig: "r" }]) {
      const { shared, perRow } = listedBothWays(opts as never);
      expect(shared).toEqual(perRow);
    }
  });

  it("an empty listing", () => {
    const { shared, perRow } = listedBothWays({});
    expect(shared).toEqual([]);
    expect(perRow).toEqual([]);
  });
});

describe("a listing prepares the waiting view's statements once, not once per row", () => {
  let repo: QueueRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  /** How many times each kind of statement is prepared while `run` executes. */
  function preparedWhile(run: () => unknown): Record<string, number> {
    const prepare = db.prepare.bind(db);
    const kinds: Record<string, (sql: string) => boolean> = {
      pendingSince: (sql) => sql.includes("SELECT ts, previous_state FROM"),
      blocker: (sql) => sql.includes("SELECT destination_session, state FROM queue_items WHERE qitem_id = ?"),
      timer: (sql) => sql.includes("FROM queue_transition_wakes w JOIN watchdog_jobs j"),
      waitingRow: (sql) => sql.includes("SELECT qitem_id, source_session, destination_session, state, blocked_on, closure_required_at, tags"),
      schemaCheck: (sql) => /sqlite_master WHERE name = (\?|'queue_transitions'|'queue_transition_wakes')/.test(sql),
    };
    const counts = Object.fromEntries(Object.keys(kinds).map((k) => [k, 0]));
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      for (const [kind, match] of Object.entries(kinds)) if (match(sql)) counts[kind]!++;
      return prepare(sql);
    }) as typeof db.prepare);
    try { run(); } finally { spy.mockRestore(); }
    return counts;
  }

  it("30 pending rows, 30 rows blocked on another row and 30 parked on a timer", async () => {
    const make = (body: string) => repo.create({ sourceSession: "orch@r", destinationSession: "worker@r", body, nudge: false } as never)
      .then((q) => q.qitemId);
    for (let i = 0; i < 30; i++) {
      await make(`pending ${i}`);
      const blocker = await make(`blocker ${i}`);
      repo.update({ qitemId: await make(`waits ${i}`), actorSession: "worker@r", state: "blocked", blockedOn: blocker, transitionNote: "continuation: wait" } as never);
      repo.update({ qitemId: await make(`timed ${i}`), actorSession: "worker@r", state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: CI",
        wakeAfterSeconds: 600 } as never);
    }
    const counts = preparedWhile(() => repo.list({ limit: 500 }));
    expect(counts.pendingSince).toBeLessThanOrEqual(1);
    expect(counts.blocker).toBeLessThanOrEqual(1);
    expect(counts.timer).toBeLessThanOrEqual(1);
    expect(counts.waitingRow).toBeLessThanOrEqual(1);
    // lastMeaningfulTransitionMany's two checks and the waiting statements' one per table, whatever the row count.
    expect(counts.schemaCheck).toBeLessThanOrEqual(4);
  });
});

describe("a listing reads each owner's activity once", () => {
  let repo: QueueRepository;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T09:30:00.000Z"));
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) } as never);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  const idle = { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "window-sampling" };
  const make = (destinationSession: string) =>
    repo.create({ sourceSession: "orch@r", destinationSession, body: "work", nudge: false } as never).then((q) => q.qitemId);

  it("one read per distinct session, for the pickup receipt and the waiting view alike", async () => {
    for (let i = 0; i < 10; i++) { await make("a@r"); await make("b@r"); }
    const reader = vi.fn((session: string) => (session ? idle : null) as never);
    repo.attachActivityReader(reader);
    repo.list({});
    expect(reader.mock.calls.map(([s]) => s).sort()).toEqual(["a@r", "b@r"]);
    repo.list({ compact: true });
    expect(reader).toHaveBeenCalledTimes(4); // a new listing reads again
  });

  it("a reader that throws for one session leaves the other sessions' rows as they were, and that session's rows unknown", async () => {
    await make("ok@r"); await make("broken@r"); await make("ok@r");
    repo.attachActivityReader((session) => { if (session === "broken@r") throw new Error("fixture: seat state unreadable"); return idle as never; });
    const shared = repo.list({});
    const own = repo as unknown as { listingReads: unknown };
    own.listingReads = () => undefined;
    const perRow = repo.list({});
    delete (own as { listingReads?: unknown }).listingReads;
    expect(shared).toEqual(perRow);
    const liveness = (owner: string) => shared.filter((i) => i.destinationSession === owner).map((i) => i.waiting?.liveness.confidence);
    expect(liveness("ok@r")).toEqual(["oracle", "oracle"]);
    expect(liveness("broken@r")).toEqual(["unknown"]);
  });
});

describe("a listed row's waiting view reads the row in hand instead of reading it again", () => {
  let repo: QueueRepository;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T09:30:00.000Z"));
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) } as never);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  const make = (destinationSession: string, body = "work") =>
    repo.create({ sourceSession: "orch@r", destinationSession, body, nudge: false } as never).then((q) => q.qitemId);
  const rereads = (sql: string) =>
    sql.includes("SELECT qitem_id, source_session, destination_session, state, blocked_on, closure_required_at, tags")
    || /SELECT state, (human_intent|NULL AS human_intent), destination_session, last_nudge_result FROM queue_items WHERE qitem_id = \?/.test(sql)
    || sql.includes("SELECT last_nudge_result FROM queue_items WHERE qitem_id = ?");

  it("prepares none of the waiting view's own-row reads, and projects what the per-row read projects", async () => {
    const plain = await make("worker@r");
    const held = await make("worker@r");
    db.prepare("UPDATE queue_items SET last_nudge_result = 'retained:typing_guard' WHERE qitem_id = ?").run(held);
    const claimed = await make("worker@r");
    repo.update({ qitemId: claimed, actorSession: "worker@r", state: "in-progress" } as never);
    const prepare = db.prepare.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { if (rereads(sql)) n++; return prepare(sql); }) as typeof db.prepare);
    const shared = repo.list({});
    spy.mockRestore();
    expect(n).toBe(0);
    const own = repo as unknown as { listingReads: unknown };
    own.listingReads = () => undefined;
    const perRow = repo.list({});
    delete (own as { listingReads?: unknown }).listingReads;
    expect(shared).toEqual(perRow);
    expect(shared.find((i) => i.qitemId === held)?.waiting?.nextBackstop).toMatchObject({ mechanism: "held by the seat's typing guard", held: true });
    expect(shared.find((i) => i.qitemId === plain)?.waiting?.state).toBe("pending");
  });

  it("a single-row read outside a listing still reads its own row", async () => {
    const q = await make("worker@r");
    const prepare = db.prepare.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { if (rereads(sql)) n++; return prepare(sql); }) as typeof db.prepare);
    expect(repo.waitingView(q)?.state).toBe("pending");
    spy.mockRestore();
    expect(n).toBeGreaterThan(0);
  });
});

describe("show (getById) is the listing projection of one row", () => {
  let repo: QueueRepository;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T09:30:00.000Z"));
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) } as never);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  /** getById as it read before: the per-row projection, then the delivery outcome read on its own. */
  function getByIdPerRow(qitemId: string) {
    const own = repo as unknown as { rowToItem: (row: unknown) => Record<string, unknown> };
    const row = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId);
    const item = own.rowToItem.call(repo, row);
    const ledger = repo.deliveryOutcomeFor(qitemId);
    return { ...item, deliveryOutcome: ledger?.outcome ?? null, ...(ledger && ledger.outcome !== "posted" && ledger.outcome !== "accepted" ? { deliveryFailureDetail: ledger.detail } : {}) };
  }

  it("answers what the per-row projection answered: pending, in-progress, blocked, parked, done and handed-off", async () => {
    const make = (destinationSession: string, body: string) =>
      repo.create({ sourceSession: "orch@r", destinationSession, body, nudge: false } as never).then((q) => q.qitemId);
    const fresh = await make("worker@r", "fresh");
    const claimed = await make("worker@r", "claimed");
    repo.update({ qitemId: claimed, actorSession: "worker@r", state: "in-progress" } as never);
    const blocker = await make("other@r", "the blocker");
    const waiter = await make("worker@r", "waits");
    repo.update({ qitemId: waiter, actorSession: "worker@r", state: "blocked", blockedOn: blocker, transitionNote: "continuation: wait" } as never);
    const timed = await make("worker@r", "timer");
    repo.update({ qitemId: timed, actorSession: "worker@r", state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: CI",
      wakeAfterSeconds: 600 } as never);
    const done = await make("worker@r", "done");
    repo.update({ qitemId: done, actorSession: "worker@r", state: "done", closureReason: "no-follow-on" } as never);
    const passed = await make("worker@r", "passed on");
    const { created: successor } = await repo.handoff({ qitemId: passed, fromSession: "worker@r", toSession: "next@r", nudge: false });
    const ids = [fresh, claimed, blocker, waiter, timed, done, passed, successor.qitemId];
    // Each state the face can show is here, so the comparison below covers it.
    expect(ids.map((id) => repo.getById(id)?.state)).toEqual(
      ["pending", "in-progress", "pending", "blocked", "blocked", "done", "handed-off", "pending"]);
    expect(repo.getById(timed)?.pickup?.state).toBe("parked");
    for (const id of ids) expect(repo.getById(id)).toEqual(getByIdPerRow(id));
    expect(repo.getById("qitem-missing")).toBeNull();
  });

  it("reads the row's last meaningful transition once, not once for the pickup and once for the waiting view", async () => {
    const q = (await repo.create({ sourceSession: "orch@r", destinationSession: "worker@r", body: "work", nudge: false } as never)).qitemId;
    const prepare = db.prepare.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("actor_session NOT IN ('watchdog@system'")) n++;
      return prepare(sql);
    }) as typeof db.prepare);
    repo.getById(q);
    spy.mockRestore();
    expect(n).toBe(1);
  });
});
