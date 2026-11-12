// #2988: an unclaimed row whose stuck-sweep finding goes to its seat's delegation parent got a finding per row, each one
// waking the parent. An orchestrator over pool seats got a steady stream of them and closed almost all by hand. Those
// rows now share one standing notice per (parent, child seat), the notice #2430/#2752 gives a seat with no route: it
// stands for every row (not only the 20 it lists), is rewritten in place without a new wake, closes itself once every
// row is claimed, parked or closed, and a closed one holds back only the rows it stood for until they have newer
// evidence. It tells the parent about its child's backlog; it never claims, moves or completes that work. Other finding
// kinds keep a finding per row, and an open per-row finding for a grouped row is folded into the notice and closed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { runStuckSweep, createStuckSweepStatus, STUCK_SWEEP_FINDING_TAG, findingDedupTag, parentBacklogTag }
  from "../src/domain/queue-stuck-sweep.js";
import { findQueueRecovery, recoveryId, recoveryTag } from "../src/domain/queue-recovery.js";
import { queueRecoveryOwnsWake } from "../src/domain/queue-wake-ladder.js";

describe("stuck sweep: unclaimed rows routed to a delegation parent (#2988)", () => {
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
  /** A lead (owner@lane) that delegates to `children` pool seats of the same rig. */
  function lane(...children: string[]) {
    const parent = seat("lane", "coord.owner", "owner@lane");
    const kids = children.map((c, i) => {
      const kid = seat("lane", `pool.${c}`, `${c}@lane`);
      rigs.addEdge(parent.rig.id, parent.node.id, kid.node.id, "delegates_to");
      return kid;
    });
    return { parent, kids };
  }
  /** One pass at the unclaimed threshold `age` (minutes). */
  async function sweep(age = 60) {
    return runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: age, log: () => {},
      isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null });
  }
  /** A task for `destination`, actionable since `minutesAgo` (fixture aging of existing facts, as the sweep tests do). */
  async function work(destination: string, minutesAgo = 90): Promise<QueueItem> {
    const row = await queue.create({ sourceSession: "sender@lane", destinationSession: destination, body: "Build slice 3",
      summary: "Slice 3", nudge: false });
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(at, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(at, row.qitemId);
    return row;
  }
  const findingsTo = (session: string): QueueItem[] => queue.list({ limit: 1000 })
    .filter((item) => item.destinationSession === session && (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG))
    .map((item) => queue.getById(item.qitemId)!);
  const isOpen = (item: QueueItem) => ["pending", "in-progress", "blocked"].includes(item.state);
  const age = (qitemId: string, minutesAgo: number) =>
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), qitemId);

  it("gives the parent one notice per child seat for its unclaimed rows, says it's the child's backlog, and refreshes it in place", async () => {
    lane("dev1", "dev2");
    const one = [await work("dev1@lane"), await work("dev1@lane"), await work("dev1@lane")];
    const two = await work("dev2@lane");
    await sweep();
    const filed = findingsTo("owner@lane");
    expect(filed).toHaveLength(2);
    const notice = filed.find((f) => f.tags?.includes(parentBacklogTag("owner@lane", "dev1@lane")))!;
    expect(notice).toMatchObject({ state: "pending", sourceSession: "dev1@lane",
      summary: "Stuck sweep: unclaimed-backlog on dev1@lane, for its delegation parent owner@lane (3 rows)" });
    for (const row of one) expect(notice.body).toContain(row.qitemId);
    expect(notice.body).not.toContain(two.qitemId);
    expect(notice.body).toContain("parent: owner@lane");
    expect(notice.body).toContain("child seat: dev1@lane");
    expect(notice.body).toMatch(/backlog of dev1@lane, a seat owner@lane delegates to/);
    expect(notice.body).toContain("rig queue list --destination dev1@lane --state pending");
    expect(notice.body).toMatch(/doesn't claim, move or complete/);
    // No finding per row anywhere.
    for (const row of [...one, two]) expect(queue.list({ limit: 1000 }).some((i) => i.tags?.includes(findingDedupTag("unclaimed-obligation", row.qitemId)))).toBe(false);
    // Later passes keep it; a new row joins it in place: same row, no new notice, no new wake.
    const wakeBefore = queue.getById(notice.qitemId)!.lastNudgeAttempt;
    await sweep();
    const fourth = await work("dev1@lane");
    await sweep();
    const after = findingsTo("owner@lane").filter((f) => f.tags?.includes(parentBacklogTag("owner@lane", "dev1@lane")));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ qitemId: notice.qitemId, state: "pending",
      summary: "Stuck sweep: unclaimed-backlog on dev1@lane, for its delegation parent owner@lane (4 rows)" });
    expect(after[0]!.body).toContain(fourth.qitemId);
    expect(after[0]!.lastNudgeAttempt).toBe(wakeBefore);
  });

  it("never claims, moves or completes the rows it stands for", async () => {
    lane("dev1");
    const row = await work("dev1@lane");
    await sweep();
    await sweep();
    expect(queue.getById(row.qitemId)).toMatchObject({ state: "pending", destinationSession: "dev1@lane", claimedAt: null });
  });

  it("closes itself once every row is claimed, parked or closed", async () => {
    lane("dev1");
    const a = await work("dev1@lane");
    const b = await work("dev1@lane");
    const c = await work("dev1@lane");
    await sweep();
    const [notice] = findingsTo("owner@lane");
    queue.claim({ qitemId: a.qitemId, destinationSession: "dev1@lane" });
    queue.update({ qitemId: b.qitemId, actorSession: "dev1@lane", state: "blocked", blockedOn: "external:ci", transitionNote: "parked" });
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending", summary: expect.stringContaining("(1 row)") });
    queue.update({ qitemId: c.qitemId, actorSession: "dev1@lane", state: "done", closureReason: "no-follow-on", transitionNote: "dropped" });
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(findingsTo("owner@lane")).toHaveLength(1);
  });

  it("stands for every row past the 20 it lists: a row only counted keeps the notice open", async () => {
    lane("dev1");
    const rows: QueueItem[] = [];
    for (let i = 0; i < 25; i++) rows.push(await work("dev1@lane", 90));
    await sweep();
    const [notice] = findingsTo("owner@lane");
    expect(notice!.summary).toContain("(25 rows)");
    expect(notice!.body.split("\n").filter((line) => line.startsWith("- qitem-"))).toHaveLength(20);
    expect(notice!.body).toContain("- and 5 more");
    const counted = rows.find((r) => !notice!.body.includes(`- ${r.qitemId}`))!;
    for (const r of rows) if (r.qitemId !== counted.qitemId) queue.claim({ qitemId: r.qitemId, destinationSession: "dev1@lane" });
    // A raised threshold stops detection, which isn't resolution.
    await sweep(120);
    const after = queue.getById(notice!.qitemId)!;
    expect(after).toMatchObject({ state: "pending", summary: expect.stringContaining("(1 row)") });
    expect(after.body).toContain(`- ${counted.qitemId}`);
  });

  it("when the child's parent changes, the old parent's notice closes and the new parent gets one for every row", async () => {
    const { parent, kids } = lane("dev1");
    const rows = [await work("dev1@lane"), await work("dev1@lane")];
    await sweep();
    const [old] = findingsTo("owner@lane");
    const lead2 = seat("lane", "coord.second", "second@lane");
    db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'delegates_to'").run(parent.node.id, kids[0]!.node.id);
    rigs.addEdge(parent.rig.id, lead2.node.id, kids[0]!.node.id, "delegates_to");
    await sweep();
    expect(queue.getById(old!.qitemId)).toMatchObject({ state: "done" });
    const moved = findingsTo("second@lane");
    expect(moved).toHaveLength(1);
    expect(moved[0]!.tags).toContain(parentBacklogTag("second@lane", "dev1@lane"));
    for (const row of rows) expect(moved[0]!.body).toContain(row.qitemId);
  });

  it("a dismissed notice holds back only the rows it stood for; new evidence files a new notice for all of them", async () => {
    lane("dev1");
    const old = await work("dev1@lane", 240);
    await sweep();
    const [first] = findingsTo("owner@lane");
    queue.update({ qitemId: first!.qitemId, actorSession: "owner@lane", state: "done", closureReason: "no-follow-on", transitionNote: "seen" });
    age(first!.qitemId, 180);
    await sweep();
    expect(findingsTo("owner@lane").filter(isOpen)).toHaveLength(0);
    const newer = await work("dev1@lane", 120);
    await sweep();
    const reopened = findingsTo("owner@lane").filter(isOpen);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.summary).toContain("(2 rows)");
    expect(reopened[0]!.body).toContain(old.qitemId);
    expect(reopened[0]!.body).toContain(newer.qitemId);
  });

  /** The notice's body without its list of rows, or with that list cut short, as an unreadable stored body would be. */
  function breakRowList(qitemId: string, how: "missing" | "malformed") {
    const prefix = "Every row this notice stands for: ";
    const body = queue.getById(qitemId)!.body.split("\n").filter((line) => !line.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(how === "malformed" ? `${body}\n${prefix}[` : body, qitemId);
  }

  it.each(["missing", "malformed"] as const)("unknown membership is not resolution: a notice whose list is %s stays open", async (how) => {
    lane("dev1");
    await work("dev1@lane", 90);
    await sweep();
    const [notice] = findingsTo("owner@lane");
    expect(notice!.tags).toContain(parentBacklogTag("owner@lane", "dev1@lane"));
    breakRowList(notice!.qitemId, how);
    await sweep(120);
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending" });
  });

  // Review of #3049: an unreadable list is never narrowed to the rows that qualify on a pass: it is rebuilt from every
  // row still waiting unclaimed at the seat, and closes only once none of those is left.
  it.each([["missing", "parent"], ["malformed", "parent"], ["missing", "own"], ["malformed", "own"]] as const)(
    "a notice whose list is %s is rebuilt from every waiting row, never narrowed to the rows that qualify (%s notice)", async (how, kind) => {
      if (kind === "parent") lane("dev1"); else seat("lane", "pool.dev1", "dev1@lane");
      const to = kind === "parent" ? "owner@lane" : "dev1@lane";
      const a = await work("dev1@lane", 180);
      const b = await work("dev1@lane", 90);
      await sweep(60);
      const [notice] = findingsTo(to);
      expect(notice!.body).toContain(a.qitemId);
      expect(notice!.body).toContain(b.qitemId);
      breakRowList(notice!.qitemId, how);
      await sweep(120); // only A qualifies now; the list is rebuilt from every row still waiting, never just A
      const rebuilt = queue.getById(notice!.qitemId)!;
      expect(rebuilt.state).toBe("pending");
      const footer = rebuilt.body.split("\n").find((l) => l.startsWith("Every row this notice stands for: "))!;
      expect(JSON.parse(footer.slice("Every row this notice stands for: ".length)).sort()).toEqual([a.qitemId, b.qitemId].sort());
      queue.claim({ qitemId: a.qitemId, destinationSession: "dev1@lane" });
      await sweep(120);
      expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending" });
      expect(queue.getById(notice!.qitemId)!.body).toContain(b.qitemId);
      expect(queue.getById(b.qitemId)).toMatchObject({ state: "pending", claimedAt: null });
      // Once nothing it could stand for still waits, it closes: an unreadable list doesn't keep it open for ever.
      queue.claim({ qitemId: b.qitemId, destinationSession: "dev1@lane" });
      await sweep(120);
      expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done" });
    });

  it.each(["parent", "own"] as const)("a %s notice whose list was unreadable holds nothing back once it closes: a row it never listed gets a notice later", async (kind) => {
    if (kind === "parent") lane("dev1"); else seat("lane", "pool.dev1", "dev1@lane");
    const to = kind === "parent" ? "owner@lane" : "dev1@lane";
    const a = await work("dev1@lane", 90);
    await sweep();
    const [notice] = findingsTo(to);
    // Q waits behind a typing guard (resolution evidence), so it never qualifies while the guard holds.
    const q = await work("dev1@lane", 90);
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = 'retained:typing_guard' WHERE qitem_id = ?")
      .run(new Date().toISOString(), q.qitemId);
    breakRowList(notice!.qitemId, "missing");
    queue.claim({ qitemId: a.qitemId, destinationSession: "dev1@lane" });
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done" });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = NULL, last_nudge_result = NULL WHERE qitem_id = ?").run(q.qitemId);
    await sweep();
    await sweep();
    expect(openFor(q).length).toBeGreaterThan(0);
  });

  it.each(["parent", "own"] as const)("a readable %s notice reports its row again after a transient typing hold clears", async (kind) => {
    if (kind === "parent") lane("dev1"); else seat("lane", "pool.dev1", "dev1@lane");
    const to = kind === "parent" ? "owner@lane" : "dev1@lane";
    const row = await work("dev1@lane", 90);
    await sweep();
    const [notice] = findingsTo(to);
    expect(notice!.body).toContain(`Every row this notice stands for: ["${row.qitemId}"]`);
    const before = queue.getById(row.qitemId)!;
    db.prepare("UPDATE queue_items SET last_nudge_result = 'retained:typing_guard' WHERE qitem_id = ?").run(row.qitemId);
    await sweep();
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done" });
    expect(findingsTo(to).filter(isOpen)).toHaveLength(0);
    // No new row transition, timestamp or wake attempt: ending the temporary custody is the new fact.
    db.prepare("UPDATE queue_items SET last_nudge_result = NULL WHERE qitem_id = ?").run(row.qitemId);
    await sweep();
    await sweep();
    const open = findingsTo(to).filter(isOpen);
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain(row.qitemId);
    expect(open[0]!.qitemId).not.toBe(notice!.qitemId);
    expect(queue.getById(row.qitemId)).toMatchObject({ state: "pending", claimedAt: null,
      tsUpdated: before.tsUpdated, lastNudgeAttempt: before.lastNudgeAttempt });
  });

  it.each(["parent", "own"] as const)("a dismissed %s notice still holds back its row across a transient typing hold", async (kind) => {
    if (kind === "parent") lane("dev1"); else seat("lane", "pool.dev1", "dev1@lane");
    const to = kind === "parent" ? "owner@lane" : "dev1@lane";
    const row = await work("dev1@lane", 90);
    await sweep();
    const [notice] = findingsTo(to);
    await queue.update({ qitemId: notice!.qitemId, actorSession: to, state: "done",
      closureReason: "no-follow-on", transitionNote: "seen" });
    db.prepare("UPDATE queue_items SET last_nudge_result = 'retained:typing_guard' WHERE qitem_id = ?").run(row.qitemId);
    await sweep();
    db.prepare("UPDATE queue_items SET last_nudge_result = NULL WHERE qitem_id = ?").run(row.qitemId);
    await sweep();
    expect(findingsTo(to)).toHaveLength(1);
    expect(findingsTo(to).filter(isOpen)).toHaveLength(0);
  });

  // Review of #3049: the route is rechecked at the fold, not only the finding's state: a parent resolution that changes
  // or becomes ambiguous while the notice is being written leaves the per-row finding open and unmarked.
  it.each(["ambiguous", "gone"] as const)("a fold rechecks the route: a parent that becomes %s while the notice is written folds nothing", async (change) => {
    const { parent, kids } = lane("dev1");
    const row = await work("dev1@lane");
    const perRow = await perRowFinding(row);
    const create = queue.create.bind(queue);
    queue.create = (async (input: Parameters<typeof queue.create>[0]) => {
      if ((input.tags ?? []).includes(parentBacklogTag("owner@lane", "dev1@lane"))) {
        if (change === "ambiguous") {
          const other = seat("lane", "coord.other", "other@lane");
          rigs.addEdge(other.rig.id, other.node.id, kids[0]!.node.id, "delegates_to");
        } else {
          db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'delegates_to'").run(parent.node.id, kids[0]!.node.id);
        }
      }
      return create(input);
    }) as typeof queue.create;
    await sweep();
    const after = queue.getById(perRow.qitemId)!;
    expect(after.state).toBe("pending");
    expect(after.tags).not.toContain("stuck-sweep-folded-into-backlog");
    expect(findQueueRecovery(db, row.qitemId)).toMatchObject({ qitemId: perRow.qitemId });
  });

  it("a fold rechecks that the row still waits unclaimed: one claimed while the notice is written isn't folded", async () => {
    lane("dev1");
    const row = await work("dev1@lane");
    const perRow = await perRowFinding(row);
    const create = queue.create.bind(queue);
    queue.create = (async (input: Parameters<typeof queue.create>[0]) => {
      const made = await create(input);
      if ((input.tags ?? []).includes(parentBacklogTag("owner@lane", "dev1@lane"))) queue.claim({ qitemId: row.qitemId, destinationSession: "dev1@lane" });
      return made;
    }) as typeof queue.create;
    await sweep();
    // Its finding resolves the way a claimed row's does (the sweep's own resolution), never by a fold.
    const after = queue.getById(perRow.qitemId)!;
    expect(after.tags).not.toContain("stuck-sweep-folded-into-backlog");
  });

  // Review of #3049: a fold rechecks the whole rule that made the row's finding, on the row as it is now: a row whose wake
  // fails while the notice is written keeps its finding, open and unmarked.
  it("a fold rechecks the row's eligibility: one whose wake fails while the notice is written isn't folded", async () => {
    lane("dev1");
    const row = await work("dev1@lane");
    const perRow = await perRowFinding(row);
    const create = queue.create.bind(queue);
    queue.create = (async (input: Parameters<typeof queue.create>[0]) => {
      const made = await create(input);
      if ((input.tags ?? []).includes(parentBacklogTag("owner@lane", "dev1@lane"))) {
        db.prepare("UPDATE queue_items SET last_nudge_result = 'failed: pane gone' WHERE qitem_id = ?").run(row.qitemId);
      }
      return made;
    }) as typeof queue.create;
    await sweep();
    const after = queue.getById(perRow.qitemId)!;
    expect(after.state).toBe("pending");
    expect(after.tags).not.toContain("stuck-sweep-folded-into-backlog");
  });

  // Review of #3049: a parent's notice that changed hands (a handoff, a fallback) no longer reaches the parent, so a
  // per-row finding at the parent is never folded into it: the parent keeps its own signal for that row.
  it.each(["handoff", "fallback"] as const)("a fold needs the notice still at the parent: one that changed hands by %s takes no finding", async (how) => {
    lane("dev1");
    seat("lane", "coord.other", "other@lane");
    await work("dev1@lane");
    await sweep();
    const [notice] = findingsTo("owner@lane").filter(isOpen);
    expect(notice!.tags).toContain(parentBacklogTag("owner@lane", "dev1@lane"));
    if (how === "handoff") {
      await queue.handoff({ qitemId: notice!.qitemId, fromSession: "owner@lane", toSession: "other@lane", nudge: false });
    } else {
      queue.routeToFallback(notice!.qitemId, "other@lane", "owner@lane stopped");
    }
    const row = await work("dev1@lane");
    const perRow = await perRowFinding(row);
    await sweep();
    const after = queue.getById(perRow.qitemId)!;
    expect(after.state).toBe("pending");
    expect(after.tags).not.toContain("stuck-sweep-folded-into-backlog");
  });

  it("a closed notice whose list is unreadable doesn't file again for the same rows", async () => {
    lane("dev1");
    await work("dev1@lane", 90);
    await sweep();
    const [notice] = findingsTo("owner@lane");
    expect(notice!.tags).toContain(parentBacklogTag("owner@lane", "dev1@lane"));
    queue.update({ qitemId: notice!.qitemId, actorSession: "owner@lane", state: "done", closureReason: "no-follow-on", transitionNote: "seen" });
    breakRowList(notice!.qitemId, "missing");
    await sweep();
    expect(findingsTo("owner@lane").filter(isOpen)).toHaveLength(0);
  });

  it("folds an open per-row finding for a grouped row into the notice and closes it, rather than keeping both", async () => {
    lane("dev1");
    const row = await work("dev1@lane");
    const other = await work("dev1@lane");
    // A finding per row, as the sweep filed it to the parent before #2988.
    const tag = findingDedupTag("unclaimed-obligation", row.qitemId);
    const perRow = await queue.create({ qitemId: recoveryId(db, row.qitemId), sourceSession: "sender@lane",
      destinationSession: "owner@lane", body: "STUCK SWEEP FINDING (unclaimed-obligation)",
      summary: `Stuck sweep: unclaimed-obligation on ${row.qitemId} (90 min)`, tags: [STUCK_SWEEP_FINDING_TAG, tag, recoveryTag(row.qitemId)],
      nudge: false });
    await sweep();
    const notices = findingsTo("owner@lane").filter((f) => f.tags?.includes(parentBacklogTag("owner@lane", "dev1@lane")));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain(row.qitemId);
    expect(notices[0]!.body).toContain(other.qitemId);
    const closed = queue.getById(perRow.qitemId)!;
    expect(closed).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(findingsTo("owner@lane").filter(isOpen)).toHaveLength(1);
    expect(queue.getById(row.qitemId)).toMatchObject({ state: "pending", destinationSession: "dev1@lane" });
    // Folding releases custody for every reader, not only the sweep: the row is like one that never had a finding of its
    // own (the wake ladder and the waiting view no longer see a recovery owning it). A finding someone closed by hand
    // keeps owning its row, as before.
    expect(findQueueRecovery(db, row.qitemId)).toBeNull();
    expect(queueRecoveryOwnsWake(db, queue.getById(row.qitemId)!)).toBe(false);
    await sweep();
    expect(findingsTo("owner@lane").filter(isOpen)).toHaveLength(1);
    expect(findingsTo("owner@lane").filter(isOpen)[0]!.body).toContain(row.qitemId);
  });

  it("a per-row finding closed by hand still owns its row: it isn't folded, and the row stays out of the notice", async () => {
    lane("dev1");
    const row = await work("dev1@lane");
    const perRow = await queue.create({ qitemId: recoveryId(db, row.qitemId), sourceSession: "sender@lane",
      destinationSession: "owner@lane", body: "STUCK SWEEP FINDING (unclaimed-obligation)",
      summary: `Stuck sweep: unclaimed-obligation on ${row.qitemId} (90 min)`,
      tags: [STUCK_SWEEP_FINDING_TAG, findingDedupTag("unclaimed-obligation", row.qitemId), recoveryTag(row.qitemId)], nudge: false });
    queue.update({ qitemId: perRow.qitemId, actorSession: "owner@lane", state: "done", closureReason: "no-follow-on", transitionNote: "seen" });
    await sweep();
    expect(findQueueRecovery(db, row.qitemId)).toMatchObject({ qitemId: perRow.qitemId });
    expect(findingsTo("owner@lane").filter(isOpen)).toHaveLength(0);
  });

  it("keeps the per-row finding open when the notice that would take it couldn't be written", async () => {
    lane("dev1");
    const row = await work("dev1@lane");
    const perRow = await queue.create({ qitemId: recoveryId(db, row.qitemId), sourceSession: "sender@lane",
      destinationSession: "owner@lane", body: "STUCK SWEEP FINDING (unclaimed-obligation)",
      summary: `Stuck sweep: unclaimed-obligation on ${row.qitemId} (90 min)`,
      tags: [STUCK_SWEEP_FINDING_TAG, findingDedupTag("unclaimed-obligation", row.qitemId), recoveryTag(row.qitemId)], nudge: false });
    db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON queue_items WHEN NEW.tags LIKE '%unclaimed-backlog%' BEGIN SELECT RAISE(ABORT, 'notice write failed'); END");
    const result = await sweep();
    expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining("notice write failed") });
    expect(queue.getById(perRow.qitemId)).toMatchObject({ state: "pending" });
  });

  /** A per-row unclaimed finding at `to` for `row`, as the sweep filed one before #2988. */
  async function perRowFinding(row: QueueItem, to = "owner@lane"): Promise<QueueItem> {
    return queue.create({ qitemId: recoveryId(db, row.qitemId), sourceSession: "sender@lane", destinationSession: to,
      body: "STUCK SWEEP FINDING (unclaimed-obligation)", summary: `Stuck sweep: unclaimed-obligation on ${row.qitemId} (90 min)`,
      tags: [STUCK_SWEEP_FINDING_TAG, findingDedupTag("unclaimed-obligation", row.qitemId), recoveryTag(row.qitemId)], nudge: false });
  }
  /** Every open sweep finding or notice, anywhere, that names `row`. */
  const openFor = (row: QueueItem) => queue.list({ limit: 1000 })
    .filter((i) => isOpen(i) && (i.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG))
    .map((i) => queue.getById(i.qitemId)!)
    .filter((i) => i.body.includes(row.qitemId) || (i.tags ?? []).includes(findingDedupTag("unclaimed-obligation", row.qitemId)));

  it("a folded row whose route stops being the parent gets a finding of its own again, never silence", async () => {
    const { kids } = lane("dev1");
    const row = await work("dev1@lane");
    await perRowFinding(row);
    await sweep();
    expect(openFor(row)).toHaveLength(1);
    // A second declared parent: the route is ambiguous, so the row's finding no longer goes to owner@lane.
    const other = seat("lane", "coord.other", "other@lane");
    rigs.addEdge(other.rig.id, other.node.id, kids[0]!.node.id, "delegates_to");
    await sweep();
    await sweep();
    const open = openFor(row);
    expect(open).toHaveLength(1);
    expect(open[0]!.tags).toContain(findingDedupTag("unclaimed-obligation", row.qitemId));
  });

  it("a row whose parent changes and changes back is still in an open notice (P1 -> P2 -> P1)", async () => {
    const { parent, kids } = lane("dev1");
    const row = await work("dev1@lane");
    await sweep();
    const second = seat("lane", "coord.second", "second@lane");
    const swap = (from: string, to: string) => {
      db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'delegates_to'").run(from, kids[0]!.node.id);
      rigs.addEdge(parent.rig.id, to, kids[0]!.node.id, "delegates_to");
    };
    swap(parent.node.id, second.node.id);
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["second@lane"]);
    swap(second.node.id, parent.node.id);
    await sweep();
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["owner@lane"]);
  });

  it("a seat that gains a delegation parent hands its rows from its own notice to the parent's, not both", async () => {
    const solo = seat("lane", "pool.dev1", "dev1@lane");
    const row = await work("dev1@lane");
    await sweep();
    const [own] = findingsTo("dev1@lane");
    expect(own!.tags).toContain("stuck-sweep:unclaimed-backlog:dev1@lane");
    const parent = seat("lane", "coord.owner", "owner@lane");
    rigs.addEdge(solo.rig.id, parent.node.id, solo.node.id, "delegates_to");
    await sweep();
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["owner@lane"]);
    expect(queue.getById(own!.qitemId)).toMatchObject({ state: "done" });
  });

  /** Moves dev1's one declared delegation parent from one lead node to another. */
  const moveParent = (rigId: string, kid: string, from: string, to: string) => {
    db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'delegates_to'").run(from, kid);
    rigs.addEdge(rigId, to, kid, "delegates_to");
  };

  it("a row folded twice still gets a finding of its own when its route leaves the parent again, never silence", async () => {
    // dev1 escalates to owner@lane; owner@lane's delegates_to over dev1 comes and goes (a pool seat's lead, re-declared).
    const owner = seat("lane", "coord.owner", "owner@lane");
    const dev1 = seat("lane", "pool.dev1", "dev1@lane");
    rigs.addEdge(dev1.rig.id, dev1.node.id, "owner@lane", "escalates_to");
    const delegate = (on: boolean) => on
      ? rigs.addEdge(owner.rig.id, owner.node.id, dev1.node.id, "delegates_to")
      : db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'delegates_to'").run(owner.node.id, dev1.node.id);
    const row = await work("dev1@lane");
    await sweep(); // a finding per row, by escalates_to
    delegate(true);
    await sweep(); // folded into the parent's notice
    delegate(false);
    await sweep(); // a finding of its own again
    delegate(true);
    await sweep();
    await work("dev1@lane");
    await sweep(); // a new notice for both rows folds that second finding too
    const folded = queue.list({ limit: 1000 }).filter((i) => (i.tags ?? []).includes("stuck-sweep-folded-into-backlog")
      && (i.tags ?? []).includes(findingDedupTag("unclaimed-obligation", row.qitemId)));
    expect(folded).toHaveLength(2);
    delegate(false);
    const result = await sweep();
    await sweep();
    const open = openFor(row);
    expect(open).toHaveLength(1);
    expect(open[0]!.tags).toContain(findingDedupTag("unclaimed-obligation", row.qitemId));
    expect(folded.map((f) => f.qitemId)).not.toContain(open[0]!.qitemId);
    expect(result.findings.filter((f) => f.qitemId === row.qitemId && f.action === "created").map((f) => f.findingQitemId)).toEqual([open[0]!.qitemId]);
  });

  it("a row whose parent goes away under a detection filter stays in the old notice until where it goes now takes it", async () => {
    const { parent, kids } = lane("dev1");
    const row = await work("dev1@lane");
    await sweep();
    const [notice] = findingsTo("owner@lane");
    db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'delegates_to'").run(parent.node.id, kids[0]!.node.id);
    // A raised threshold stops detection, which isn't resolution: the old notice keeps standing for the row.
    await sweep(120);
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "pending" });
    expect(queue.getById(notice!.qitemId)!.body).toContain("note: dev1@lane's rows no longer go to owner@lane.");
    expect(openFor(row).map((f) => f.qitemId)).toEqual([notice!.qitemId]);
    // Detected again, it goes to the seat's own notice, and the old one lets go of it.
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["dev1@lane"]);
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done" });
  });

  it("a row whose parent changes under a detection filter stays in the old parent's notice until the new one takes it", async () => {
    const { parent, kids } = lane("dev1");
    const row = await work("dev1@lane");
    await sweep();
    const [notice] = findingsTo("owner@lane");
    const second = seat("lane", "coord.second", "second@lane");
    moveParent(parent.rig.id, kids[0]!.node.id, parent.node.id, second.node.id);
    await sweep(120);
    expect(openFor(row).map((f) => f.qitemId)).toEqual([notice!.qitemId]);
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["second@lane"]);
    expect(queue.getById(notice!.qitemId)).toMatchObject({ state: "done" });
  });

  it("a row a seat's own notice let go of for a finding of its own reaches a notice again once that finding is folded", async () => {
    const owner = seat("lane", "coord.owner", "owner@lane");
    const dev1 = seat("lane", "pool.dev1", "dev1@lane");
    const row = await work("dev1@lane");
    await sweep(); // the seat's own notice
    const [own] = findingsTo("dev1@lane");
    rigs.addEdge(dev1.rig.id, dev1.node.id, "owner@lane", "escalates_to");
    await sweep(); // a finding of its own at owner@lane; the seat's notice closes
    expect(queue.getById(own!.qitemId)).toMatchObject({ state: "done" });
    rigs.addEdge(owner.rig.id, owner.node.id, dev1.node.id, "delegates_to");
    await sweep(); // that finding folds into the parent's notice
    db.prepare("DELETE FROM edges WHERE kind IN ('delegates_to', 'escalates_to')").run();
    for (let i = 0; i < 3; i++) await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["dev1@lane"]);
  });

  it("an old parent's notice keeps a row whose new parent's notice couldn't be written, and lets go of it once that one is", async () => {
    const { parent, kids } = lane("dev1");
    const row = await work("dev1@lane");
    await sweep();
    const [old] = findingsTo("owner@lane");
    const second = seat("lane", "coord.second", "second@lane");
    moveParent(parent.rig.id, kids[0]!.node.id, parent.node.id, second.node.id);
    db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON queue_items WHEN NEW.destination_session = 'second@lane' BEGIN SELECT RAISE(ABORT, 'notice write failed'); END");
    const failed = await sweep();
    expect(failed).toMatchObject({ outcome: "failed", error: expect.stringContaining("notice write failed") });
    expect(openFor(row).map((f) => f.qitemId)).toEqual([old!.qitemId]);
    db.exec("DROP TRIGGER fail_second");
    await sweep();
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["second@lane"]);
    expect(queue.getById(old!.qitemId)).toMatchObject({ state: "done" });
  });

  it("a notice the current parent dismissed holds the row back for an earlier parent's notice too, which closes", async () => {
    const { parent, kids } = lane("dev1");
    const second = seat("lane", "coord.second", "second@lane");
    moveParent(parent.rig.id, kids[0]!.node.id, parent.node.id, second.node.id);
    const row = await work("dev1@lane", 240);
    await sweep();
    const [dismissed] = findingsTo("second@lane");
    queue.update({ qitemId: dismissed!.qitemId, actorSession: "second@lane", state: "done", closureReason: "no-follow-on", transitionNote: "seen" });
    age(dismissed!.qitemId, 200);
    moveParent(parent.rig.id, kids[0]!.node.id, second.node.id, parent.node.id);
    await sweep();
    const [earlier] = findingsTo("owner@lane");
    expect(earlier).toMatchObject({ state: "pending" });
    moveParent(parent.rig.id, kids[0]!.node.id, parent.node.id, second.node.id);
    await sweep();
    await sweep();
    expect(queue.getById(earlier!.qitemId)).toMatchObject({ state: "done" });
    expect(openFor(row)).toHaveLength(0);
    // New evidence after the dismissal files a new notice at the current parent.
    const newer = await work("dev1@lane", 120);
    await sweep();
    const reopened = findingsTo("second@lane").filter(isOpen);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.body).toContain(row.qitemId);
    expect(reopened[0]!.body).toContain(newer.qitemId);
  });

  it("an old parent's notice whose list is unreadable stays while a row of the seat has no signal elsewhere (a detection filter, a failed create)", async () => {
    const { parent, kids } = lane("dev1");
    const row = await work("dev1@lane");
    await sweep();
    const [old] = findingsTo("owner@lane");
    breakRowList(old!.qitemId, "malformed");
    const second = seat("lane", "coord.second", "second@lane");
    moveParent(parent.rig.id, kids[0]!.node.id, parent.node.id, second.node.id);
    await sweep(120);
    expect(queue.getById(old!.qitemId)).toMatchObject({ state: "pending" });
    db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON queue_items WHEN NEW.destination_session = 'second@lane' BEGIN SELECT RAISE(ABORT, 'notice write failed'); END");
    expect(await sweep()).toMatchObject({ outcome: "failed" });
    expect(queue.getById(old!.qitemId)).toMatchObject({ state: "pending" });
    db.exec("DROP TRIGGER fail_second");
    await sweep();
    await sweep();
    expect(queue.getById(old!.qitemId)).toMatchObject({ state: "done" });
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["second@lane"]);
  });

  it("an old parent's notice whose list is unreadable closes once the seat's parent changes, holding nothing back", async () => {
    const { parent, kids } = lane("dev1");
    const row = await work("dev1@lane");
    await sweep();
    const [old] = findingsTo("owner@lane");
    breakRowList(old!.qitemId, "missing");
    const second = seat("lane", "coord.second", "second@lane");
    moveParent(parent.rig.id, kids[0]!.node.id, parent.node.id, second.node.id);
    await sweep();
    await sweep();
    expect(queue.getById(old!.qitemId)).toMatchObject({ state: "done" });
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["second@lane"]);
    // Back to the first parent: the closed notice holds the row back from nobody.
    moveParent(parent.rig.id, kids[0]!.node.id, second.node.id, parent.node.id);
    await sweep();
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["owner@lane"]);
  });

  it("a polling hosted member that gains a delegation parent hands its rows from its own notice to the parent's, not both", async () => {
    // helper@lane has no terminal and no wake trigger: it reads its own inbox, and its rows share one polled notice.
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }),
      isHostedMember: (d) => d === "helper@lane", hostedWake: () => null });
    const owner = seat("lane", "coord.owner", "owner@lane");
    const helper = seat("lane", "pool.helper", "helper@lane");
    expect(queue.classifyDestinationOf("helper@lane").class).toBe("unroutable");
    const row = await work("helper@lane");
    await sweep();
    const [own] = openFor(row);
    expect(own!.tags).toContain("stuck-sweep:unclaimed-backlog:helper@lane");
    rigs.addEdge(owner.rig.id, owner.node.id, helper.node.id, "delegates_to");
    await sweep();
    await sweep();
    expect(openFor(row).map((f) => f.destinationSession)).toEqual(["owner@lane"]);
    expect(queue.getById(own!.qitemId)).toMatchObject({ state: "done" });
  });

  it.each(["in-progress", "blocked"] as const)("doesn't fold a per-row finding the parent has taken up (%s)", async (state) => {
    lane("dev1");
    const row = await work("dev1@lane");
    const perRow = await perRowFinding(row);
    if (state === "in-progress") queue.claim({ qitemId: perRow.qitemId, destinationSession: "owner@lane" });
    else queue.update({ qitemId: perRow.qitemId, actorSession: "owner@lane", state: "blocked", blockedOn: "external:ask", transitionNote: "asking" });
    await sweep();
    expect(queue.getById(perRow.qitemId)).toMatchObject({ state });
    expect(queue.getById(perRow.qitemId)!.tags).not.toContain("stuck-sweep-folded-into-backlog");
    expect(findingsTo("owner@lane").filter((f) => f.tags?.includes(parentBacklogTag("owner@lane", "dev1@lane")))).toHaveLength(0);
  });

  it("a fold whose close fails leaves the per-row finding as it was, open and unmarked", async () => {
    lane("dev1");
    const row = await work("dev1@lane");
    const perRow = await perRowFinding(row);
    db.exec(`CREATE TRIGGER fail_fold BEFORE UPDATE OF state ON queue_items WHEN NEW.qitem_id = '${perRow.qitemId}' AND NEW.state = 'done'
      BEGIN SELECT RAISE(ABORT, 'fold close failed'); END`);
    const result = await sweep();
    expect(result.outcome).toBe("failed");
    const after = queue.getById(perRow.qitemId)!;
    expect(after.state).toBe("pending");
    expect(after.tags).not.toContain("stuck-sweep-folded-into-backlog");
  });

  it("leaves the other finding kinds per row: a claim past its deadline still gets its own finding", async () => {
    lane("dev1");
    const late = await work("dev1@lane");
    queue.claim({ qitemId: late.qitemId, destinationSession: "dev1@lane" });
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(new Date(Date.now() - 30 * 60_000).toISOString(), late.qitemId);
    const waiting = await work("dev1@lane");
    await sweep();
    // The claimant holds the obligation: its finding is its own, per row, as before.
    const all = queue.list({ limit: 1000 });
    expect(all.some((i) => i.tags?.includes(findingDedupTag("overdue-claim", late.qitemId)))).toBe(true);
    const filed = findingsTo("owner@lane");
    const notice = filed.find((f) => f.tags?.includes(parentBacklogTag("owner@lane", "dev1@lane")))!;
    expect(notice.body).toContain(waiting.qitemId);
    expect(notice.body).not.toContain(late.qitemId);
  });

  it("a seat with no delegation parent keeps its own standing notice (#2430), and an escalates_to route keeps a finding per row", async () => {
    seat("front", "door.root", "root@front");
    const door = await work("root@front");
    const watched = seat("other", "work.solo", "solo@other");
    seat("ops", "watch.desk", "desk@ops");
    rigs.addEdge(watched.rig.id, watched.node.id, "desk@ops", "escalates_to");
    const routed = await work("solo@other");
    await sweep();
    expect(findingsTo("root@front")[0]!.tags).toContain("stuck-sweep:unclaimed-backlog:root@front");
    expect(findingsTo("root@front")[0]!.body).toContain(door.qitemId);
    expect(findingsTo("desk@ops").map((f) => f.tags)).toEqual([expect.arrayContaining([findingDedupTag("unclaimed-obligation", routed.qitemId)])]);
  });
});
