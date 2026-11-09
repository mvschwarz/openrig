// One stuck-sweep pass builds its recovery and successor indexes once, puts its own writes into them, confirms live
// what it writes on, keeps every synchronous stretch short, and records itself as one slow-op span.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { createRecoveryLookup, findQueueRecovery, RECOVERY_INDEX_SQL, recoveryId, recoveryTag } from "../src/domain/queue-recovery.js";
import { createPassRoutes, runStuckSweep, STUCK_SWEEP_PASS_SITE, STUCK_SWEEP_SLICE_BUDGET_MS, STUCK_SWEEP_SLICE_RECORD_MS, STUCK_SWEEP_SLICE_SITE, type StuckSweepPassStats } from "../src/domain/queue-stuck-sweep.js";
import { SlowOpRecorder } from "../src/domain/slow-op-recorder.js";
import { configureSyncSiteRecorder } from "../src/domain/sync-site-wrap.js";

let db: Database.Database;
let repo: QueueRepository;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

beforeEach(() => {
  db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

function insert(id: string, o: Record<string, string | null>) {
  const cols = { ts_created: iso(3 * 60 * MIN), ts_updated: iso(MIN), source_session: "sender@r", destination_session: "worker@r",
    state: "pending", tags: "[]", body: "b", ...o };
  db.prepare(`INSERT INTO queue_items(qitem_id, ${Object.keys(cols).join(", ")}) VALUES (?, ${Object.keys(cols).map(() => "?").join(", ")})`)
    .run(id, ...Object.values(cols));
}
/** Terminal rows closed onto a seat with no linked successor: each is a dangling-closure candidate. */
function custodyRows(n: number) {
  for (let i = 0; i < n; i++) {
    insert(`qitem-c${String(i).padStart(4, "0")}`, { state: "done", ts_updated: iso(5 * MIN), closure_reason: "handed_off_to", closure_target: `seat-${i % 7}@r` });
  }
}
/** Overdue claims whose owner is active (a recent heartbeat: no stalled rule). */
function overdueRow(id: string, deadline = iso(2 * 60 * MIN)) {
  insert(id, { state: "in-progress", claimed_at: iso(3 * 60 * MIN), closure_required_at: deadline, last_heartbeat: iso(MIN) });
}
/** A pending row whose wake was recorded unroutable before its pane was bound: the pass retries its wake. */
function unroutableRow(id: string) {
  insert(id, { last_nudge_result: "unroutable:no-pane", ts_updated: iso(3 * 60 * MIN) });
}
function finding(id: string, kind: string, stuckId: string, state: string, updated: string) {
  insert(id, { state, ts_created: updated, ts_updated: updated, summary: `Stuck sweep: ${kind} on ${stuckId} (90 min)`,
    tags: JSON.stringify(["stuck-sweep-finding", `stuck-sweep:${kind}:${stuckId}`, recoveryTag(stuckId)]) });
}
/** The sweep's findings of any kind for a row. */
const anyFindingRows = (stuckId: string) => db.prepare("SELECT qitem_id, state FROM queue_items WHERE tags LIKE '%\"stuck-sweep-finding\"%' AND tags LIKE ?")
  .all(`%"stuck-sweep:%:${stuckId}"%`) as Array<{ qitem_id: string; state: string }>;
const findingRows = (kind: string, stuckId: string) => db.prepare("SELECT qitem_id, state FROM queue_items WHERE tags LIKE ?")
  .all(`%"stuck-sweep:${kind}:${stuckId}"%`) as Array<{ qitem_id: string; state: string }>;

/** The pass's slow-op span, as a recorder would get it. */
function spanCatcher() {
  const begins: string[] = [];
  const ends: Array<{ site: string; outcome: string } & Partial<StuckSweepPassStats>> = [];
  const slices: Array<{ site: string; durationMs: number } & Record<string, number | string>> = [];
  return { begins, ends, slices, slowOps: { beginStage: (site: string) => { begins.push(site);
    return { end: (outcome: "ok" | "failed", fields?: Record<string, number | string>) => { ends.push({ site, outcome, ...fields }); },
      slice: (sliceSite: string, durationMs: number, fields?: Record<string, number | string>) => {
        slices.push({ ...fields, site: sliceSite, durationMs }); } }; } } };
}
/** Holds the loop for `ms` synchronously. */
function busy(ms: number) { const until = performance.now() + ms; while (performance.now() < until) { /* hold the loop */ } }
async function countPrepared(match: (sql: string) => boolean, run: () => Promise<unknown>): Promise<number> {
  const prepare = db.prepare.bind(db); let n = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => { if (match(sql)) n++; return prepare(sql); });
  try { await run(); } finally { spy.mockRestore(); }
  return n;
}
/** Holds the first wake retry of the pass until release(), running `during` while it is held. */
function holdFirstWake(during: () => void = () => {}) {
  vi.spyOn(repo, "classifyDestinationOf").mockReturnValue({ class: "pane-bound" } as ReturnType<typeof repo.classifyDestinationOf>);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const state = { calls: 0, release: () => release() };
  vi.spyOn(repo, "deliverWakeForSuccessor").mockImplementation(async () => {
    if (++state.calls === 1) { during(); await held; }
  });
  return state;
}
async function until(cond: () => boolean) {
  for (let i = 0; i < 5000 && !cond(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(cond()).toBe(true);
}

describe("createRecoveryLookup.note: the caller's own write, put into the index without a rebuild", () => {
  it("answers what findQueueRecovery answers after a create and after a close, with one build", async () => {
    insert("qitem-a", { state: "in-progress" });
    insert("rec-old", { state: "done", ts_updated: iso(30 * MIN), tags: JSON.stringify([recoveryTag("qitem-a")]) });
    insert("rec-other", { state: "pending", ts_updated: iso(20 * MIN), tags: JSON.stringify([recoveryTag("qitem-b"), "x"]) });
    const lookup = createRecoveryLookup(db);
    expect(lookup.find("qitem-a")).toEqual(findQueueRecovery(db, "qitem-a"));
    const created = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "f",
      tags: ["stuck-sweep-finding", recoveryTag("qitem-a"), recoveryTag("qitem-b")] });
    lookup.note(created);
    for (const id of ["qitem-a", "qitem-b"]) expect(lookup.find(id)).toEqual(findQueueRecovery(db, id));
    expect(lookup.find("qitem-a")?.qitemId).toBe(created.qitemId);
    const closed = repo.update({ qitemId: created.qitemId, actorSession: "stuck-sweep@system", state: "done", closureReason: "no-follow-on" });
    lookup.note(closed);
    for (const id of ["qitem-a", "qitem-b"]) expect(lookup.find(id)).toEqual(findQueueRecovery(db, id));
    expect(lookup.find("qitem-b")?.qitemId).toBe("rec-other"); // the open one comes first again
    expect(lookup.builds).toBe(1);
  });
});

describe("createRecoveryLookup: excludeTag after byTag keeps only recovery tags", () => {
  it("answers find(id, excludeTag) as findQueueRecovery does, for a recovery tag, a finding tag and any other tag", async () => {
    insert("qitem-a", { state: "in-progress" });
    insert("rec-1", { state: "pending", ts_updated: iso(30 * MIN), tags: JSON.stringify(["stuck-sweep-finding", "stuck-sweep:overdue-claim:qitem-a", recoveryTag("qitem-a")]) });
    insert("rec-2", { state: "done", ts_updated: iso(20 * MIN), tags: JSON.stringify(["slack-undeliverable", recoveryTag("qitem-a")]) });
    const lookup = createRecoveryLookup(db);
    const created = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "f",
      tags: ["prompt-alert", recoveryTag("qitem-a")] });
    lookup.note(created);
    for (const exclude of [undefined, "stuck-sweep-finding", "stuck-sweep:overdue-claim:qitem-a", "slack-undeliverable", "prompt-alert", recoveryTag("qitem-a"), "absent"]) {
      expect(lookup.find("qitem-a", exclude), String(exclude)).toEqual(findQueueRecovery(db, "qitem-a", exclude));
    }
  });
});

