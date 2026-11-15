// A wake that failed at a live agent seat with no delegation parent or escalates_to got a finding addressed back to that
// seat, whose own wake then went to the seat that had just failed to take one. That finding now goes to the row's creator,
// or for a seat that sent itself the work, to the operator agent. A declared route keeps its routing and its fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { runStuckSweep, createStuckSweepStatus, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";

describe("stuck sweep: a failed wake at a seat with no declared route", () => {
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

  /** An agent seat; with `running` false it has no session. */
  function seat(rigName: string, logicalId: string, session: string, running = true) {
    const rig = rigs.listRigs().find((r) => r.name === rigName) ?? rigs.createRig(rigName);
    const node = rigs.addNode(rig.id, logicalId, { runtime: "claude-code" });
    if (running) db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,?)").run(`session-${++seq}`, node.id, session, "running");
    return { rig, node, session };
  }
  async function sweep(overrides: Record<string, unknown> = {}) {
    return runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60, log: () => {},
      isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null, ...overrides });
  }
  /** A row for `destination` whose wake failed. */
  async function failedWake(destination: string, source = "sender@lane"): Promise<QueueItem> {
    const row = await queue.create({ sourceSession: source, destinationSession: destination, body: "Decide the scope", nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(new Date().toISOString(), "failed:target_needs_input", row.qitemId);
    return row;
  }
  const findingsFor = (row: QueueItem): QueueItem[] => queue.list({ limit: 500 })
    .filter((item) => (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG) && (item.tags ?? []).includes(`stuck-sweep:undelivered-wake:${row.qitemId}`))
    .map((item) => queue.getById(item.qitemId)!);

  it("sends the finding to the row's creator, and says why", async () => {
    seat("front", "door.root", "root@front");
    const row = await failedWake("root@front");
    await sweep();
    const [finding, ...more] = findingsFor(row);
    expect(more).toHaveLength(0);
    expect(finding!.destinationSession).toBe("sender@lane");
    expect(finding!.body).toContain("root@front declares no delegation parent or escalates_to, so this finding goes to sender@lane, the row's creator");
  });

  it("a seat that sent itself the work gets the operator agent instead", async () => {
    seat("front", "door.root", "root@front");
    const row = await failedWake("root@front", "root@front");
    await sweep({ resolveRecoveryAgentSeat: () => "operator-admin@kernel" });
    const [finding] = findingsFor(row);
    expect(finding!.destinationSession).toBe("operator-admin@kernel");
    expect(finding!.body).toContain("so this finding goes to operator-admin@kernel, the operator agent (agents.operator_session)");
  });

  it("with no operator agent, a self-sent row's finding stays with the seat and says so", async () => {
    seat("front", "door.root", "root@front");
    const row = await failedWake("root@front", "root@front");
    await sweep();
    const [finding] = findingsFor(row);
    expect(finding!.destinationSession).toBe("root@front");
    expect(finding!.body).toContain("its creator and the operator agent (agents.operator_session) are each unset, missing, this seat, OpenRig's own machinery, a terminal seat or not an address this queue takes, so this finding stays addressed to it");
  });

  // Rows that OpenRig's own machinery creates (stream intake and startup write them as daemon@kernel) have no creator that
  // can act on a finding.
  it.each(["daemon@kernel", "stuck-sweep@system"])("a row created by OpenRig's machinery (%s) gets the operator agent", async (machinery) => {
    seat("front", "door.root", "root@front");
    const row = await failedWake("root@front", machinery);
    await sweep({ resolveRecoveryAgentSeat: () => "operator-admin@kernel" });
    const [finding] = findingsFor(row);
    expect(finding!.destinationSession).toBe("operator-admin@kernel");
    expect(finding!.body).toContain("so this finding goes to operator-admin@kernel, the operator agent (agents.operator_session)");
  });

  it("reads a seat's delegation parent again after the pass writes a finding", async () => {
    const lead = seat("lane", "work.lead", "lead@lane");
    const first = await failedWake("lead@lane");
    const second = await failedWake("lead@lane");
    // Another writer declares the seat's parent (with no session yet) while the pass awaits its first finding's write.
    const parent = seat("lane", "coord.owner", "owner@lane", false);
    const create = queue.create.bind(queue);
    let declared = false;
    vi.spyOn(queue, "create").mockImplementation(async (input) => {
      const created = await create(input);
      if (!declared && (input.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG)) {
        declared = true;
        rigs.addEdge(lead.rig.id, parent.node.id, lead.node.id, "delegates_to");
      }
      return created;
    });
    await sweep();
    const routes = [first, second].map((row) => findingsFor(row)[0]!.destinationSession);
    // The first finding was routed before the parent existed; the second sees it and keeps the parent's fallback.
    expect(routes.sort()).toEqual(["lead@lane", "sender@lane"]);
  });

  it("passes over a creator the queue doesn't take as an address", async () => {
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: (destination) => destination !== "sender@ops@elsewhere", loadHumanRegistry: () => ({ ok: true, entities: [] }),
    });
    seat("front", "door.root", "root@front");
    const row = await failedWake("root@front", "sender@ops@elsewhere");
    await sweep({ resolveRecoveryAgentSeat: () => "operator-admin@kernel" });
    expect(findingsFor(row)[0]!.destinationSession).toBe("operator-admin@kernel");
  });

  // A bound terminal seat (a shell or a TUI) can't act on a finding: no wake is typed into it, and nothing there claims
  // work. The no-wake rule passes it over, and so must this one.
  it("passes over a creator that is a bound terminal seat", async () => {
    const { rig } = seat("front", "door.root", "root@front");
    const logger = rigs.addNode(rig.id, "logger", { runtime: "terminal" });
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,?)").run(`session-${++seq}`, logger.id, "logger@front", "running");
    db.prepare("INSERT INTO bindings (id,node_id,attachment_type,tmux_session,tmux_pane) VALUES (?,?,'tmux',?,'%2')").run("bind-logger", logger.id, "logger@front");
    const row = await failedWake("root@front", "logger@front");
    await sweep({ resolveRecoveryAgentSeat: () => "operator-admin@kernel" });
    const [finding] = findingsFor(row);
    expect(finding!.destinationSession).toBe("operator-admin@kernel");
    expect(finding!.body).toContain("so this finding goes to operator-admin@kernel, the operator agent (agents.operator_session)");
  });

  it("a hosted member whose ring failed keeps the no-wake rule's choice when that rule finds nobody", async () => {
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }),
      hostedWake: (destination) => destination === "grok@front" ? { webhook: { url_ref: "GROK_WAKE_URL" } } : null,
    });
    // A recorded seat with a session and no terminal: the sweep can read its topology, and it still can't be typed into.
    seat("front", "grok", "grok@front");
    expect(queue.classifyDestinationOf("grok@front").class).toBe("hosted");
    // A creator with no wake route here: the no-wake rule passes it over, and so must this one.
    const row = await failedWake("grok@front", "someone@elsewhere");
    db.prepare("UPDATE queue_items SET last_nudge_result = ? WHERE qitem_id = ?").run("failed:webhook (GROK_WAKE_URL) answered 500", row.qitemId);
    await sweep();
    const [finding] = findingsFor(row);
    expect(finding!.destinationSession).toBe("grok@front");
    expect(finding!.body).toContain("No person, creator or operator agent that can be reached is available");
  });

  it("a declared delegation parent keeps the finding where it was, even when the parent has no session", async () => {
    const lead = seat("lane", "work.lead", "lead@lane");
    const parent = seat("lane", "coord.owner", "owner@lane", false);
    rigs.addEdge(lead.rig.id, parent.node.id, lead.node.id, "delegates_to");
    const row = await failedWake("lead@lane");
    await sweep();
    expect(findingsFor(row).map((f) => f.destinationSession)).toEqual(["lead@lane"]);
  });

  it("a declared escalates_to that can't be used keeps its fallback", async () => {
    const door = seat("front", "door.root", "root@front");
    seat("ops", "watch.lead", "lead@ops", false);
    rigs.addEdge(door.rig.id, door.node.id, "lead@ops", "escalates_to");
    const row = await failedWake("root@front");
    await sweep();
    const [finding] = findingsFor(row);
    expect(finding!.destinationSession).toBe("root@front");
    expect(finding!.body).toContain("escalation route: escalates_to unavailable");
  });
});
