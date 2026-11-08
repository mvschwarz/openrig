// #2430: a seat that reads its rows without claiming them (a person's front door) and has no delegation parent or
// escalates_to route got a stuck-sweep finding for every unclaimed row, addressed back to itself, which already holds
// that row. It now gets one standing notice for those rows. A seat with a route keeps a finding per row at that route,
// an address that isn't an agent seat keeps a finding per row, and claimed rows behave as before.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { runStuckSweep, createStuckSweepStatus, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";

describe("stuck sweep: unclaimed rows of a seat with no escalation route (#2430)", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let queue: QueueRepository;
  let seq: number;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db);
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    seq = 0;
  });
  afterEach(() => db.close());

  function seat(rigName: string, logicalId: string, session: string) {
    const rig = rigs.listRigs().find((r) => r.name === rigName) ?? rigs.createRig(rigName);
    const node = rigs.addNode(rig.id, logicalId, { runtime: "claude-code" });
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,?)").run(`session-${++seq}`, node.id, session, "running");
    return { rig, node, session };
  }
  /** One pass at the unclaimed threshold `age` (minutes), as of `now`. */
  async function sweep(age = 60, now?: Date) {
    return runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: age, now, log: () => {},
      isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null });
  }
  /** A task for `destination`, actionable since `minutesAgo` (fixture aging of existing facts, as the sweep tests do). */
  async function work(destination: string, minutesAgo = 90): Promise<QueueItem> {
    const row = await queue.create({ sourceSession: "sender@lane", destinationSession: destination, body: "Decide the scope",
      summary: "Scope decision needed", nudge: false });
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(at, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(at, row.qitemId);
    return row;
  }
  /** Every finding the sweep filed to `session`, open or closed, read whole. */
  const findingsTo = (session: string): QueueItem[] => queue.list({ limit: 500 })
    .filter((item) => item.destinationSession === session && (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG))
    .map((item) => queue.getById(item.qitemId)!);
  const isOpen = (item: QueueItem) => ["pending", "in-progress", "blocked"].includes(item.state);

  it("gives a seat with no route one standing notice for its unclaimed rows, not a finding per row, and doesn't repeat it", async () => {
    seat("front", "door.root", "root@front");
    const rows = [await work("root@front"), await work("root@front"), await work("root@front")];
    await sweep();
    const filed = findingsTo("root@front");
    expect(filed).toHaveLength(1);
    const notice = filed[0]!;
    expect(notice).toMatchObject({ state: "pending", summary: "Stuck sweep: unclaimed-backlog on root@front (3 rows)" });
    expect(notice.tags).toContain("stuck-sweep:unclaimed-backlog:root@front");
    // What the seat reads: each row, how to list them, and how to send these findings to a seat that watches it.
    for (const row of rows) expect(notice.body).toContain(row.qitemId);
    expect(notice.body).toContain("rig queue list --destination root@front --state pending");
    expect(notice.body).toContain("escalates_to");
    // Later passes keep the same one notice.
    await sweep();
    await sweep();
    expect(findingsTo("root@front")).toHaveLength(1);
    // A new unclaimed row joins it rather than adding a finding.
    const fourth = await work("root@front");
    await sweep();
    const after = findingsTo("root@front");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ qitemId: notice.qitemId, state: "pending", summary: "Stuck sweep: unclaimed-backlog on root@front (4 rows)" });
    expect(after[0]!.body).toContain(fourth.qitemId);
  });

  it("leaves claimed rows out of the notice and closes it once the seat has claimed them all", async () => {
    seat("front", "door.root", "root@front");
    const claimed = await work("root@front");
    const waiting = await work("root@front");
    queue.claim({ qitemId: claimed.qitemId, destinationSession: "root@front" });
    await sweep();
    const [notice] = findingsTo("root@front");
    expect(notice).toMatchObject({ state: "pending", summary: "Stuck sweep: unclaimed-backlog on root@front (1 row)" });
    expect(notice!.body).toContain(waiting.qitemId);
    expect(notice!.body).not.toContain(claimed.qitemId);
    queue.claim({ qitemId: waiting.qitemId, destinationSession: "root@front" });
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(findingsTo("root@front")).toHaveLength(1);
  });

  it("doesn't file again for rows whose notice someone closed; a newer unclaimed row files one new notice for all of them", async () => {
    seat("front", "door.root", "root@front");
    const old = await work("root@front", 240);
    await sweep();
    const [first] = findingsTo("root@front");
    queue.update({ qitemId: first!.qitemId, actorSession: "root@front", state: "done", closureReason: "no-follow-on", transitionNote: "read" });
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(new Date(Date.now() - 180 * 60_000).toISOString(), first!.qitemId);
    await sweep();
    expect(findingsTo("root@front").filter(isOpen)).toHaveLength(0);
    const newer = await work("root@front", 120);
    await sweep();
    const reopened = findingsTo("root@front").filter(isOpen);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.summary).toBe("Stuck sweep: unclaimed-backlog on root@front (2 rows)");
    expect(reopened[0]!.body).toContain(old.qitemId);
    expect(reopened[0]!.body).toContain(newer.qitemId);
  });

  it("keeps the notice open while the wake ladder is still waking its row", async () => {
    seat("front", "door.root", "root@front");
    const row = await work("root@front");
    await sweep();
    const [notice] = findingsTo("root@front");
    queue.update({ qitemId: row.qitemId, actorSession: "wake-ladder@system", transitionNote: "wake-attempt: 1 of 3" });
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending" });
  });

  it("with an escalates_to route, each unclaimed row's finding goes to that seat, never to the seat itself", async () => {
    const door = seat("front", "door.root", "root@front");
    seat("ops", "watch.desk", "desk@ops");
    rigs.addEdge(door.rig.id, door.node.id, "desk@ops", "escalates_to");
    const rows = [await work("root@front"), await work("root@front")];
    await sweep();
    expect(findingsTo("root@front")).toHaveLength(0);
    const routed = findingsTo("desk@ops");
    expect(routed).toHaveLength(2);
    for (const row of rows) expect(routed.some((f) => f.tags?.includes(`stuck-sweep:unclaimed-obligation:${row.qitemId}`))).toBe(true);
  });

  it("with a delegation parent, each unclaimed row's finding goes to the parent", async () => {
    const lead = seat("lane", "work.lead", "lead@lane");
    const parent = seat("lane", "coord.owner", "owner@lane");
    rigs.addEdge(lead.rig.id, parent.node.id, lead.node.id, "delegates_to");
    const row = await work("lead@lane");
    await sweep();
    expect(findingsTo("lead@lane")).toHaveLength(0);
    expect(findingsTo("owner@lane").map((f) => f.tags)).toEqual([expect.arrayContaining([`stuck-sweep:unclaimed-obligation:${row.qitemId}`])]);
  });

  it("an address that isn't an agent seat here keeps a finding per row", async () => {
    const rows = [await work("someone@elsewhere"), await work("someone@elsewhere")];
    await sweep();
    const filed = findingsTo("someone@elsewhere");
    expect(filed).toHaveLength(2);
    for (const row of rows) expect(filed.some((f) => f.tags?.includes(`stuck-sweep:unclaimed-obligation:${row.qitemId}`))).toBe(true);
  });

  it("a row that crosses the threshold after its seat's notice closed files a new notice", async () => {
    seat("front", "door.root", "root@front");
    const first = await work("root@front");
    await sweep();
    const [notice] = findingsTo("root@front");
    queue.claim({ qitemId: first.qitemId, destinationSession: "root@front" });
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done" });
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), notice!.qitemId);
    // Pending since before the close, past the threshold only after it: the closed notice never stood for it.
    const later = await work("root@front", 70);
    await sweep();
    const open = findingsTo("root@front").filter(isOpen);
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain(later.qitemId);
  });

  it("a raised threshold doesn't close a notice whose rows are still unclaimed, and restoring it keeps them listed", async () => {
    seat("front", "door.root", "root@front");
    const row = await work("root@front", 90);
    await sweep();
    const [notice] = findingsTo("root@front");
    await sweep(120);
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending" });
    expect(queue.getById(notice!.qitemId)!.body).toContain(row.qitemId);
    await sweep(60);
    const open = findingsTo("root@front").filter(isOpen);
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain(row.qitemId);
  });

  it("closing a notice holds back only the rows it listed: a younger row that becomes eligible later files a new one", async () => {
    seat("front", "door.root", "root@front");
    await work("root@front", 240);
    const younger = await work("root@front", 10);
    await sweep();
    const [first] = findingsTo("root@front");
    expect(first!.body).not.toContain(younger.qitemId);
    queue.update({ qitemId: first!.qitemId, actorSession: "root@front", state: "done", closureReason: "no-follow-on", transitionNote: "read the listed rows" });
    await sweep(60, new Date(Date.now() + 65 * 60_000));
    const open = findingsTo("root@front").filter(isOpen);
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain(younger.qitemId);
  });

  it("keeps a row the wake ladder is waking listed in the open notice beside the others", async () => {
    seat("front", "door.root", "root@front");
    const laddered = await work("root@front");
    const other = await work("root@front");
    await sweep();
    const [notice] = findingsTo("root@front");
    queue.update({ qitemId: laddered.qitemId, actorSession: "wake-ladder@system", transitionNote: "wake-attempt: 1 of 3" });
    await sweep();
    const after = queue.getById(notice!.qitemId)!;
    expect(after).toMatchObject({ state: "pending", summary: "Stuck sweep: unclaimed-backlog on root@front (2 rows)" });
    expect(after.body).toContain(laddered.qitemId);
    expect(after.body).toContain(other.qitemId);
  });

  it("once the seat declares the escalates_to edge its notice suggests, each row's finding goes to the watcher and the notice closes", async () => {
    const door = seat("front", "door.root", "root@front");
    const row = await work("root@front");
    await sweep();
    const [notice] = findingsTo("root@front");
    seat("ops", "watch.desk", "desk@ops");
    rigs.addEdge(door.rig.id, door.node.id, "desk@ops", "escalates_to");
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done" });
    expect(findingsTo("desk@ops").map((f) => f.tags)).toEqual([expect.arrayContaining([`stuck-sweep:unclaimed-obligation:${row.qitemId}`])]);
  });

  it("a seat with a declared delegation parent that has no session keeps a finding per row, not a notice that says it has none", async () => {
    const lead = seat("lane", "work.lead", "lead@lane");
    const parent = rigs.addNode(lead.rig.id, "coord.owner", { runtime: "claude-code" });
    rigs.addEdge(lead.rig.id, parent.id, lead.node.id, "delegates_to");
    const row = await work("lead@lane");
    await sweep();
    const filed = findingsTo("lead@lane");
    expect(filed).toHaveLength(1);
    expect(filed[0]!.tags).toContain(`stuck-sweep:unclaimed-obligation:${row.qitemId}`);
  });

  it("keeps the notice when a row's own finding at its new route couldn't be written", async () => {
    const door = seat("front", "door.root", "root@front");
    const row = await work("root@front");
    await sweep();
    const [notice] = findingsTo("root@front");
    seat("ops", "watch.desk", "desk@ops");
    rigs.addEdge(door.rig.id, door.node.id, "desk@ops", "escalates_to");
    db.exec("CREATE TRIGGER fail_watcher_finding BEFORE INSERT ON queue_items WHEN NEW.destination_session = 'desk@ops' BEGIN SELECT RAISE(ABORT, 'finding write failed'); END");
    const result = await sweep();
    expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining("finding write failed") });
    expect(findingsTo("desk@ops")).toHaveLength(0);
    // Detecting the route isn't a finding there: the row stays in the notice until one is written.
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending" });
    expect(queue.getById(notice!.qitemId)!.body).toContain(row.qitemId);
  });

  /** The notice's body without its list of rows, or with that list cut short, as an unreadable stored body would be. */
  function breakRowList(qitemId: string, how: "missing" | "malformed") {
    const prefix = "Every row this notice stands for: ";
    const body = queue.getById(qitemId)!.body.split("\n").filter((line) => !line.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(how === "malformed" ? `${body}\n${prefix}[` : body, qitemId);
  }

  it.each(["missing", "malformed"] as const)("never closes a notice whose list of rows is %s", async (how) => {
    seat("front", "door.root", "root@front");
    await work("root@front", 90);
    await sweep();
    const [notice] = findingsTo("root@front");
    breakRowList(notice!.qitemId, how);
    await sweep(120);
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending" });
  });

  it("a closed notice whose list of rows is unreadable doesn't file again for the same rows", async () => {
    seat("front", "door.root", "root@front");
    await work("root@front", 90);
    await sweep();
    const [notice] = findingsTo("root@front");
    queue.update({ qitemId: notice!.qitemId, actorSession: "root@front", state: "done", closureReason: "no-follow-on", transitionNote: "read" });
    breakRowList(notice!.qitemId, "missing");
    await sweep();
    expect(findingsTo("root@front").filter(isOpen)).toHaveLength(0);
  });

  it("stands for every row past the 20 it lists: a row only counted keeps the notice open", async () => {
    seat("front", "door.root", "root@front");
    const rows: QueueItem[] = [];
    for (let i = 0; i < 25; i++) rows.push(await work("root@front", 90));
    await sweep();
    const [notice] = findingsTo("root@front");
    expect(notice!.body.split("\n").filter((line) => line.startsWith("- qitem-"))).toHaveLength(20);
    const counted = rows.find((r) => !notice!.body.includes(`- ${r.qitemId}`))!;
    for (const r of rows) if (r.qitemId !== counted.qitemId) queue.claim({ qitemId: r.qitemId, destinationSession: "root@front" });
    await sweep(120);
    const after = queue.getById(notice!.qitemId)!;
    expect(after).toMatchObject({ state: "pending", summary: "Stuck sweep: unclaimed-backlog on root@front (1 row)" });
    expect(after.body).toContain(`- ${counted.qitemId}`);
  });
});
