// Frozen QA eval eA (T-003812, the PR-A of the D1 lane of T-003453/T-003398): the stuck-sweep SCHEDULER runs ONE
// pass at a time. Frozen by qualidade-qa-2@fabrica (eval/eA/SHA256SUMS of the demand folder
// ~/dev/fabrica/demandas/2026-11-07-hillclimb-daemon-openrig/): copy this file and its fixture unchanged.
//
// The real behaviour (the fixture, test/fixtures/qa-ea-overlap-golden.json, is the golden of the R1 harness a1719fe6a,
// steps 48-53 of the overlap scenario, copied without changing a value): a row whose wake was recorded `unroutable:`
// and whose destination is now pane-bound gets its wake delivered by the sweep (#2151), an AWAITED send. On the main
// (c271299f5) a second scheduler tick runs a whole pass DURING that send (49: sweep_completed_during_delivery = true),
// sees the row still `unroutable:`, and files an `undelivered-wake` finding that is closed later (52: done,
// no-follow-on): the obligation of the row, nobody having claimed it, ends hidden. With the single-flight (the D1:
// the tick during a pass is skipped) no pass completes during the send (49: false) and the row ends with the right
// finding, `unclaimed-obligation`, pending (52).
//
// The contract (CONSELHO-R1.md §2 and §4 item 1; the 642100a70 commit message: "a tick during a pass is skipped and
// logged"), driven through the exported `startStuckSweepScheduler` with real timers, a 1 s interval
// (OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS=1) and a 1 min unclaimed age, an in-memory database and the real
// QueueRepository; only `deliverWakeForSuccessor` is held (a promise this test releases), and on release it records the
// delivery as the real send does (last_nudge_result = verified):
//   1. while the boot pass is held inside the delivery, NO pass completes (the status heartbeat lastSweepAt does not
//      move across >= 2 interval ticks) = the D1 value of step 49;
//   2. no `undelivered-wake` finding is filed for the row during or after the window;
//   3. after the release, the held pass ends AND a later tick runs a new pass (the heartbeat moves twice: the
//      single-flight is released when the pass ends) and the row's findings are exactly one, `unclaimed-obligation`,
//      pending, no closureReason =
//      the D1 values of step 52;
//   4. the skipped tick is never silent: a log line on stderr/stdout (console.error/warn/log) during the held window
//      mentions the skip ("skip", any case).
// Free: how the single-flight is kept (a flag, a promise, a timestamp), the log text beyond "skip", the finding's text.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { startStuckSweepScheduler } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "qa-ea-overlap-golden.json"), "utf-8"));
const D1 = GOLDEN.d1.passos;
const MAIN = GOLDEN.main.passos;