describe("runStuckSweep: one index per pass", () => {
  it("reads the recovery index and the successor index once per pass, however many times it yields and writes", async () => {
    custodyRows(130);
    for (let i = 0; i < 120; i++) insert(`qitem-u${String(i).padStart(4, "0")}`, { ts_updated: iso(3 * 60 * MIN) }); // unclaimed
    const isIndex = (sql: string) => sql === RECOVERY_INDEX_SQL;
    const isSuccessors = (sql: string) => sql.includes("s.handed_off_from IN (SELECT value FROM json_each(?))");
    for (const expected of [{ created: 250, refreshed: 0 }, { created: 0, refreshed: 250 }]) {
      const span = spanCatcher();
      let result: Awaited<ReturnType<typeof runStuckSweep>> | undefined;
      let successorBuilds = 0;
      const indexBuilds = await countPrepared(isIndex, async () => {
        successorBuilds = await countPrepared(isSuccessors, async () => {
          result = await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null, slowOps: span.slowOps });
        });
      });
      expect(result!.findings.filter((f) => f.action === "created")).toHaveLength(expected.created);
      expect(result!.findings.filter((f) => f.action === "refreshed")).toHaveLength(expected.refreshed);
      expect(span.ends[0]!.yields).toBeGreaterThanOrEqual(5);
      expect(indexBuilds).toBe(1);
      expect(span.ends[0]!.recoveryIndexBuilds).toBe(1);
      expect(successorBuilds).toBe(1);
    }
  });
});

