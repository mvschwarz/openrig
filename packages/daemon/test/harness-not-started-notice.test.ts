// An attempt that positively leaves seats as bare shells tells each seat's resolved escalation owner once, grouped by
// that owner. A seat with no single destination stays in the report with its routing fact, and nothing is sent for it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { noticeHarnessNotStarted } from "../src/domain/harness-not-started-notice.js";

describe("the grouped notice for seats left as bare shells", () => {
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
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,'running')").run(`session-${++seq}`, node.id, session);
    return { rig, node, session };
  }
  const notices = () => db.prepare("SELECT qitem_id, destination_session, body FROM queue_items WHERE qitem_id LIKE 'qitem-harness-not-started-%'")
    .all() as Array<{ qitem_id: string; destination_session: string; body: string }>;

  it("sends one notice per resolved owner, naming that owner's seats", async () => {
    const lead = seat("crew", "lead", "lead@crew");
    const other = seat("crew", "other", "other@crew");
    const a = seat("crew", "a", "a@crew");
    const b = seat("crew", "b", "b@crew");
    const c = seat("crew", "c", "c@crew");
    rigs.addEdge(lead.rig.id, lead.node.id, a.node.id, "delegates_to");
    rigs.addEdge(lead.rig.id, lead.node.id, b.node.id, "delegates_to");
    rigs.addEdge(lead.rig.id, other.node.id, c.node.id, "delegates_to");
    const report = await noticeHarnessNotStarted(db, queue, { rigId: lead.rig.id, attempt: "restore attempt 7",
      seats: [a, b, c].map(({ node }) => ({ nodeId: node.id, logicalId: node.logicalId })) });

    expect(report.unrouted).toEqual([]);
    expect(report.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "lead@crew", seats: ["a@crew", "b@crew"] }),
      expect.objectContaining({ owner: "other@crew", seats: ["c@crew"] }),
    ]));
    expect(notices().map((n) => n.destination_session).sort()).toEqual(["lead@crew", "other@crew"]);
    expect(notices().find((n) => n.destination_session === "lead@crew")!.body).toMatch(/- a@crew\n- b@crew/);
  });

  it("adds nothing when the same attempt runs again, and a new attempt gets its own notice", async () => {
    const lead = seat("crew", "lead", "lead@crew");
    const a = seat("crew", "a", "a@crew");
    rigs.addEdge(lead.rig.id, lead.node.id, a.node.id, "delegates_to");
    const input = { rigId: lead.rig.id, attempt: "restore attempt 7", seats: [{ nodeId: a.node.id, logicalId: a.node.logicalId }] };
    const first = await noticeHarnessNotStarted(db, queue, input);
    const again = await noticeHarnessNotStarted(db, queue, input);

    expect(again.notices).toEqual(first.notices);
    expect(notices()).toHaveLength(1);
    await noticeHarnessNotStarted(db, queue, { ...input, attempt: "restore attempt 8" });
    expect(notices()).toHaveLength(2);
  });

  it("keeps a seat with no single destination in the report with its routing fact, and sends nothing for it", async () => {
    const one = seat("crew", "one", "one@crew");
    const two = seat("crew", "two", "two@crew");
    const shared = seat("crew", "shared", "shared@crew");
    const alone = seat("crew", "alone", "alone@crew");
    rigs.addEdge(one.rig.id, one.node.id, shared.node.id, "delegates_to");
    rigs.addEdge(one.rig.id, two.node.id, shared.node.id, "delegates_to");
    const report = await noticeHarnessNotStarted(db, queue, { rigId: one.rig.id, attempt: "launch attempt 3",
      seats: [shared, alone].map(({ node }) => ({ nodeId: node.id, logicalId: node.logicalId })) });

    expect(report.notices).toEqual([]);
    expect(report.unrouted).toEqual([
      expect.objectContaining({ seat: "shared@crew", outcome: "ambiguous" }),
      expect.objectContaining({ seat: "alone@crew", outcome: "none" }),
    ]);
    expect(notices()).toEqual([]);
  });
});
