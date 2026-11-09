// A stuck-sweep pass that starts while the daemon boots, with the orchestrator's tmux server and seat binding coming up
// from another task of the daemon while the pass runs. A finding's wake is classified when the pass reaches it, from the
// bindings and the transport as they are then: unroutable: with no binding, failed: with a binding whose server is down,
// delivered once both exist. Nothing in the same pass retries it. So the outcome is a matter of timing: the seat's task
// can only run while the pass has given the loop up, and what counts is whether that happened before the pass reached
// the row. The declared change is when a pass gives the loop up: besides every 50 rows, now also once a slice has held
// it for 25 ms. A slow stretch before the findings, too short in rows to yield on the count, now lets the seat come up,
// and the finding's wake is delivered where it used to record unroutable:.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { runStuckSweep, STUCK_SWEEP_SLICE_BUDGET_MS, STUCK_SWEEP_YIELD_EVERY_ROWS } from "../src/domain/queue-stuck-sweep.js";

const ORCH = "lead-orchestrator@rig-a";
const NO_SERVER = "The tmux server could not be reached (connect: No such file or directory)";
const MIN = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

let db: Database.Database;
let repo: QueueRepository;
/** The harness's tmux server: down until it comes up. Sends to a bound seat land only once it is up. */
let serverUp: boolean;
const sends: string[] = [];

beforeEach(() => {
  db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  serverUp = false; sends.length = 0;
  repo.attachTransport({ send: async (session: string) => {
    sends.push(session);
    return serverUp ? { ok: true, verified: false } : { ok: false, sent: false, inputPhase: "not_reached" as const, error: NO_SERVER };
  } });
  // The topology is loaded at boot: the orchestrator's node exists, its tmux binding not yet.
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig-a')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-orch', 'rig-1', 'lead.orchestrator', 'claude-code')").run();
});
afterEach(() => { db.close(); });

function insert(id: string, o: Record<string, string | null>) {
  const cols = { ts_created: iso(3 * 60 * MIN), ts_updated: iso(3 * 60 * MIN), source_session: "sender@r", destination_session: "worker@r",
    state: "pending", tags: "[]", body: "b", ...o };
  db.prepare(`INSERT INTO queue_items(qitem_id, ${Object.keys(cols).join(", ")}) VALUES (?, ${Object.keys(cols).map(() => "?").join(", ")})`)
    .run(id, ...Object.values(cols));
}
/** Work whose wake failed before the restart: each row gets an undelivered-wake finding routed to the orchestrator. The
 *  `ahead` rows are older and come first in the pass; qitem-target is the last. */
function seed(ahead: number) {
  for (let i = 0; i < ahead; i++) insert(`qitem-a${String(i).padStart(4, "0")}`, { ts_created: iso(4 * 60 * MIN), last_nudge_result: "failed:x" });
  insert("qitem-target", { last_nudge_result: "failed:x" });
}
/** The orchestrator's tmux binding (`bind`) and its server (`up`) come up. */
function seatComesUp(o: { bind: boolean; up: boolean }) {
  if (o.bind) db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session) VALUES ('b-orch', 'node-orch', 'tmux', ?)").run(ORCH);
  serverUp = o.up;
}
const findingOf = (stuckId: string) => db.prepare("SELECT qitem_id, destination_session, last_nudge_result FROM queue_items WHERE tags LIKE ?")
  .get(`%"stuck-sweep:undelivered-wake:${stuckId}"%`) as { qitem_id: string; destination_session: string; last_nudge_result: string | null } | undefined;
/** Longer than a slice's budget. */
const SLOW_ROUTING_MS = STUCK_SWEEP_SLICE_BUDGET_MS + 5;
/** Holds the loop for `ms` synchronously. */
function busy(ms: number) { const until = performance.now() + ms; while (performance.now() < until) { /* hold the loop */ } }
/** Starts a pass with the seat coming up from another task (the next turn of the loop), as a seat launch does.
 *  `slowRouting`: each routing decision holds the loop for longer than a slice's budget. */
async function sweepWhileSeatComesUp(o: { slowRouting?: boolean } = {}) {
  let reachedFirst: boolean | undefined;
  setImmediate(() => { reachedFirst = findingOf("qitem-target") !== undefined; seatComesUp({ bind: true, up: true }); });
  const result = await runStuckSweep({ db, queueRepo: repo, log: () => {},
    resolveOrchestrator: () => { if (o.slowRouting) busy(SLOW_ROUTING_MS); return ORCH; } });
  expect(result.outcome).not.toBe("failed");
  await new Promise<void>((resolve) => setImmediate(resolve)); // a pass that never gave the loop up: the seat comes up now
  expect(reachedFirst).toBeDefined();
  return { seatFirst: reachedFirst === false, result: findingOf("qitem-target")!.last_nudge_result };
}

describe("runStuckSweep at boot: a finding's wake is classified when the pass reaches it", () => {
  it("gives the loop up after a slow stretch shorter than the row count, so a seat coming up then gets the wake delivered", async () => {
    const ahead = 3;
    seed(ahead);
    expect(ahead + 1).toBeLessThan(STUCK_SWEEP_YIELD_EVERY_ROWS); // far fewer rows than a yield on the count
    const { seatFirst, result } = await sweepWhileSeatComesUp({ slowRouting: true });
    expect(seatFirst).toBe(true);
    expect(result).toBe("delivered-ack-pending");
    expect(sends).toContain(ORCH);
  });

  it("delivers the same way when the rows ahead are many enough to yield on the count", async () => {
    seed(STUCK_SWEEP_YIELD_EVERY_ROWS + 70);
    const { seatFirst, result } = await sweepWhileSeatComesUp();
    expect(seatFirst).toBe(true);
    expect(result).toBe("delivered-ack-pending");
  });

  it("records the same input as unroutable: when the pass reaches the row before it gives the loop up", async () => {
    seed(0);
    const { seatFirst, result } = await sweepWhileSeatComesUp();
    expect(seatFirst).toBe(false);
    expect(result).toMatch(/^unroutable: 'lead-orchestrator@rig-a' has no terminal transport/);
    expect(sends).toEqual([]); // tmux is not consulted for an address with no binding
    // The seat is up now, after the pass: the finding keeps its result until a later pass retries it.
    expect(findingOf("qitem-target")!.last_nudge_result).toMatch(/^unroutable:/);
  });

  it("records failed: when the binding exists but the tmux server is not up yet when the pass reaches the row", async () => {
    seed(0);
    seatComesUp({ bind: true, up: false });
    await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => ORCH });
    expect(findingOf("qitem-target")!.last_nudge_result).toBe(`failed:${NO_SERVER}`);
  });
});