describe("runStuckSweep: the pass's slow-op span", () => {
  it("records one stuck_sweep.pass span, its end carrying the pass's counts and its longest synchronous slice", async () => {
    custodyRows(130);
    const span = spanCatcher();
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {}, slowOps: span.slowOps });
    expect(span.begins).toEqual([STUCK_SWEEP_PASS_SITE]);
    expect(span.ends).toHaveLength(1);
    const end = span.ends[0]!;
    expect(end).toMatchObject({ site: "stuck_sweep.pass", outcome: "ok", rowsScanned: 130, findingsCreated: 130, findingsRefreshed: 0,
      findingsClosed: 0, recoveryIndexBuilds: 1 });
    expect(result.findings.filter((f) => f.action === "created")).toHaveLength(130);
    expect(end.yields).toBeGreaterThan(0);
    expect(end.maxSliceMs).toBeGreaterThan(0);
    expect(typeof end.maxSlicePhase).toBe("string");
  });

  it("keeps each synchronous slice of a pass near the slice budget, not the length of the queue", async () => {
    custodyRows(400);
    const span = spanCatcher();
    const started = performance.now();
    await runStuckSweep({ db, queueRepo: repo, log: () => {}, slowOps: span.slowOps });
    const passMs = performance.now() - started;
    const end = span.ends[0]!;
    expect(end.yields).toBeGreaterThanOrEqual(8); // at least one per 50 rows, in the custody loop and the findings loop
    // a slice ends at the first row past the budget: one row (a create at most) over it, never the whole pass
    expect(end.maxSliceMs!).toBeLessThan(Math.max(STUCK_SWEEP_SLICE_BUDGET_MS * 8, passMs / 4));
  });

  it("ends the span as failed when the pass fails", async () => {
    custodyRows(3);
    vi.spyOn(repo, "findOverdueIds").mockImplementation(() => { throw new Error("disk I/O error"); });
    const span = spanCatcher();
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {}, slowOps: span.slowOps });
    expect(result.outcome).toBe("failed");
    expect(span.ends).toEqual([expect.objectContaining({ site: STUCK_SWEEP_PASS_SITE, outcome: "failed" })]);
  });

  it("records a slice that held the loop past STUCK_SWEEP_SLICE_RECORD_MS, with its phases, and no shorter one", async () => {
    custodyRows(3);
    const listOverdue = repo.findOverdueIds.bind(repo);
    vi.spyOn(repo, "findOverdueIds").mockImplementation((...args) => { busy(STUCK_SWEEP_SLICE_RECORD_MS + 30); return listOverdue(...args); });
    const span = spanCatcher();
    await runStuckSweep({ db, queueRepo: repo, log: () => {}, slowOps: span.slowOps });
    expect(span.slices).toHaveLength(1);
    expect(span.slices[0]).toMatchObject({ site: STUCK_SWEEP_SLICE_SITE, fromPhase: "start" });
    expect(String(span.slices[0]!.phases).split(",").slice(0, 2)).toEqual(["start", "overdue"]);
    expect(span.slices[0]!.durationMs).toBeGreaterThanOrEqual(STUCK_SWEEP_SLICE_RECORD_MS + 30);
    expect(typeof span.slices[0]!.phase).toBe("string");
    expect(span.ends[0]!.maxSliceMs).toBeGreaterThanOrEqual(STUCK_SWEEP_SLICE_RECORD_MS + 30);
  });

  it("goes to the daemon's configured recorder by default: the pass as an end record only (it yields, so it is not a span "
    + "that holds the loop), and a long slice as a closed begin/end pair over exactly its own interval", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-sweep-span-"));
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new SlowOpRecorder({ logPath });
    configureSyncSiteRecorder(recorder);
    try {
      custodyRows(2);
      const listOverdue = repo.findOverdueIds.bind(repo);
      vi.spyOn(repo, "findOverdueIds").mockImplementation((...args) => { busy(STUCK_SWEEP_SLICE_RECORD_MS + 30); return listOverdue(...args); });
      await runStuckSweep({ db, queueRepo: repo, log: () => {} });
      await recorder.flush();
      const records = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const pass = records.filter((r) => r.site === STUCK_SWEEP_PASS_SITE);
      expect(pass.map((r) => r.phase)).toEqual(["end"]);
      expect(pass[0]).toMatchObject({ v: 1, outcome: "ok", rowsScanned: 2, findingsCreated: 2, durationMs: expect.any(Number),
        maxSliceMs: expect.any(Number) });
      const slice = records.filter((r) => r.site === STUCK_SWEEP_SLICE_SITE);
      expect(slice.map((r) => r.phase)).toEqual(["begin", "end"]);
      expect(slice[1]!.spanId).toBe(slice[0]!.spanId);
      expect(slice[1]).toMatchObject({ v: 1, outcome: "ok", fromPhase: "start", durationMs: expect.any(Number) });
      expect(String(slice[1]!.phases)).toMatch(/^start,overdue(,|$)/);
      const duration = slice[1]!.durationMs as number;
      expect(duration).toBeGreaterThanOrEqual(STUCK_SWEEP_SLICE_RECORD_MS + 30);
      // the begin is dated at the slice's start: begin + durationMs is the slice's end (to the ms of the ISO stamps)
      const begin = Date.parse(slice[0]!.ts as string), end = Date.parse(slice[1]!.ts as string);
      expect(Math.abs(end - begin - duration)).toBeLessThanOrEqual(3);
    } finally {
      configureSyncSiteRecorder(undefined);
      await recorder.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runStuckSweep: what other code does while the pass is held", () => {
  it("overlap: a 2nd tick while the pass is held in a wake is skipped, and a recovery made meanwhile holds the row", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    overdueRow("qitem-o0001"); // found stuck by the first loop, before the held wake
    unroutableRow("qitem-w0001");
    const wake = holdFirstWake();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const deps: Parameters<typeof startStuckSweepScheduler>[0] = { rigRepo: { db }, queueRepo: repo };
    const handle = startStuckSweepScheduler(deps);
    try {
      const record = vi.spyOn(deps.stuckSweepStatus!, "record");
      await until(() => wake.calls === 1);
      // another author's recovery for the overdue row (a wake-ladder escalation, say) lands while the wake is held:
      // the pass's recovery index, read before it, does not have it
      insert("qitem-r0001", { ts_updated: new Date().toISOString(), source_session: "ladder@r", tags: JSON.stringify([recoveryTag("qitem-o0001")]) });
      await vi.advanceTimersByTimeAsync(300_000); // the 2nd tick, during the held pass
      expect(errors.mock.calls.filter(([l]) => String(l).startsWith("[stuck-sweep] tick skipped"))).toHaveLength(1);
      expect(record).not.toHaveBeenCalled();
      wake.release();
      await until(() => record.mock.calls.length === 1);
      // the recovery made during the pass holds the row: no finding of the sweep's beside it
      expect(findingRows("overdue-claim", "qitem-o0001")).toEqual([]);
      expect(anyFindingRows("qitem-w0001")).toHaveLength(1);
      // the next tick runs a pass of its own, with its own index: nothing new, nothing doubled
      await vi.advanceTimersByTimeAsync(300_000);
      await until(() => record.mock.calls.length === 2);
      expect(wake.calls).toBe(2);
      expect(findingRows("overdue-claim", "qitem-o0001")).toEqual([]);
      expect(anyFindingRows("qitem-w0001")).toHaveLength(1);
      expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = 'qitem-r0001'").get()).toEqual({ state: "pending" });
    } finally {
      if (handle) clearInterval(handle);
    }
  });

  it("a deferred finding kind: when the row's last kind stopped holding during the pass, its other kind still valid gets the finding", async () => {
    // claimed an hour ago with no motion since (stalled-after-claim) and past its deadline (overdue-claim)
    const row = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "work" });
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ?, closure_required_at = ? WHERE qitem_id = ?")
      .run(iso(60 * MIN), iso(61 * MIN), iso(30 * MIN), row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'").run(iso(60 * MIN), row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'created'").run(iso(61 * MIN), row.qitemId);
    expect(repo.getById(row.qitemId)!.pickup?.state).toBe("stalled-after-claim");
    unroutableRow("qitem-w0002");
    // while the wake is held (after both kinds were found), the owner moves: no longer stalled, still overdue
    const wake = holdFirstWake(() => { repo.update({ qitemId: row.qitemId, actorSession: "worker@r", transitionNote: "resumed work" }); });
    const pass = runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    await until(() => wake.calls === 1);
    expect(repo.getById(row.qitemId)!.pickup?.state).toBe("working");
    wake.release();
    const result = await pass;
    expect(result.findings.filter((f) => f.qitemId === row.qitemId && f.action === "created").map((f) => f.kind)).toEqual(["overdue-claim"]);
    expect(findingRows("stalled-after-claim", row.qitemId)).toEqual([]);
    expect(findingRows("overdue-claim", row.qitemId)).toEqual([expect.objectContaining({ state: "pending" })]);
  });

  it("the deadline renewal during the yield: a renewed deadline already past is judged in this pass, by the new deadline", async () => {
    overdueRow("qitem-o0002", iso(120 * MIN));
    finding("qitem-f0001", "overdue-claim", "qitem-o0002", "done", iso(90 * MIN)); // closed after the first deadline
    unroutableRow("qitem-w0003");
    const renewed = iso(30 * MIN); // accepted after that finding closed, and already expired
    const wake = holdFirstWake(() => { repo.update({ qitemId: "qitem-o0002", actorSession: "worker@r", closureRequiredAt: renewed }); });
    const pass = runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    await until(() => wake.calls === 1);
    wake.release();
    const result = await pass;
    const created = result.findings.filter((f) => f.qitemId === "qitem-o0002" && f.action === "created");
    expect(created.map((f) => f.kind)).toEqual(["overdue-claim"]);
    // a new recovery episode (the renewal is a newer transition than the closed finding), as a pass that listed the row
    // after the renewal makes it
    expect(created[0]!.findingQitemId).not.toBe("qitem-f0001");
    expect(created[0]!.findingQitemId).toBe(recoveryId(db, "qitem-o0002"));
    expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = 'qitem-f0001'").get()).toEqual({ state: "done" });
  });

  it("the deadline renewal during the yield: a deadline moved into the future makes no finding and leaves the open one to the next pass", async () => {
    overdueRow("qitem-o0003", iso(120 * MIN));
    finding("qitem-f0002", "overdue-claim", "qitem-o0003", "pending", iso(90 * MIN));
    overdueRow("qitem-o0004", iso(120 * MIN)); // no finding yet
    unroutableRow("qitem-w0004");
    const future = new Date(Date.now() + 6 * 60 * MIN).toISOString();
    const wake = holdFirstWake(() => {
      for (const id of ["qitem-o0003", "qitem-o0004"]) repo.update({ qitemId: id, actorSession: "worker@r", closureRequiredAt: future });
    });
    const pass = runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    await until(() => wake.calls === 1);
    wake.release();
    const result = await pass;
    expect(result.findings.filter((f) => f.action === "created" && f.kind === "overdue-claim")).toEqual([]);
    expect(findingRows("overdue-claim", "qitem-o0004")).toEqual([]);
    // found this pass before the renewal: refreshed, not closed on a list read before the yield
    expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = 'qitem-f0002'").get()).toEqual({ state: "pending" });
    const next = await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    expect(next.findings.filter((f) => f.findingQitemId === "qitem-f0002").map((f) => f.action)).toEqual(["closed"]);
  });
});

