// The stuck sweep's own reads leave out the waiting view it never uses, and the pass yields on elapsed time as well as
// every 50 rows, with the clock running across awaits that don't yield. A yield of either kind drops the pass's indexes
// (#2649), so a successor that routeToFallback moved during the yield is read live, not answered from a stale index.
// The fixture is a copy of a real capture: a live daemon's routeToFallback of a handoff successor, the custody shape it
// hits, and the wall time per row of the stuck_sweep.pass spans of a 45-agent benchmark (the pass's yields included, so
// an upper bound of a row's work under that load, not the work itself).
// Time is a clock the test moves (performance.now() and Date.now()), never a sleep: the counts are exact.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, hasLinkedSuccessor } from "../src/domain/queue-repository.js";
import { runStuckSweep, STUCK_SWEEP_YIELD_EVERY_ROWS } from "../src/domain/queue-stuck-sweep.js";

const real = JSON.parse(readFileSync(new URL("./fixtures/queue-stuck-sweep-elapsed-yield/real.json", import.meta.url), "utf8")) as {
  reroute: { actor: string; from: string; to: string; reason: string; note: string };
  reroutedSuccessorChainTail: string;
  custody: { example: { source: { state: string; closureReason: string; closureTarget: string }; successor: { destination: string } } };
  benchmark: { wallMsPerRow: number };
};
const ELAPSED_MS = 50;
const ROW_MS = real.benchmark.wallMsPerRow;
/** The most rows a pass judges between two yields when each costs the measured time. */
const maxRowsPerStretch = Math.ceil(ELAPSED_MS / ROW_MS) + 1;

let db: Database.Database;
let repo: QueueRepository;
const recent = () => new Date(Date.now() - 5 * 60_000).toISOString();

