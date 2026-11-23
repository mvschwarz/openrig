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

  const sweep = (overrides: Record<string, unknown> = {}) => runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(),
    unclaimedAgeMinutes: 60, log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null,
    resolveOperatorSeat: () => null, ...overrides });
  /** A row from `source` to `destination` whose wake failed. */
  async function failedWake(source: string, destination = "lead@lane", result = "failed:usage_limit"): Promise<QueueItem> {
    const row = await queue.create({ sourceSession: source, destinationSession: destination, body: "Yes, ship the smaller one", nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(new Date().toISOString(), result, row.qitemId);
    return row;
  }
  /** A finding that comes back to the person as before: an ask, from the row's creator, that tells them what to do. */
  const expectAsk = (finding: QueueItem, person: string) => {
    expect(finding.destinationSession).toBe(person);
    expect(finding.sourceSession).toBe(person);
    expect(finding.humanIntent ?? null).toBeNull();
    expect(finding.body).not.toContain("This is a notice from OpenRig");
  };
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
    expect(notice.body).toContain("It reaches lead@lane only when a wake lands there");
    expect(notice.body).not.toContain("act on it");
  });

  // A canonical alias of a registered person (their entity id at a rig) is them too; the notice goes to their own address,
  // which a person update needs, so it is never refused and lost.
  it("a person who wrote as person@lane gets the notice at their own address", async () => {
    const answer = await failedWake("person@lane");
    await sweep();
    const notice = findingFor(answer);
    expect(notice.destinationSession).toBe("person@external");
    expect(notice.sourceSession).toBe("stuck-sweep@system");
    expect(notice.humanIntent).toBe("update");
  });

  // The other routes back to a creator ask the person to act, so they stay asks.
  it("a person's row to a terminal seat comes back as the ask it was, telling them to route it", async () => {
    const rig = rigs.listRigs().find((r) => r.name === "lane")!;
    const node = rigs.addNode(rig.id, "logger", { runtime: "terminal" });
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,?)").run("session-log", node.id, "logger@lane", "running");
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, 'tmux', ?, ?)")
      .run("bind-log", node.id, "logger@lane", "%2");
    const row = await failedWake("person@external", "logger@lane",
      "failed:terminal-seat: 'logger@lane' is a terminal seat (runtime: terminal), not an agent, so no wake was typed into it");
    await sweep();
    const finding = findingFor(row);
    expectAsk(finding, "person@external");
    expect(finding.body).toContain("Route the work to an agent seat");
  });

  it("a person's row to a seat that's confirmed missing comes back as the ask it was", async () => {
    const row = await failedWake("person@external");
    await sweep({ sessionConfirmedMissing: (session: string) => session === "lead@lane" });
    const finding = findingFor(row);
    expectAsk(finding, "person@external");
    expect(finding.body).toContain("lead@lane is confirmed missing");
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
    const row = queue.getById(finding!.qitemId)!;
    // Who is a person can't be read, so the seat isn't classified and the finding stays with it, as on main.
    expect(row.destinationSession).toBe("lead@lane");
    expect(row.sourceSession).not.toBe("stuck-sweep@system");
    expect(row.humanIntent ?? null).toBeNull();
  });
});