describe("undeliveredCandidateIdPages: the undelivered listing in pages the sweep yields between", () => {
  function undeliveredMix(n: number) {
    for (let i = 0; i < n; i++) {
      const id = `qitem-d${String(i).padStart(4, "0")}`;
      const created = iso((n - i) * MIN); // ts_created order differs from id order for none; ties below
      if (i % 3 === 0) insert(id, { ts_created: created, last_nudge_result: "failed:no-pane" });
      else if (i % 3 === 1) insert(id, { ts_created: created, last_nudge_result: "unroutable:no-pane" });
      else insert(id, { ts_created: created }); // pending, delivered: not a candidate
    }
    insert("qitem-tie-b", { ts_created: iso(0), last_nudge_result: "failed:x" });
    insert("qitem-tie-a", { ts_created: iso(0), last_nudge_result: "failed:x" });
    insert("qitem-closed", { state: "done", last_nudge_result: "failed:x" });
  }

  it("gives the ids findUndeliveredCandidateIds gives, in its order, each page judged on at most pageRows rows", () => {
    undeliveredMix(25);
    const pages = [...repo.undeliveredCandidateIdPages(4)];
    expect(pages.length).toBe(Math.ceil(27 / 4)); // 27 open rows
    expect(pages.flat()).toEqual(repo.findUndeliveredCandidateIds());
    expect(pages.flat()).toHaveLength(9 + 8 + 2);
  });

  it("the sweep lists undelivered rows by pages, not by one read of the whole open queue", async () => {
    undeliveredMix(25);
    const whole = vi.spyOn(repo, "findUndeliveredCandidateIds");
    const paged = vi.spyOn(repo, "undeliveredCandidateIdPages");
    await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    expect(whole).not.toHaveBeenCalled();
    expect(paged).toHaveBeenCalledTimes(1);
  });
});