const SOURCE = "lead-tech@fabrica";
const DEST = "hc-h05@fabrica";
const UNROUTABLE = `unroutable: '${DEST}' has no terminal transport on this daemon and names no registered human — no transport can hold this address (checked: tmux bindings + the human registry). Fix the address, or register the human with \`rig gateway human add\`.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(25); }
  return cond();
}

describe("eA: the stuck-sweep scheduler runs one pass at a time (the overlap golden 49-52 of the D1)", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let timer: ReturnType<typeof setInterval> | null = null;
  let logs: string[] = [];

  beforeEach(() => {
    vi.stubEnv("OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS", "1");
    vi.stubEnv("OPENRIG_QUEUE_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES", "1");
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
    });
    logs = [];
    for (const k of ["error", "warn", "log"] as const) {
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    }
  });
  afterEach(async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await sleep(300); // let a pass in flight settle before the database closes
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    db.close();
  });

  function bindDestinationPane(): void {
    // Isolated topology fixture (as the base suite's bindHumanPane): no native session or pane is contacted.
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-qa-ea', 'fabrica')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node-qa-ea', 'rig-qa-ea', 'hc-h05', 'claude-code', '/tmp')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('sess-qa-ea', 'node-qa-ea', ?, 'running', '2026-11-07 00:00:00')").run(DEST);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('bind-qa-ea', 'node-qa-ea', 'tmux', ?, '%9')").run(DEST);
  }

  function kindsFor(qitemId: string): Array<{ kind: string; state: string; closureReason: string | null }> {
    return repo.list({ limit: 1000 })
      .filter((i: QueueItem) => (i.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG))
      .flatMap((i: QueueItem) => (i.tags ?? [])
        .map((t) => /^stuck-sweep:([a-z-]+):(.+)$/.exec(t))
        .filter((m): m is RegExpExecArray => !!m && m[2] === qitemId)
        .map((m) => ({ kind: m[1]!, state: i.state, closureReason: i.closureReason ?? null })));
  }

  it("the fixture is the real golden: the main and the D1 diverge exactly on 49 and 52", () => {
    expect(MAIN["49-overlap-window"].sweep_completed_during_delivery).toBe(true);
    expect(D1["49-overlap-window"].sweep_completed_during_delivery).toBe(false);
    expect(MAIN["52-overlap-findings"].items[0].summary_kind).toBe("undelivered-wake");
    expect(D1["52-overlap-findings"].items).toEqual([expect.objectContaining({ summary_kind: "unclaimed-obligation", state: "pending", closureReason: null })]);
    expect(D1["50-overlap-show-after"]).toMatchObject({ state: "pending", lastNudgeResult: "verified", destinationClass: "pane-bound" });
  });

  it("a tick during a held wake delivery is skipped (logged), and the row ends with the D1 finding", async () => {
    bindDestinationPane();
    expect(repo.classifyDestinationOf(DEST).class).toBe("pane-bound");
    const row = await repo.create({ sourceSession: SOURCE, destinationSession: DEST, body: "golden-overlap body", summary: "golden overlap row" } as never);
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ?, last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(past, past, UNROUTABLE, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, row.qitemId);

    // Hold the awaited send of the FIRST delivery; a delivery already in flight is not sent twice (the real repo
    // claims the row's wake intent), so a second call returns without changing the row.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    vi.spyOn(repo, "deliverWakeForSuccessor").mockImplementation(async (qitemId: string) => {
      calls++;
      if (calls > 1) return undefined as never;
      await held;
      const at = new Date().toISOString();
      db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = 'verified' WHERE qitem_id = ?").run(at, qitemId);
      return undefined as never;
    });

    const deps: Parameters<typeof startStuckSweepScheduler>[0] = { rigRepo: { db }, queueRepo: repo };
    timer = startStuckSweepScheduler(deps);
    const status = deps.stuckSweepStatus!;
    expect(status).toBeDefined();
    const heartbeat = () => (status.snapshot() as { lastSweepAt: string | null }).lastSweepAt;

    expect(await until(() => calls >= 1, 8000)).toBe(true); // the boot pass is inside the delivery
    const beforeWindow = heartbeat();
    const logsBefore = logs.length;
    await sleep(2600); // >= 2 ticks of the 1 s interval while the send is held
    const completedDuringDelivery = heartbeat() !== beforeWindow;
    const windowLogs = logs.slice(logsBefore);

    // 1. the D1 value of step 49
    expect({ sweep_completed_during_delivery: completedDuringDelivery })
      .toEqual({ sweep_completed_during_delivery: D1["49-overlap-window"].sweep_completed_during_delivery });
    // 2. no spurious undelivered-wake during the window
    expect(kindsFor(row.qitemId).filter((f) => f.kind === "undelivered-wake")).toEqual([]);
    // 4. the skip is not silent
    expect(windowLogs.some((l) => /skip/i.test(l)), `no log line about a skipped tick: ${JSON.stringify(windowLogs.slice(0, 5))}`).toBe(true);

    release();
    // 3. the passes run again after the held one ends, and the row's finding becomes the D1 one
    expect(await until(() => heartbeat() !== beforeWindow, 5000)).toBe(true);
    const afterHeld = heartbeat(); // the held pass ended; a LATER tick must run a new pass (the single-flight is released)
    expect(await until(() => heartbeat() !== afterHeld, 4000), "no pass ran after the held one ended: the single-flight never released").toBe(true);
    expect(await until(() => kindsFor(row.qitemId).some((f) => f.kind === "unclaimed-obligation"), 6000)).toBe(true);
    await sleep(1200); // one more tick: nothing else is filed for the row
    clearInterval(timer!);
    timer = null;
    await sleep(300);

    expect(repo.getById(row.qitemId)).toMatchObject({ state: D1["50-overlap-show-after"].state, lastNudgeResult: D1["50-overlap-show-after"].lastNudgeResult });
    const want = D1["52-overlap-findings"].items.map((i: { summary_kind: string; state: string; closureReason: string | null }) =>
      ({ kind: i.summary_kind, state: i.state, closureReason: i.closureReason }));
    expect(kindsFor(row.qitemId)).toEqual(want);
  });
});
