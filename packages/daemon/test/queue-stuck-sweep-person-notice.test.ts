// A person answers a seat, and the seat can't be woken (it's at its usage limit, say). The finding about that row went
// back to the person who created it, from that person and as an ask: a TO DO in their Needs you that they owed themselves.
// It now reaches them as a notice from OpenRig: an update, from the sweep, naming the seat their answer waits for.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { hasLiveHumanGate, QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { runStuckSweep, createStuckSweepStatus, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

const PERSON = { entityId: "person", class: "human", displayName: "Person", address: "person@external",
  connectorBindings: [], prefs: {} } as unknown as HumanFragment;

describe("stuck sweep: a finding about a person's own row that comes back to them", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let queue: QueueRepository;
  let registryReadable: boolean;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db);
    registryReadable = true;
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true,
      loadHumanRegistry: () => registryReadable ? { ok: true as const, entities: [PERSON] } : { ok: false as const, error: "unreadable" } });
    const rig = rigs.createRig("lane");
    const node = rigs.addNode(rig.id, "work.lead", { runtime: "claude-code" });
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,?)").run("session-1", node.id, "lead@lane", "running");
  });
  afterEach(() => db.close());

  const sweep = () => runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60,
    log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null });
  /** A row from `source` to lead@lane whose wake failed. */
  async function failedWake(source: string): Promise<QueueItem> {
    const row = await queue.create({ sourceSession: source, destinationSession: "lead@lane", body: "Yes, ship the smaller one", nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(new Date().toISOString(), "failed:usage_limit", row.qitemId);
    return row;
  }
  const findingFor = (row: QueueItem): QueueItem => {
    const found = queue.list({ limit: 500 }).filter((item) => (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG)
      && (item.tags ?? []).includes(`stuck-sweep:undelivered-wake:${row.qitemId}`));
    expect(found).toHaveLength(1);
    return queue.getById(found[0]!.qitemId)!;
  };

  it("a person's answer that its seat can't take reaches them as a notice from OpenRig, not a TO DO from themselves", async () => {
    const answer = await failedWake("person@external");
    await sweep();
    const notice = findingFor(answer);
    expect(notice.destinationSession).toBe("person@external");
    expect(notice.sourceSession).toBe("stuck-sweep@system");
    expect(notice.humanIntent).toBe("update");
    expect(hasLiveHumanGate(notice)).toBe(false);
    expect(queue.listTransitions(notice.qitemId)[0]).toMatchObject({ ownerNotificationKind: "human-update" });
    expect(notice.summary).toMatch(new RegExp(`^Checked on ${answer.qitemId}: it's waiting for lead@lane, which couldn't be woken`));
    expect(notice.body).toMatch(/^STUCK SWEEP FINDING \(undelivered-wake\)\n/);
    expect(notice.body).toContain("destination: lead@lane (source person@external");
    expect(notice.body).toContain("This is a notice from OpenRig, not a task for you");
    expect(notice.body).not.toContain("act on it");
  });

  it("a finding for an agent's row keeps its creator as sender and stays an ask", async () => {
    const row = await failedWake("sender@lane");
    await sweep();
    const finding = findingFor(row);
    expect(finding.destinationSession).toBe("sender@lane");
    expect(finding.sourceSession).toBe("sender@lane");
    expect(finding.humanIntent ?? null).toBeNull();
    expect(finding.summary).toMatch(new RegExp(`^Checked on ${row.qitemId}: its owner couldn't be woken`));
  });

  it("when who is a person can't be read, the finding is written as before", async () => {
    const answer = await failedWake("person@external");
    registryReadable = false;
    await sweep();
    const finding = queue.list({ limit: 500 }).find((item) => (item.tags ?? []).includes(`stuck-sweep:undelivered-wake:${answer.qitemId}`));
    expect(finding).toBeDefined();
    const row = queue.getById(finding.qitemId)!;
    expect(row.sourceSession).not.toBe("stuck-sweep@system");
    expect(row.humanIntent ?? null).toBeNull();
  });
});