describe("runStuckSweep: what the pass reads live and what its slices measure", () => {
  it("custody from the snapshot is re-read live when its holder lost the tag: a recovery tag taken off during a yield, with no state change, lets the row's finding out in the same pass", async () => {
    overdueRow("qitem-o0101"); // found stuck by the first loop, before the held wake
    // another author's open recovery holds it when the pass reads its snapshot
    insert("qitem-r0101", { ts_created: iso(MIN), ts_updated: iso(MIN), source_session: "ladder@r", tags: JSON.stringify([recoveryTag("qitem-o0101")]) });
    unroutableRow("qitem-w0101");
    // while the wake is held, the holder drops the tag with a bare tags write: its state (and ts_updated) do not move
    const wake = holdFirstWake(() => { db.prepare("UPDATE queue_items SET tags = '[]' WHERE qitem_id = 'qitem-r0101'").run(); });
    const pass = runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    await until(() => wake.calls === 1);
    expect(findQueueRecovery(db, "qitem-o0101")).toBeNull();
    wake.release();
    const result = await pass;
    expect(result.findings.filter((f) => f.qitemId === "qitem-o0101").map((f) => [f.kind, f.action]))
      .toEqual([["overdue-claim", "created"]]);
    expect(findingRows("overdue-claim", "qitem-o0101")).toEqual([expect.objectContaining({ state: "pending" })]);
  });
  it("empty undelivered pages: the pass yields between pages it judges with no candidate on them", async () => {
    // open rows that are no candidate of any kind (fresh, delivered, unclaimed for less than the threshold)
    const insertMany = db.transaction(() => { for (let i = 0; i < 2000; i++) insert(`qitem-e${String(i).padStart(4, "0")}`, { ts_created: iso(MIN), ts_updated: iso(MIN) }); });
    insertMany();
    const real = repo.undeliveredCandidateIdPages.bind(repo);
    let pages = 0;
    // a page's judgment (the receipt subqueries over every transition of its rows) held the loop for 30 ms
    vi.spyOn(repo, "undeliveredCandidateIdPages").mockImplementation(function* (pageRows?: number) {
      for (const page of real(pageRows)) { busy(30); pages++; yield page; }
    });
    const span = spanCatcher();
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null, slowOps: span.slowOps });
    expect(result.findings).toEqual([]);
    expect(pages).toBe(10); // 2000 open rows, 200 per page
    const end = span.ends[0]!;
    expect(end.yields).toBeGreaterThanOrEqual(pages / 2);
    // a slice holds about one page (30 ms, past the 25 ms budget on its own), never the 10 pages (300 ms)
    expect(end.maxSliceMs).toBeLessThan(STUCK_SWEEP_SLICE_BUDGET_MS + 2 * 30);
  });
  it("an awaited write is not a slice: a wake retry that takes 300 ms to resolve does not count as the loop held", async () => {
    unroutableRow("qitem-w0102");
    vi.spyOn(repo, "classifyDestinationOf").mockReturnValue({ class: "pane-bound" } as ReturnType<typeof repo.classifyDestinationOf>);
    const wake = vi.spyOn(repo, "deliverWakeForSuccessor").mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
    const span = spanCatcher();
    await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null, slowOps: span.slowOps });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(span.ends[0]!.maxSliceMs).toBeLessThan(STUCK_SWEEP_SLICE_RECORD_MS);
    expect(span.slices).toEqual([]);
  });
});

