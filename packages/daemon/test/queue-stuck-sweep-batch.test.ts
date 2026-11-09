// The stuck sweep reads recovery rows and linked successors in batches, and yields the event loop as it goes,
// instead of one json_each scan per candidate and per custody row with the loop held for the whole pass.
// Each batched lookup must answer exactly what the per-row query answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, createLinkedSuccessorLookup, hasLinkedSuccessor } from "../src/domain/queue-repository.js";
import { createRecoveryLookup, findQueueRecovery, recoveryTag } from "../src/domain/queue-recovery.js";
import { runStuckSweep, STUCK_SWEEP_YIELD_EVERY_ROWS } from "../src/domain/queue-stuck-sweep.js";

let db: Database.Database;
let repo: QueueRepository;
const at = "2026-10-09T10:00:00.000Z";

function row(id: string, o: { state?: string; tags?: string | null; updated?: string; destination?: string | null;
  handedOffFrom?: string | null; chain?: string | null; closureReason?: string | null; closureTarget?: string | null } = {}) {
  db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,
      handed_off_from,chain_of_record,closure_reason,closure_target)
    VALUES (?, ?, ?, 'sender@r', ?, ?, ?, 'body', ?, ?, ?, ?)`).run(id, at, o.updated ?? at, o.destination === undefined ? "worker@r" : o.destination,
    o.state ?? "done", o.tags === undefined ? "[]" : o.tags, o.handedOffFrom ?? null, o.chain ?? null, o.closureReason ?? null, o.closureTarget ?? null);
}

/** Counts how often a statement whose text satisfies `match` is prepared while `run` executes. */
async function countPrepared(match: (sql: string) => boolean, run: () => unknown): Promise<number> {
  const prepare = db.prepare.bind(db); let n = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => { if (match(sql)) n++; return prepare(sql); });
  try { await run(); } finally { spy.mockRestore(); }
  return n;
}
const perRowRecovery = (sql: string) => sql.includes("json_each(tags) WHERE value = ?") && sql.includes("qitem_id DESC LIMIT 1");
const perRowSuccessor = (sql: string) => sql.includes("s.qitem_id = ? OR s.destination_session = ?");

beforeEach(() => {
  db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("createRecoveryLookup: the recovery index held by its caller", () => {
  it("chooses the same recovery row as findQueueRecovery, for every ordering and excludeTag case", () => {
    for (const id of ["qitem-a", "qitem-b", "qitem-c", "qitem-d"]) row(id, { state: "pending" });
    row("rec-a1", { tags: JSON.stringify([recoveryTag("qitem-a")]), updated: "2026-10-09T12:00:00.000Z" });
    row("rec-a2", { state: "in-progress", tags: JSON.stringify([recoveryTag("qitem-a")]), updated: "2026-10-09T11:00:00.000Z" });
    row("rec-b1", { tags: JSON.stringify([recoveryTag("qitem-b")]), updated: "2026-10-09T11:00:00.000Z" });
    row("rec-b2", { tags: JSON.stringify([recoveryTag("qitem-b")]), updated: "2026-10-09T13:00:00.000Z" });
    row("rec-c1", { state: "blocked", tags: JSON.stringify([recoveryTag("qitem-c"), "prompt-alert"]), updated: "2026-10-09T14:00:00.000Z" });
    row("rec-c2", { state: "blocked", tags: JSON.stringify([recoveryTag("qitem-c")]), updated: "2026-10-09T12:00:00.000Z" });
    row("rec-d1", { state: "pending", tags: `["recovery-for:qitem-\\u0064"]`, updated: "2026-10-09T12:00:00.000Z" });
    row("rec-d2", { state: "pending", tags: JSON.stringify({ k: recoveryTag("qitem-d") }), updated: "2026-10-09T13:00:00.000Z" });
    row("rec-x", { state: "pending", tags: "not json", updated: "2026-10-09T15:00:00.000Z" });
    const asks: Array<[string, string | undefined]> = ["qitem-a", "qitem-b", "qitem-c", "qitem-d", "qitem-e"]
      .flatMap((id) => [undefined, "prompt-alert", ""].map((ex) => [id, ex] as [string, string | undefined]));
    const lookup = createRecoveryLookup(db);
    expect(asks.map(([id, ex]) => lookup.find(id, ex))).toEqual(asks.map(([id, ex]) => findQueueRecovery(db, id, ex)));
  });

  it("builds once until invalidated, and a rebuild sees what changed", async () => {
    row("qitem-n", { state: "pending" });
    const lookup = createRecoveryLookup(db);
    expect(lookup.find("qitem-n")).toBeNull();
    row("rec-n", { state: "pending", tags: JSON.stringify([recoveryTag("qitem-n")]) });
    expect(lookup.find("qitem-n")).toBeNull(); // the index is a snapshot until invalidated
    lookup.invalidate();
    expect(lookup.find("qitem-n")?.qitemId).toBe("rec-n");
    expect(await countPrepared(perRowRecovery, () => { for (let i = 0; i < 20; i++) lookup.find(`qitem-${i}`); })).toBe(0);
  });
});

describe("createLinkedSuccessorLookup: the linked successors of a set of sources", () => {
  it("answers exactly what hasLinkedSuccessor answers", () => {
    row("src-1"); row("src-2"); row("src-3"); row("src-4");
    row("s-h", { handedOffFrom: "src-1", destination: "seat-a@r" });                           // linked by handed_off_from
    row("s-c", { chain: JSON.stringify(["x", "src-2"]), destination: "seat-b@r" });              // linked by chain_of_record
    row("s-num", { chain: "[7, 8]", destination: "seat-c@r" });                                  // non-text chain members
    row("s-bad", { chain: "not json", destination: "seat-c@r" });                                // invalid chain
    row("s-obj", { chain: JSON.stringify({ k: "src-3" }), destination: "seat-d@r" });            // object-shaped chain
    row("s-empty", { handedOffFrom: "src-4", destination: "" });                                 // empty destination
    row("src-self", { handedOffFrom: "src-self", destination: "seat-e@r" });                     // a row is not its own successor
    const sources = ["src-1", "src-2", "src-3", "src-4", "src-self", "7", "missing"];
    const targets = ["seat-a@r", "seat-b@r", "seat-c@r", "seat-d@r", "seat-e@r", "s-h", "s-c", "s-empty", "src-self", "SEAT-A@R", ""];
    const lookup = createLinkedSuccessorLookup(db, sources);
    for (const s of sources) for (const t of targets) {
      expect([s, t, lookup.has(s, t)]).toEqual([s, t, hasLinkedSuccessor(db, s, t)]);
    }
    expect(lookup.has("src-1", "seat-a@r")).toBe(true);
    expect(lookup.has("src-2", "s-c")).toBe(true);
    expect(lookup.has("src-3", "seat-d@r")).toBe(true);
    expect(lookup.has("src-self", "seat-e@r")).toBe(false);
  });

  it("is a snapshot until invalidated", () => {
    row("src-1");
    const lookup = createLinkedSuccessorLookup(db, ["src-1"]);
    expect(lookup.has("src-1", "seat-a@r")).toBe(false);
    row("s-late", { handedOffFrom: "src-1", destination: "seat-a@r" });
    expect(lookup.has("src-1", "seat-a@r")).toBe(false);
    lookup.invalidate();
    expect(lookup.has("src-1", "seat-a@r")).toBe(true);
  });
});

describe("runStuckSweep: batched reads and a yielding loop", () => {
  const recent = () => new Date(Date.now() - 5 * 60_000).toISOString();
  function custodyRows(n: number) {
    // terminal rows closed onto a seat with no linked successor: each is a dangling-closure candidate
    for (let i = 0; i < n; i++) {
      row(`qitem-c${String(i).padStart(4, "0")}`, { state: "done", updated: recent(), closureReason: "handed_off_to", closureTarget: `seat-${i % 7}@r` });
    }
  }

  it("runs the per-row recovery or successor query only to re-check a finding it is about to create", async () => {
    custodyRows(130);
    // first pass: the custody loop reads successors in one batch; each of the 130 new findings re-checks its own
    // source live right before the create, without the batch index (a rebuild scans every chain_of_record): the row's
    // own handoff advisory and the rule's target check, two indexed point queries per finding created, none per row scanned
    let first: Awaited<ReturnType<typeof runStuckSweep>> | undefined;
    expect(await countPrepared(perRowSuccessor, async () => { first = await runStuckSweep({ db, queueRepo: repo, log: () => {} }); })).toBe(2 * 130);
    expect(first?.findings.filter((f) => f.action === "created")).toHaveLength(130);
    // steady pass (the usual one): the routing loop finds each open finding through the batched recovery index.
    // (A create re-reads its own new row, which can ask for that row's recovery; a steady pass creates nothing.)
    let second: Awaited<ReturnType<typeof runStuckSweep>> | undefined;
    const recoveryQueries = await countPrepared(perRowRecovery, async () => {
      expect(await countPrepared(perRowSuccessor, async () => { second = await runStuckSweep({ db, queueRepo: repo, log: () => {} }); })).toBe(0);
    });
    expect(recoveryQueries).toBe(0);
    expect(second?.findings.filter((f) => f.action === "refreshed")).toHaveLength(130);
  });

  it("finds the same thing on a second pass: the open findings are refreshed, not duplicated", async () => {
    custodyRows(60);
    const first = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const second = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(first.findings.filter((f) => f.action === "created")).toHaveLength(60);
    expect(second.findings.filter((f) => f.action === "created")).toHaveLength(0);
    expect(second.findings.filter((f) => f.action === "refreshed")).toHaveLength(60);
  });

  it("lets no other code run between two rows it reads from one snapshot", async () => {
    // A queued microtask (another request's continuation) that inserts a successor must not run between two custody
    // rows unless the pass really yields, because the batched successor read would not see it.
    custodyRows(10);
    const getById = repo.getById.bind(repo);
    const seen: string[] = []; let microtaskRan = false; let ranBeforeSecondRow: boolean | undefined;
    vi.spyOn(repo, "getById").mockImplementation((id: string) => {
      if (id.startsWith("qitem-c") && !seen.includes(id)) {
        seen.push(id);
        if (seen.length === 1) queueMicrotask(() => { microtaskRan = true; row("s-late", { handedOffFrom: "qitem-c0001", destination: "seat-1@r" }); });
        if (seen.length === 2) ranBeforeSecondRow = microtaskRan;
      }
      return getById(id);
    });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(ranBeforeSecondRow).toBe(false);
    expect(microtaskRan).toBe(true);
    // the successor landed after c0001 was found stuck, and before its finding: the re-check before the create sees it
    expect(result.findings.filter((f) => f.action === "created")).toHaveLength(9);
  });

  const old = () => new Date(Date.now() - 3 * 3600_000).toISOString();
  function unclaimedRows(n: number): string[] {
    const ids = Array.from({ length: n }, (_, i) => `qitem-u${String(i).padStart(4, "0")}`);
    for (const id of ids) row(id, { state: "pending", updated: old() });
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id LIKE 'qitem-u%'").run(old());
    return ids;
  }
  /** Runs `during` at the first real yield of the pass: scheduled on the first read of a matching row. */
  function atFirstYield(match: (id: string) => boolean, during: (firstId: string) => void) {
    const getById = repo.getById.bind(repo); let scheduled = false;
    vi.spyOn(repo, "getById").mockImplementation((id: string) => {
      if (!scheduled && match(id)) { scheduled = true; setImmediate(() => during(id)); }
      return getById(id);
    });
  }

  it("re-checks a listed row after a yield: a row claimed meanwhile is not reported unclaimed", async () => {
    const ids = unclaimedRows(120);
    const last = ids[ids.length - 1]!;
    atFirstYield((id) => id.startsWith("qitem-u"), () => { repo.claim({ qitemId: last, destinationSession: "worker@r" }); });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(repo.getById(last)?.state).toBe("in-progress");
    expect(result.findings.filter((f) => f.qitemId === last && f.action === "created")).toEqual([]);
    expect(result.findings.filter((f) => f.action === "created")).toHaveLength(119);
  });

  it("makes no new finding from a read the row has since moved past", async () => {
    unclaimedRows(120);
    let found: string | undefined;
    // the first row read is found stuck before the first yield, and claimed during it
    atFirstYield((id) => id.startsWith("qitem-u"), (id) => { found = id; repo.claim({ qitemId: id, destinationSession: "worker@r" }); });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(found).toBeDefined();
    expect(result.findings.filter((f) => f.qitemId === found && f.action === "created")).toEqual([]);
    expect(result.findings.filter((f) => f.action === "created")).toHaveLength(119);
  });

  it("leaves to the next pass an undelivered row that was claimed while its wake retry was awaited", async () => {
    row("qitem-w0001", { state: "pending", updated: old() });
    db.prepare("UPDATE queue_items SET ts_created = ?, last_nudge_result = 'unroutable:no-pane' WHERE qitem_id = 'qitem-w0001'").run(old());
    vi.spyOn(repo, "classifyDestinationOf").mockReturnValue({ class: "pane-bound" } as ReturnType<typeof repo.classifyDestinationOf>);
    const deliver = vi.spyOn(repo, "deliverWakeForSuccessor").mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      repo.claim({ qitemId: "qitem-w0001", destinationSession: "worker@r" }); // the seat claims while the send is in flight
    });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(repo.getById("qitem-w0001")?.state).toBe("in-progress");
    expect(result.findings.filter((f) => f.qitemId === "qitem-w0001" && f.action === "created")).toEqual([]);
  });

  it("never retries the wake of a row the earlier checks exclude (a claim supersedes the failed wake)", async () => {
    row("qitem-w0002", { state: "pending", updated: old() });
    db.prepare(`UPDATE queue_items SET ts_created = ?, claimed_at = ?, last_nudge_result = 'unroutable:no-pane'
      WHERE qitem_id = 'qitem-w0002'`).run(old(), old());
    vi.spyOn(repo, "classifyDestinationOf").mockReturnValue({ class: "pane-bound" } as ReturnType<typeof repo.classifyDestinationOf>);
    const deliver = vi.spyOn(repo, "deliverWakeForSuccessor").mockImplementation(async () => {});
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not close a finding whose row came back during the pass (blocked at the listing, overdue again by the resolution)", async () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,claimed_at,closure_required_at,last_heartbeat)
      VALUES ('qitem-x0001', ?, ?, 'sender@r', 'worker@r', 'in-progress', '[]', 'b', ?, ?, ?)`).run(old, recent, old, past, recent);
    const first = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const finding = first.findings.find((f) => f.qitemId === "qitem-x0001" && f.action === "created");
    expect(finding?.kind).toBe("overdue-claim");
    // the owner parks it before the next pass lists the overdue rows, and resumes it during that pass
    db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = 'qitem-x0001'").run();
    const now = new Date().toISOString();
    for (let i = 0; i < 60; i++) { // claimed and active: listed and passed over, long enough for a yield before the resolution
      db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,claimed_at,last_heartbeat)
        VALUES (?, ?, ?, 'sender@r', 'worker@r', 'in-progress', '[]', 'b', ?, ?)`).run(`qitem-k${String(i).padStart(4, "0")}`, now, now, now, now);
    }
    setImmediate(() => db.prepare("UPDATE queue_items SET state = 'in-progress' WHERE qitem_id = 'qitem-x0001'").run());
    const second = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(repo.getById("qitem-x0001")?.state).toBe("in-progress");
    expect(second.findings.filter((f) => f.qitemId === "qitem-x0001" && f.action === "closed")).toEqual([]);
    expect(repo.getById(finding!.findingQitemId)?.state).not.toBe("done");
  });

  it("re-checks a burst of custody findings without rebuilding the successor index for each one", async () => {
    custodyRows(60);
    const buildSql = (sql: string) => sql.includes("s.handed_off_from IN (SELECT value FROM json_each(?))");
    let result: Awaited<ReturnType<typeof runStuckSweep>> | undefined;
    const builds = await countPrepared(buildSql, async () => { result = await runStuckSweep({ db, queueRepo: repo, log: () => {} }); });
    expect(result!.findings.filter((f) => f.action === "created")).toHaveLength(60);
    // one build for the custody loop and one after each of its yields; none per finding created
    expect(builds).toBeLessThanOrEqual(1 + Math.ceil(60 / STUCK_SWEEP_YIELD_EVERY_ROWS));
  });

  it("does not fail the pass when a finding's owner closes it while the resolution loop yields", async () => {
    custodyRows(60);
    expect((await runStuckSweep({ db, queueRepo: repo, log: () => {} })).findings.filter((f) => f.action === "created")).toHaveLength(60);
    for (let i = 0; i < 60; i++) {
      row(`s-${i}`, { handedOffFrom: `qitem-c${String(i).padStart(4, "0")}`, destination: `seat-${i % 7}@r` });
    }
    // the first resolution schedules the owners closing every other open finding, at the loop's next yield
    const update = repo.update.bind(repo); let scheduled = false;
    vi.spyOn(repo, "update").mockImplementation((input: Parameters<typeof repo.update>[0]) => {
      if (!scheduled && input.actorSession === "stuck-sweep@system") {
        scheduled = true;
        setImmediate(() => db.prepare(`UPDATE queue_items SET state = 'done', closure_reason = 'no-follow-on'
          WHERE tags LIKE '%"stuck-sweep-finding"%' AND state IN ('pending', 'in-progress', 'blocked')`).run());
      }
      return update(input);
    });
    const logs: string[] = [];
    const second = await runStuckSweep({ db, queueRepo: repo, log: (l) => logs.push(l) });
    expect(scheduled).toBe(true);
    expect(second.outcome).not.toBe("failed");
    const closed = second.findings.filter((f) => f.action === "closed").length;
    expect(closed).toBeGreaterThan(0);
    expect(closed).toBeLessThan(60);
  });

  it("drops its indexes at every yield, and creates nothing for a source whose successor landed during the pass", async () => {
    custodyRows(120);
    setImmediate(() => {
      for (let i = 0; i < 120; i++) row(`s-${i}`, { handedOffFrom: `qitem-c${String(i).padStart(4, "0")}`, destination: `seat-${i % 7}@r` });
    });
    let result: Awaited<ReturnType<typeof runStuckSweep>> | undefined;
    // the rows read after the first yield see the new successors in the rebuilt index and are never candidates; the
    // ones read before it are candidates, and their rule, run again before the create, now finds the successor
    const recheckedLive = await countPrepared(perRowSuccessor, async () => { result = await runStuckSweep({ db, queueRepo: repo, log: () => {} }); });
    expect(result!.findings.filter((f) => f.action === "created")).toEqual([]);
    expect(recheckedLive).toBeGreaterThan(0);
    expect(recheckedLive).toBeLessThanOrEqual(2 * STUCK_SWEEP_YIELD_EVERY_ROWS); // two point queries per re-check
  });

  function failedWakeRows(n: number, ageMs: number): string[] {
    const at = new Date(Date.now() - ageMs).toISOString();
    const ids = Array.from({ length: n }, (_, i) => `qitem-a${String(i).padStart(4, "0")}`);
    for (const id of ids) {
      db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,last_nudge_attempt,last_nudge_result)
        VALUES (?, ?, ?, 'sender@r', 'worker@r', 'pending', '[]', 'b', ?, 'failed:probe')`).run(id, at, at, at);
    }
    return ids;
  }

  it("judges a failed wake that was delivered during the pass by its new result (before or after the yield)", async () => {
    // younger than the unclaimed age, so undelivered-wake is the only rule that applies
    const ids = failedWakeRows(120, 30 * 60_000);
    const first = ids[0]!; const last = ids[ids.length - 1]!;
    // the wake result changes without touching state or ts_updated
    setImmediate(() => { repo.recordNudgeAttempt(first, "ok"); repo.recordNudgeAttempt(last, "ok"); });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const created = result.findings.filter((f) => f.action === "created");
    expect(created.filter((f) => f.qitemId === first || f.qitemId === last)).toEqual([]);
    expect(created).toHaveLength(118);
  });

  it("judges an overdue claim whose deadline moved during the pass by its new deadline (before or after the yield)", async () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    const ids = Array.from({ length: 120 }, (_, i) => `qitem-b${String(i).padStart(4, "0")}`);
    for (const id of ids) {
      db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,claimed_at,closure_required_at,last_heartbeat)
        VALUES (?, ?, ?, 'sender@r', 'worker@r', 'in-progress', '[]', 'b', ?, ?, ?)`).run(id, old, recent, old, past, recent);
    }
    const first = ids[0]!; const last = ids[ids.length - 1]!;
    const future = new Date(Date.now() + 6 * 3600_000).toISOString();
    setImmediate(() => {
      repo.update({ qitemId: first, actorSession: "worker@r", closureRequiredAt: future });
      repo.update({ qitemId: last, actorSession: "worker@r", closureRequiredAt: future });
    });
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const created = result.findings.filter((f) => f.action === "created");
    expect(created.filter((f) => f.qitemId === first || f.qitemId === last)).toEqual([]);
    expect(created.filter((f) => f.kind === "overdue-claim")).toHaveLength(118);
  });

  /** Overdue in-progress rows, owner active (no stalled rule): `ids` in order of their deadlines, earliest first. */
  function overdueRows(ids: string[]) {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    ids.forEach((id, i) => db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,claimed_at,closure_required_at,last_heartbeat)
      VALUES (?, ?, ?, 'sender@r', 'worker@r', 'in-progress', '[]', 'b', ?, ?, ?)`)
      .run(id, old, recent, old, new Date(Date.now() - 3 * 3600_000 + i * 1000).toISOString(), recent));
  }
  /** An open finding of the sweep for `stuckId`, as an earlier pass left it. */
  function openFinding(id: string, kind: string, stuckId: string, updated: string) {
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,summary)
      VALUES (?, ?, ?, 'sender@r', 'worker@r', 'pending', ?, 'Stuck sweep finding', ?)`)
      .run(id, updated, updated, JSON.stringify(["stuck-sweep-finding", `stuck-sweep:${kind}:${stuckId}`, recoveryTag(stuckId)]),
        `Stuck sweep: ${kind} on ${stuckId} (120 min)`);
  }
  const stateOf = (id: string) => (db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(id) as { state: string }).state;

  it("closes its own finding for a row it found, once a newer recovery of another author holds that row (as the base does)", async () => {
    overdueRows(["qitem-x0001"]);
    const before = new Date(Date.now() - 30 * 60_000).toISOString();
    openFinding("qitem-f0001", "overdue-claim", "qitem-x0001", before);
    // a newer open recovery for the same row, not the sweep's (a wake-ladder escalation, say): it now holds custody
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body)
      VALUES ('qitem-r0001', ?, ?, 'ladder@r', 'worker@r', 'pending', ?, 'escalation')`)
      .run(new Date().toISOString(), new Date().toISOString(), JSON.stringify([recoveryTag("qitem-x0001")]));
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(result.findings.filter((f) => f.findingQitemId === "qitem-f0001").map((f) => f.action)).toEqual(["closed"]);
    expect(stateOf("qitem-f0001")).toBe("done");
    expect(stateOf("qitem-r0001")).toBe("pending");
  });

  it("addresses a new finding to the row's destination as it is when the finding is made, not as it was listed", async () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    for (let i = 0; i < 120; i++) {
      db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body)
        VALUES (?, ?, ?, 'sender@r', 'old@r', 'pending', '[]', 'b')`).run(`qitem-${i}`, old, old);
    }
    // read before the first yield, and handed to another seat during it
    setImmediate(() => db.prepare("UPDATE queue_items SET destination_session = 'new@r' WHERE qitem_id = 'qitem-0'").run());
    const result = await runStuckSweep({ db, queueRepo: repo, now: new Date(), resolveOrchestrator: () => null, log: () => {} });
    const created = result.findings.find((f) => f.qitemId === "qitem-0" && f.action === "created");
    expect(created).toBeDefined();
    expect(repo.getById(created!.findingQitemId)?.destinationSession).toBe("new@r");
  });

  it("closes the finding of an overdue row that was closed during the pass, before the overdue loop reached it", async () => {
    const fillers = Array.from({ length: 120 }, (_, i) => `qitem-o${String(i).padStart(4, "0")}`);
    overdueRows([...fillers, "qitem-z0001"]); // the last row the overdue loop reads, after its first yield
    openFinding("qitem-f0002", "overdue-claim", "qitem-z0001", new Date(Date.now() - 60_000).toISOString());
    setImmediate(() => db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'no-follow-on' WHERE qitem_id = 'qitem-z0001'").run());
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(result.findings.filter((f) => f.qitemId === "qitem-z0001").map((f) => f.action)).toEqual(["closed"]);
    expect(stateOf("qitem-f0002")).toBe("done");
  });

  it("does not retry the wake of a row that was claimed while an earlier row's wake retry was awaited", async () => {
    for (const id of ["qitem-w0003", "qitem-w0004"]) {
      row(id, { state: "pending", updated: old() });
      db.prepare("UPDATE queue_items SET ts_created = ?, last_nudge_result = 'unroutable:no-pane' WHERE qitem_id = ?").run(old(), id);
    }
    vi.spyOn(repo, "classifyDestinationOf").mockReturnValue({ class: "pane-bound" } as ReturnType<typeof repo.classifyDestinationOf>);
    const woken: string[] = [];
    const deliver = vi.spyOn(repo, "deliverWakeForSuccessor").mockImplementation(async (qitemId: string) => {
      woken.push(qitemId);
      // the other row's seat claims it while this send is in flight
      if (woken.length === 1) repo.claim({ qitemId: qitemId === "qitem-w0003" ? "qitem-w0004" : "qitem-w0003", destinationSession: "worker@r" });
    });
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared finding's reason when the new reason stopped holding during the pass", async () => {
    const fillers = Array.from({ length: 120 }, (_, i) => `qitem-p${String(i).padStart(4, "0")}`);
    overdueRows(["qitem-y0001", ...fillers]); // the first row the overdue loop reads, before its first yield
    openFinding("qitem-f0003", "stalled-after-claim", "qitem-y0001", new Date(Date.now() - 60_000).toISOString());
    const future = new Date(Date.now() + 6 * 3600_000).toISOString();
    setImmediate(() => { repo.update({ qitemId: "qitem-y0001", actorSession: "worker@r", closureRequiredAt: future }); });
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const finding = repo.getById("qitem-f0003");
    expect(finding?.state).toBe("pending");
    expect(finding?.summary).toMatch(/^Stuck sweep: stalled-after-claim on qitem-y0001/);
  });

  it("yields the event loop during a long pass, so other work runs before it ends", async () => {
    custodyRows(200);
    let ticks = 0; let done = false;
    const spin = () => { if (done) return; ticks++; setImmediate(spin); };
    setImmediate(spin);
    await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    done = true;
    // 200 custody rows and 200 routed candidates at one yield per 50 rows: several turns of the loop ran inside
    expect(ticks).toBeGreaterThanOrEqual(4);
  });
});