function row(id: string, o: { state?: string; destination?: string; handedOffFrom?: string | null; chain?: string[] | null;
  closureReason?: string | null; closureTarget?: string | null; blockedOn?: string | null; created?: string; updated?: string;
  claimedAt?: string | null; closureRequiredAt?: string | null; heartbeat?: string | null; nudge?: string | null } = {}) {
  db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,
      handed_off_from,chain_of_record,closure_reason,closure_target,blocked_on,claimed_at,closure_required_at,last_heartbeat,
      last_nudge_attempt,last_nudge_result)
    VALUES (?, ?, ?, 'sender@r', ?, ?, '[]', 'body', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, o.created ?? recent(), o.updated ?? recent(),
    o.destination ?? "worker@r", o.state ?? "done", o.handedOffFrom ?? null, o.chain ? JSON.stringify(o.chain) : null,
    o.closureReason ?? null, o.closureTarget ?? null, o.blockedOn ?? null, o.claimedAt ?? null, o.closureRequiredAt ?? null,
    o.heartbeat ?? null, o.nudge ? recent() : null, o.nudge ?? null);
}
/** A row closed handed_off_to onto a seat (the real custody shape), with or without its successor linked at that seat. */
function custody(id: string, seat: string, successor?: string) {
  row(id, { state: real.custody.example.source.state, closureReason: real.custody.example.source.closureReason, closureTarget: seat });
  if (successor) row(successor, { state: "pending", destination: seat, handedOffFrom: id, chain: [id] });
}
const pad = (i: number) => String(i).padStart(4, "0");
function fillers(n: number, withSuccessor = true): string[] {
  const ids = Array.from({ length: n }, (_, i) => `qitem-c${pad(i)}`);
  ids.forEach((id, i) => custody(id, `seat-${i % 7}@r`, withSuccessor ? `s-${pad(i)}` : undefined));
  return ids;
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
/** A claimed row past its closure deadline. */
const overdue = (id: string) => row(id, { state: "in-progress", created: hoursAgo(3), claimedAt: hoursAgo(3), closureRequiredAt: hoursAgo(2), heartbeat: recent() });
/** A pending row nobody claimed, old enough for the unclaimed net. */
const unclaimed = (id: string) => row(id, { state: "pending", created: hoursAgo(3), updated: hoursAgo(3) });

/** Counts the turns of the event loop that ran while a pass was going: one per real yield of the pass. `onTick` runs at
 *  each turn, while the pass is giving way. */
function ticker(onTick?: () => void) {
  let ticks = 0; let done = false;
  const spin = () => { if (done) return; ticks++; onTick?.(); setImmediate(spin); };
  setImmediate(spin);
  return { now: () => ticks, stop: () => { done = true; } };
}
/** Consecutive runs of `seen` with the same tick: how many of the rows were judged between two yields. */
const stretches = (seen: number[]): number[] => seen.reduce<number[]>((runs, t, i) => {
  if (i > 0 && t === seen[i - 1]) runs[runs.length - 1]!++; else runs.push(1);
  return runs;
}, []);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Records the sweep's first read by id of each matching row, with the tick it was read at; `onRead` runs on it. */
function firstReads(match: (id: string) => boolean, clock: { now: () => number }, onRead?: (id: string, n: number) => void) {
  const getById = repo.getById.bind(repo) as (...args: unknown[]) => ReturnType<typeof repo.getById>;
  const seen = new Map<string, number>();
  vi.spyOn(repo, "getById").mockImplementation(((...args: unknown[]) => {
    const id = args[0] as string;
    if (match(id) && !seen.has(id)) { seen.set(id, clock.now()); onRead?.(id, seen.size); }
    return getById(...args);
  }) as typeof repo.getById);
  return seen;
}

/** A clock the test moves: performance.now() and Date.now() read `t`. */
function stubClock() {
  const state = { t: Date.now() }; // real now, then still unless the test moves it
  vi.spyOn(performance, "now").mockImplementation(() => state.t);
  vi.spyOn(Date, "now").mockImplementation(() => state.t);
  return state;
}

beforeEach(() => {
  db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("the fixture is the real capture", () => {
  it("routeToFallback on this tree writes the captured transition, and a live check then answers no", () => {
    const { from, to, reason, actor, note } = real.reroute;
    expect(real.custody.example.successor.destination).toBe(real.custody.example.source.closureTarget);
    custody("qitem-src", from, "s-src");
    expect(hasLinkedSuccessor(db, "qitem-src", from)).toBe(true);
    repo.routeToFallback("s-src", to, reason);
    const last = repo.transitionLog.listForQitem("s-src").at(-1)!;
    expect([last.actorSession, last.transitionNote]).toEqual([actor, note]);
    expect(repo.getById("s-src")?.chainOfRecord).toEqual(["qitem-src", real.reroutedSuccessorChainTail]);
    expect(repo.getById("s-src")?.destinationSession).toBe(to);
    expect(hasLinkedSuccessor(db, "qitem-src", from)).toBe(false);
  });
});

describe("a successor rerouted during a yield leaves no stale yes", () => {
  /** X sorts after every filler: the custody loop judges it last. */
  const X = "qitem-c9999";
  const createdFor = (result: Awaited<ReturnType<typeof runStuckSweep>>) => ({
    x: result.findings.filter((f) => f.qitemId === X && f.action === "created").map((f) => f.kind),
    others: result.findings.filter((f) => f.qitemId !== X && f.action === "created"),
  });
  async function rerouteDuringAYield(rowMs: number) {
    const time = stubClock();
    const clock = ticker();
    let rerouted = false; let reroutedBeforeX: boolean | undefined;
    firstReads((id) => id.startsWith("qitem-c"), clock, (id, n) => {
      if (n === 1) setImmediate(() => { repo.routeToFallback("s-x", real.reroute.to, real.reroute.reason); rerouted = true; });
      if (id === X) reroutedBeforeX = rerouted;
      time.t += rowMs;
    });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    return { result, rerouted, reroutedBeforeX };
  }

  it("control: the same successor rerouted before the pass: the custody row gets its finding, and no other row does", async () => {
    fillers(120);
    custody(X, real.reroute.from, "s-x");
    stubClock();
    repo.routeToFallback("s-x", real.reroute.to, real.reroute.reason);
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(createdFor(result)).toEqual({ x: ["dangling-closure"], others: [] });
  });

  it("a yield every 50 rows: the custody row whose successor moved gets its finding", async () => {
    fillers(120);
    custody(X, real.reroute.from, "s-x");
    // the clock stands still: only the 50-row yields happen
    const { result, rerouted, reroutedBeforeX } = await rerouteDuringAYield(0);
    expect(rerouted).toBe(true);
    expect(reroutedBeforeX).toBe(true); // the reroute landed in a yield after the pass first read a custody row, before X
    expect(hasLinkedSuccessor(db, X, real.reroute.from)).toBe(false);
    expect(createdFor(result)).toEqual({ x: ["dangling-closure"], others: [] });
  });

  it("a yield on elapsed time, under 50 rows at the measured time per row: the same finding", async () => {
    fillers(20);
    custody(X, real.reroute.from, "s-x");
    const { result, rerouted, reroutedBeforeX } = await rerouteDuringAYield(ROW_MS);
    expect(rerouted).toBe(true);
    expect(reroutedBeforeX).toBe(true);
    expect(hasLinkedSuccessor(db, X, real.reroute.from)).toBe(false);
    expect(createdFor(result)).toEqual({ x: ["dangling-closure"], others: [] });
  });
});

describe("the sweep's own reads leave out the waiting view", () => {
  const OVERDUE = STUCK_SWEEP_YIELD_EVERY_ROWS + 2; // a yield inside the overdue loop: its last rows are read again by id
  function seedEveryKind(): void {
    for (let i = 0; i < OVERDUE; i++) overdue(`qitem-o${pad(i)}`);
    for (let i = 0; i < 3; i++) {
      unclaimed(`qitem-u${pad(i)}`);
      row(`qitem-a${pad(i)}`, { state: "pending", created: recent(), nudge: "failed:probe" }); // undelivered wake
      row(`qitem-k${pad(i)}`, { state: "blocked", blockedOn: `qitem-u${pad(i)}`, nudge: "failed:probe" }); // parked, failed nudge
      row(`qitem-d${pad(i)}`, { state: "done", closureReason: "handed_off_to", closureTarget: `seat-${i}@r` }); // dangling custody
      custody(`qitem-h${pad(i)}`, `seat-${i}@r`, `s-h${pad(i)}`); // custody held
    }
    row("qitem-x0000", { state: "done" });
    row("qitem-t0000", { state: "done", closureTarget: "qitem-x0000" }); // custody onto a row: the target is read by id
  }
  /** What the reads made outside the writes the sweep makes (a write's own read of its row is not the sweep's read, and
   *  keeps the view) built or returned of the waiting view: `views` the ids a waiting view was built for, `returned`
   *  the ids of the rows a read by id or a finder returned with one. */
  function waitingOutsideWrites() {
    const views: string[] = []; const returned: string[] = [];
    let inWrite = 0;
    for (const name of ["create", "update", "recordClosureOverdue", "deliverWakeForSuccessor"] as const) {
      const write = (repo[name] as (...a: unknown[]) => unknown).bind(repo);
      vi.spyOn(repo, name).mockImplementation(((...args: unknown[]) => {
        inWrite++;
        let out: unknown;
        try { out = write(...args); } catch (err) { inWrite--; throw err; }
        if (out instanceof Promise) return out.finally(() => { inWrite--; });
        inWrite--;
        return out;
      }) as never);
    }
    const waitingView = repo.waitingView.bind(repo) as (...a: unknown[]) => ReturnType<typeof repo.waitingView>;
    vi.spyOn(repo, "waitingView").mockImplementation(((...args: unknown[]) => {
      if (inWrite === 0) views.push(args[0] as string);
      return waitingView(...args);
    }) as typeof repo.waitingView);
    const note = (item: { qitemId: string; waiting?: unknown } | null | undefined) => {
      if (inWrite === 0 && item && item.waiting !== undefined) returned.push(item.qitemId);
    };
    const getById = repo.getById.bind(repo) as (...a: unknown[]) => ReturnType<typeof repo.getById>;
    vi.spyOn(repo, "getById").mockImplementation(((...args: unknown[]) => {
      const item = getById(...args); note(item); return item;
    }) as typeof repo.getById);
    for (const name of ["findOverdue", "findUndelivered"] as const) {
      const find = (repo[name] as (...a: unknown[]) => Array<{ qitemId: string; waiting?: unknown }>).bind(repo);
      vi.spyOn(repo, name).mockImplementation(((...args: unknown[]) => {
        const items = find(...args); items.forEach(note); return items;
      }) as never);
    }
    return { views, returned };
  }
  const kindsOf = (result: Awaited<ReturnType<typeof runStuckSweep>>, action: string) =>
    new Set(result.findings.filter((f) => f.action === action).map((f) => f.kind));

  it("builds no waiting view for a row it reads: on a pass that creates findings, on the steady pass, and on the pass that closes them", async () => {
    seedEveryKind();
    const seen = waitingOutsideWrites();
    const first = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const created = first.findings.filter((f) => f.action === "created");
    // the parked rows are read (parkedCandidate) but make no finding of their own here
    expect(kindsOf(first, "created")).toEqual(new Set(["overdue-claim", "unclaimed-obligation", "undelivered-wake", "dangling-closure"]));
    expect(seen).toEqual({ views: [], returned: [] });
    // the steady pass: every finding refreshed, each read through the recovery that holds its row
    const second = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(second.findings.filter((f) => f.action === "refreshed")).toHaveLength(created.length);
    expect(seen).toEqual({ views: [], returned: [] });
    // the sources resolve: unclaimed and undelivered rows close, overdue claims get a later deadline, dangling custody rows
    // get their successor. The resolution reads each source again (its evidence, its rule on the row as it is now).
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id LIKE 'qitem-u%' OR qitem_id LIKE 'qitem-a%'").run();
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id LIKE 'qitem-o%'").run(new Date(Date.now() + 3600_000).toISOString());
    for (let i = 0; i < 3; i++) row(`s-d${pad(i)}`, { state: "pending", destination: `seat-${i}@r`, handedOffFrom: `qitem-d${pad(i)}`, chain: [`qitem-d${pad(i)}`] });
    const third = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(kindsOf(third, "closed")).toEqual(new Set(["overdue-claim", "unclaimed-obligation", "undelivered-wake", "dangling-closure"]));
    expect(seen).toEqual({ views: [], returned: [] });
    // the instruments see a read that does build the view: the same row read by id outside the sweep
    repo.getById("qitem-k0000");
    expect(seen).toEqual({ views: ["qitem-k0000"], returned: ["qitem-k0000"] });
  });

  it("every other read keeps it: by default, and for a reader that runs during one of the pass's yields", async () => {
    seedEveryKind();
    fillers(120);
    const parked = "qitem-k0000";
    expect(repo.getById(parked)?.waiting).toBeTruthy();
    let duringYield: unknown = "not read";
    setImmediate(() => { duringYield = repo.getById(parked)?.waiting; });
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(duringYield).not.toBe("not read");
    expect(duringYield).toBeTruthy();
    expect(repo.getById(parked)?.waiting).toBeTruthy();
    expect(repo.list({ state: "blocked" }).find((q) => q.qitemId === parked)?.waiting).toBeTruthy();
    expect(repo.findUndelivered().find((q) => q.qitemId === "qitem-a0000")?.waiting).toBeTruthy();
    expect(repo.findOverdue().find((q) => q.qitemId === "qitem-o0000")?.waiting).toBeTruthy();
  });
});

describe("the pass yields on elapsed time, across awaits, and still every 50 rows", () => {
  it("custody rows that cost the measured time are judged in stretches of about 50 ms, not 50 rows", async () => {
    fillers(30);
    const time = stubClock();
    const clock = ticker();
    const seen = firstReads((id) => id.startsWith("qitem-c"), clock, () => { time.t += ROW_MS; });
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    const runs = stretches([...seen.values()]);
    expect(sum(runs)).toBe(30);
    expect(Math.max(...runs)).toBeLessThanOrEqual(maxRowsPerStretch);
  });

  it("unclaimed rows that cost the measured time: the same stretches", async () => {
    for (let i = 0; i < 30; i++) unclaimed(`qitem-u${pad(i)}`);
    const time = stubClock();
    const clock = ticker();
    const seen = firstReads((id) => id.startsWith("qitem-u"), clock, () => { time.t += ROW_MS; });
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    const runs = stretches([...seen.values()]);
    expect(sum(runs)).toBe(30);
    expect(Math.max(...runs)).toBeLessThanOrEqual(maxRowsPerStretch);
  });

  it("rows a finder lists, each costing the measured time: the same stretches", async () => {
    for (let i = 0; i < 30; i++) overdue(`qitem-o${pad(i)}`);
    const time = stubClock();
    const clock = ticker();
    const record = repo.recordClosureOverdue.bind(repo) as (...a: unknown[]) => unknown;
    const at: number[] = [];
    vi.spyOn(repo, "recordClosureOverdue").mockImplementation(((...args: unknown[]) => {
      at.push(clock.now());
      time.t += ROW_MS;
      return record(...args);
    }) as never);
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    expect(at).toHaveLength(30);
    expect(Math.max(...stretches(at))).toBeLessThanOrEqual(maxRowsPerStretch);
  });

  it("the clock keeps running across an awaited create that doesn't yield", async () => {
    fillers(12, false); // twelve dangling custody rows: twelve findings created, each awaited
    const time = stubClock();
    const clock = ticker();
    const create = repo.create.bind(repo);
    const at: number[] = [];
    vi.spyOn(repo, "create").mockImplementation(((input: Parameters<typeof repo.create>[0]) => {
      at.push(clock.now());
      time.t += ROW_MS;
      return create(input);
    }) as typeof repo.create);
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    expect(result.findings.filter((f) => f.action === "created")).toHaveLength(12);
    expect(at).toHaveLength(12);
    expect(Math.max(...stretches(at))).toBeLessThanOrEqual(maxRowsPerStretch);
  });

  it("with the clock still, it yields every 50 rows, as #2649 does", async () => {
    expect(STUCK_SWEEP_YIELD_EVERY_ROWS).toBe(50);
    fillers(120);
    stubClock();
    const clock = ticker();
    const seen = firstReads((id) => id.startsWith("qitem-c"), clock);
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    const runs = stretches([...seen.values()]);
    // the first stretch shares its count with rows of the loops before it; every whole stretch after it is 50 rows
    expect(sum(runs)).toBe(120);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...runs)).toBeLessThanOrEqual(50);
    expect(runs.slice(1, -1)).toEqual(runs.slice(1, -1).map(() => 50));
  });

  it("with 2 ms a row, it yields every 50 ms of work: about every 25 rows; the clock restarts after each yield, so time spent away doesn't count", async () => {
    fillers(120);
    const time = stubClock();
    const clock = ticker(() => { time.t += 40; }); // others run 40 ms while the pass gives way
    const seen = firstReads((id) => id.startsWith("qitem-c"), clock, () => { time.t += 2; });
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    const runs = stretches([...seen.values()]);
    expect(sum(runs)).toBe(120);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const run of runs.slice(0, -1)) {
      expect(run).toBeGreaterThanOrEqual(24);
      expect(run).toBeLessThanOrEqual(27);
    }
  });

  it("a yield on elapsed time restarts the row count too: 50 rows after it, not what was left of the 50", async () => {
    fillers(120);
    const time = stubClock();
    const clock = ticker();
    const seen = firstReads((id) => id.startsWith("qitem-c"), clock, (_id, n) => { if (n <= 25) time.t += 2; });
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    clock.stop();
    const runs = stretches([...seen.values()]);
    expect(sum(runs)).toBe(120);
    expect(runs[0]).toBeGreaterThanOrEqual(24);
    expect(runs[0]).toBeLessThanOrEqual(26);
    expect(runs[1]).toBe(50);
  });
});