describe("createPassRoutes.unchanged: a rule run again leaves the pass's routing notes as they were", () => {
  it("puts back every key the run changed, the judged row's and another row's (a wait routes the row its job is bound to)", () => {
    const routes = createPassRoutes();
    routes.setNote("qitem-b", "routed to orch@r"); routes.markHop("qitem-b");
    const held = routes.unchanged(() => {
      routes.setNote("qitem-a", "a's route now"); routes.markHop("qitem-a"); // the judged row
      routes.forget("qitem-b"); routes.setNote("qitem-b", "fallback now"); // the row its job is bound to
      routes.setNote("qitem-c", "c's route now");
      return true;
    });
    expect(held).toBe(true);
    expect([routes.note("qitem-a"), routes.usedHop("qitem-a")]).toEqual([undefined, false]);
    expect([routes.note("qitem-b"), routes.usedHop("qitem-b")]).toEqual(["routed to orch@r", true]);
    expect([routes.note("qitem-c"), routes.usedHop("qitem-c")]).toEqual([undefined, false]);
  });
  it("puts them back when the rule throws, and a nested run puts back only its own changes", () => {
    const routes = createPassRoutes();
    expect(() => routes.unchanged(() => { routes.setNote("qitem-b", "x"); throw new Error("rule failed"); })).toThrow("rule failed");
    expect(routes.note("qitem-b")).toBeUndefined();
    routes.unchanged(() => {
      routes.setNote("qitem-a", "outer");
      routes.unchanged(() => { routes.setNote("qitem-a", "inner"); routes.markHop("qitem-b"); });
      expect([routes.note("qitem-a"), routes.usedHop("qitem-b")]).toEqual(["outer", false]);
    });
    expect(routes.note("qitem-a")).toBeUndefined();
  });
  it("outside a run, a change stays", () => {
    const routes = createPassRoutes();
    routes.setNote("qitem-a", "kept"); routes.markHop("qitem-a");
    expect([routes.note("qitem-a"), routes.usedHop("qitem-a")]).toEqual(["kept", true]);
    routes.forget("qitem-a");
    expect([routes.note("qitem-a"), routes.usedHop("qitem-a")]).toEqual([undefined, false]);
  });
});
