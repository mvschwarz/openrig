// #174 — an archived duplicate of a live rig shares its name and its seats' canonical session names.
// (b) `rig remove` on the archived rig must not kill, or route the queue work of, the live seat that owns
// the shared session name. (a) Seat refs resolve against unarchived rigs only, so the archived duplicate
// no longer makes the live seat ambiguous. Fake tmux only: no live session is touched.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RIG = "bodies-in-motion";
const SEAT = `lead-planner@${RIG}`;

describe("#174 archived duplicate rig vs the live seat with the same name", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let queueRepo: QueueRepository;
  let killSession: ReturnType<typeof vi.fn>;
  let lifecycle: RigLifecycleService;
  let stale: { rigId: string; nodeId: string };
  let live: { rigId: string; nodeId: string; sessionId: string };

  function seat(rigName: string, status: "running" | "exited", logicalId = "lead.planner", name = SEAT) {
    const rig = rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, logicalId, { role: "planner", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, status);
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    killSession = vi.fn(async () => ({ ok: true as const }));
    lifecycle = new RigLifecycleService({
      db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, queueRepo,
      tmuxAdapter: { killSession } as unknown as TmuxAdapter,
    });
    // The reported shape: the stale record was archived; the live rig re-created the same seat name.
    stale = seat(RIG, "exited");
    rigRepo.archiveRig(stale.rigId);
    live = seat(RIG, "running");
  });
  afterEach(() => db.close());

  it("(b) removing the archived rig's node keeps the live seat's session and names its owner", async () => {
    const result = await lifecycle.removeNode(stale.rigId, "lead.planner");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 0, sessionKeptFor: `lead.planner@${RIG}` });
    expect(killSession).not.toHaveBeenCalled();
    expect(rigRepo.getRig(stale.rigId)!.nodes).toHaveLength(0);
    const liveRow = db.prepare("SELECT status FROM sessions WHERE id = ?").get(live.sessionId) as { status: string };
    expect(liveRow.status).toBe("running");
    const liveBinding = db.prepare("SELECT tmux_session FROM bindings WHERE node_id = ?").get(live.nodeId) as { tmux_session: string };
    expect(liveBinding.tmux_session).toBe(SEAT);
    const detachedForName = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'session.detached'").get() as { n: number };
    expect(detachedForName.n).toBe(0);
  });

  it("(b) the live seat's open queue work neither blocks the removal nor moves", async () => {
    const work = await queueRepo.create({ sourceSession: `orch@${RIG}`, destinationSession: SEAT, body: "live seat's work" });

    const result = await lifecycle.removeNode(stale.rigId, "lead.planner");

    expect(result).toMatchObject({ ok: true, reroutedQitemIds: [] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
  });

  it("(b) removing the LIVE node still kills its own session once; the archived twin's stale binding is not an owner", async () => {
    const result = await lifecycle.removeNode(live.rigId, "lead.planner");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 1 });
    expect(result.ok && "sessionKeptFor" in result).toBe(false);
    expect(killSession).toHaveBeenCalledExactlyOnceWith(SEAT);
  });

  it("(b) removing the LIVE node still refuses its open work without --fallback", async () => {
    const work = await queueRepo.create({ sourceSession: `orch@${RIG}`, destinationSession: SEAT, body: "live seat's work" });

    const result = await lifecycle.removeNode(live.rigId, "lead.planner");

    expect(result).toMatchObject({ ok: false, code: "active_qitems" });
    expect(killSession).not.toHaveBeenCalled();
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
  });

  it("(guard) the delivery guard resolves the live seat despite the archived twin's binding", () => {
    expect(resolveGuardTarget(db, SEAT)).toMatchObject({ nodeId: live.nodeId, session: SEAT });
  });

  it("(guard) control: two unarchived bindings to the same name still resolve to nothing", () => {
    seat(RIG, "running");
    expect(resolveGuardTarget(db, SEAT)).toBeNull();
  });

  it("control: removing a node that owns its session still kills that session once", async () => {
    const own = seat("solo-rig", "running", "dev.impl", "dev-impl@solo-rig");
    const result = await lifecycle.removeNode(own.rigId, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 1 });
    expect(result.ok && "sessionKeptFor" in result).toBe(false);
    expect(killSession).toHaveBeenCalledExactlyOnceWith("dev-impl@solo-rig");
  });

  it("(a) seat status and handover resolution no longer see the archived duplicate", () => {
    const status = new SeatStatusService({ rigRepo }).getStatus(SEAT);

    expect(status.ok).toBe(true);
    expect(status.ok && status.status.rig_id).toBe(live.rigId);
  });

  it("(a) seat lifecycle verbs resolve the canonical ref to the live seat", async () => {
    const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: { killSession } as unknown as TmuxAdapter });
    const result = await service.setModel({ seatRef: SEAT, model: "claude-fable-5", reason: "issue 174" });

    expect(result.ok || result.code).not.toBe("seat_ambiguous");
    expect(result.ok).toBe(true);
  });

  it("control: an unarchived duplicate is still reported as ambiguous", () => {
    seat(RIG, "running", "lead.planner");
    const status = new SeatStatusService({ rigRepo }).getStatus(SEAT);

    expect(status.ok).toBe(false);
    expect(!status.ok && status.code).toBe("seat_ambiguous");
  });
});
