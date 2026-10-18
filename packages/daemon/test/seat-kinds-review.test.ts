import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeatKindRegistry, type SeatKind } from "../src/domain/seat-kinds.js";
import type { SessionProbe, TmuxAdapter } from "../src/adapters/tmux.js";

// Review follow-ups: a registered kind's seat as a removal fallback, stop wording that does not
// blame tmux, and no dispatch to the kind for a session name its binding no longer carries.

function recordingTmux(calls: string[]): TmuxAdapter {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "deliveryGuard" || prop === "then" || typeof prop === "symbol") return undefined;
      return async () => { calls.push(String(prop)); return { ok: true }; };
    },
  }) as TmuxAdapter;
}

function fakeKind(calls: string[], probe: () => SessionProbe): SeatKind {
  return {
    kind: "acp",
    host: {
      create: async () => ({ ok: true, binding: {}, warnings: [] }),
      launch: async () => ({ ok: true }),
      checkReady: async () => ({ ready: true }),
      probe: async (ref) => { calls.push(`probe:${ref.sessionName}`); return probe(); },
      stop: async (ref) => { calls.push(`stop:${ref.sessionName}`); return { ok: false, code: "host_down", message: "host went away" }; },
    },
    inbound: {
      deliver: async (ref, text) => { calls.push(`deliver:${ref.sessionName}:${text}`); return { ok: true, sessionName: ref.sessionName }; },
      capture: async (ref, lines) => { calls.push(`capture:${ref.sessionName}`); return { ok: true, sessionName: ref.sessionName, content: "", lines }; },
    },
    activity: { probe: async () => { throw new Error("not under test"); } },
  };
}

describe("seat kinds: review follow-ups", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let kindCalls: string[];
  let tmuxCalls: string[];
  let probeAnswer: SessionProbe;
  let seatKinds: SeatKindRegistry;
  let tmux: TmuxAdapter;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    kindCalls = [];
    tmuxCalls = [];
    probeAnswer = { state: "present" };
    seatKinds = new SeatKindRegistry([fakeKind(kindCalls, () => probeAnswer)]);
    tmux = recordingTmux(tmuxCalls);
  });

  afterEach(() => { db.close(); });

  async function launchAcp(rigId: string, logicalId: string) {
    const launched = await new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds })
      .launchNode(rigId, logicalId, { kind: "acp" });
    if (!launched.ok) throw new Error(launched.message);
    return launched;
  }

  it("accepts a live registered-kind seat as a removal fallback, probed through its host", async () => {
    const rig = rigRepo.createRig("r01");
    const leaving = rigRepo.addNode(rig.id, "dev.leaving", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(leaving.id, "dev-leaving@r01");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(leaving.id, { tmuxSession: "dev-leaving@r01" });
    rigRepo.addNode(rig.id, "dev.fallback", { role: "worker", runtime: "claude-code" });
    const fallback = await launchAcp(rig.id, "dev.fallback");

    const lifecycle = new RigLifecycleService({ db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus,
      queueRepo: new QueueRepository(db, eventBus, { validateRig: () => true }), tmuxAdapter: tmux, seatKinds });
    const result = await lifecycle.removeNode(rig.id, "dev.leaving", { fallbackDestination: fallback.sessionName });

    expect(result.ok).toBe(true);
    expect(kindCalls).toContain(`probe:${fallback.sessionName}`);
    expect(tmuxCalls).not.toContain("hasSession");
  });

  it("refuses a registered-kind fallback its host reports absent", async () => {
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev.leaving", { role: "worker", runtime: "claude-code" });
    rigRepo.addNode(rig.id, "dev.fallback", { role: "worker", runtime: "claude-code" });
    const fallback = await launchAcp(rig.id, "dev.fallback");
    probeAnswer = { state: "absent" };

    const lifecycle = new RigLifecycleService({ db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus,
      queueRepo: new QueueRepository(db, eventBus, { validateRig: () => true }), tmuxAdapter: tmux, seatKinds });
    const result = await lifecycle.removeNode(rig.id, "dev.leaving", { fallbackDestination: fallback.sessionName });

    expect(result).toMatchObject({ ok: false, code: "fallback_not_running" });
  });

  it("words a registered-kind seat's stop failures without naming tmux", async () => {
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const seat = await launchAcp(rig.id, "dev.impl");
    const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds });

    const failed = await service.stopSeat({ seatRef: seat.sessionName, reason: "review follow-up" });
    expect(failed).toMatchObject({ ok: false });
    // Refusal codes are API (they map to HTTP statuses) and stay; the message names the seat host.
    const message = (r: unknown) => (r as { message?: string }).message ?? "";
    expect(message(failed)).toContain("seat host failed: host went away");
    expect(message(failed)).not.toMatch(/tmux/i);

    probeAnswer = { state: "absent" };
    const absent = await service.stopSeat({ seatRef: seat.sessionName, reason: "review follow-up" });
    expect(absent).toMatchObject({ ok: false, code: "session_not_live" });
    expect(message(absent)).not.toMatch(/tmux/i);

    probeAnswer = { state: "transport_unavailable", cause: "socket closed" };
    const unreachable = await service.stopSeat({ seatRef: seat.sessionName, reason: "review follow-up" });
    expect(message(unreachable)).toContain("socket closed");
    expect(message(unreachable)).not.toMatch(/tmux/i);
    expect(tmuxCalls).toEqual([]);
  });

  it("does not hand an older session name of the node to the kind", async () => {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const old = sessionRegistry.registerSession(node.id, "dev-impl-old@r01");
    sessionRegistry.updateStatus(old.id, "exited");
    const seat = await launchAcp(rig.id, "dev.impl");
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus, seatKinds });

    await transport.capture("dev-impl-old@r01");
    await transport.send("dev-impl-old@r01", "hello");
    expect(kindCalls).toEqual([]);

    await transport.capture(seat.sessionName);
    expect(kindCalls).toEqual([`capture:${seat.sessionName}`]);
  });

  it("names a registered-kind seat in startup warnings, never null", async () => {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const seat = await launchAcp(rig.id, "dev.impl");
    let readinessChecks = 0;
    const kind = fakeKind(kindCalls, () => probeAnswer);
    const flaky = new SeatKindRegistry([{ ...kind, host: { ...kind.host,
      checkReady: async () => { if (++readinessChecks > 1) throw new Error("host went away"); return { ready: true }; } } }]);
    const adapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true }),
      checkReady: async () => ({ ready: true }),
    } as unknown as RuntimeAdapter;
    const binding = { ...sessionRegistry.getBindingForNode(node.id)!, cwd: "." } as NodeBinding;
    const result = await new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds: flaky, sleep: async () => {} })
      .startNode({
        rigId: rig.id, nodeId: node.id, sessionId: seat.session.id, sessionName: seat.sessionName, binding, adapter,
        plan: { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [],
        startupActions: [{ type: "send_text", value: `${seat.sessionName}\nOpenRig session identity:`, phase: "after_ready",
          appliesOn: ["fresh_start"], idempotent: true, builtin: "session_identity" }],
        isRestore: false,
      });
    const warnings = JSON.stringify(result.warnings ?? []);
    expect(warnings).toContain(`unverified in ${seat.sessionName}`);
    expect(warnings).not.toContain("in null");
    expect(tmuxCalls).toEqual([]);
  });
});
