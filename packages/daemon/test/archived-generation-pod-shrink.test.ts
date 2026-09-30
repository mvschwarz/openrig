// #141: a YAML re-import archives the stopped earlier generation, whose pod members keep the session names the
// live replacement now owns. Shrinking the archived pod must neither be blocked by, nor reroute, the replacement's
// queue work, and must not kill its session. The owning pod's own refusal and --fallback stay. Fake tmux only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RIG = "first-project";
const SEAT = `crew-lead@${RIG}`;
const FALLBACK = "orch-lead@ops-rig";

describe("#141 shrinking an archived generation's pod vs the live replacement's work", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let queueRepo: QueueRepository;
  let killSession: ReturnType<typeof vi.fn>;
  let lifecycle: RigLifecycleService;
  let stale: { rigId: string; podId: string };
  let live: { rigId: string; podId: string; sessionId: string };

  function generation(status: "running" | "exited") {
    const rig = rigRepo.createRig(RIG);
    const pod = new PodRepository(db).createPod(rig.id, "crew", "Crew");
    const node = rigRepo.addNode(rig.id, "crew.lead", { runtime: "claude-code", podId: pod.id });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, status);
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT });
    return { rigId: rig.id, podId: pod.id, sessionId: session.id };
  }

  const openWork = () => queueRepo.create({ sourceSession: FALLBACK, destinationSession: SEAT, body: "replacement's work" });
  const liveStatus = () => (db.prepare("SELECT status FROM sessions WHERE id = ?").get(live.sessionId) as { status: string }).status;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    killSession = vi.fn(async () => ({ ok: true as const }));
    lifecycle = new RigLifecycleService({
      db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, queueRepo,
      // hasSession answers only the --fallback destination check; the fallback seat is the one "live" session.
      tmuxAdapter: { killSession, hasSession: vi.fn(async (name: string) => name === FALLBACK) } as unknown as TmuxAdapter,
    });
    // The P1 shape: the stopped generation was archived and the replacement re-created the same seat.
    stale = generation("exited");
    rigRepo.archiveRig(stale.rigId);
    live = generation("running");
    // A running seat elsewhere that can take explicitly rerouted work.
    const ops = rigRepo.createRig("ops-rig");
    const orch = rigRepo.addNode(ops.id, "orch.lead", { runtime: "claude-code" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(orch.id, FALLBACK).id, "running");
  });
  afterEach(() => db.close());

  it("shrinking the archived pod is not blocked by the replacement's open work and keeps its session", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(stale.rigId, stale.podId);

    expect(result).toMatchObject({ ok: true, status: "ok", sessionsKilled: 0, reroutedQitemIds: [] });
    expect(result.ok && result.nodes[0]).toMatchObject({ status: "removed", sessionKeptFor: `crew.lead@${RIG}` });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
    expect(liveStatus()).toBe("running");
  });

  it("with --fallback, the replacement's open work does not move", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(stale.rigId, stale.podId, { fallbackDestination: FALLBACK });

    expect(result).toMatchObject({ ok: true, status: "ok", reroutedQitemIds: [] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
    expect(liveStatus()).toBe("running");
  });

  it("control: shrinking the live pod still refuses its own open work without --fallback", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(live.rigId, live.podId);

    expect(result).toMatchObject({ ok: false, code: "active_qitems", activeQitemIds: [work.qitemId] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
  });

  it("control: shrinking the live pod with --fallback reroutes its own work and kills its session once", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(live.rigId, live.podId, { fallbackDestination: FALLBACK });

    expect(result).toMatchObject({ ok: true, status: "ok", sessionsKilled: 1, reroutedQitemIds: [work.qitemId] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: FALLBACK });
    expect(killSession).toHaveBeenCalledExactlyOnceWith(SEAT);
  });
});
