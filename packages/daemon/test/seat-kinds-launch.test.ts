import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SeatKindRegistry, type SeatKind, type SeatRef } from "../src/domain/seat-kinds.js";
import type { SessionProbe, TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

/** A tmux adapter that records every method called on it, so a test can prove none was. */
function recordingTmux(calls: string[]): TmuxAdapter {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "deliveryGuard" || prop === "then" || typeof prop === "symbol") return undefined;
      return async () => { calls.push(String(prop)); return { ok: true }; };
    },
  }) as TmuxAdapter;
}

function fakeKind(calls: string[], probe: SessionProbe = { state: "present" }): SeatKind {
  return {
    kind: "acp",
    host: {
      create: async (req) => { calls.push(`create:${req.sessionName}`); return { ok: true, binding: {}, warnings: ["made elsewhere"] }; },
      launch: async (binding, _adapter, opts) => { calls.push(`launch:${binding.attachmentType}:${opts.name}`); return { ok: true }; },
      checkReady: async () => { calls.push("checkReady"); return { ready: true }; },
      probe: async (ref: SeatRef) => { calls.push(`probe:${ref.sessionName}`); return probe; },
      stop: async (ref: SeatRef) => { calls.push(`stop:${ref.sessionName}`); return { ok: true }; },
    },
    inbound: {
      deliver: async () => { throw new Error("not under test"); },
      capture: async () => { throw new Error("not under test"); },
    },
    activity: { probe: async () => { throw new Error("not under test"); } },
  };
}

describe("a registered seat kind owns launch, readiness, probe and stop", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => { db.close(); });

  async function launchAcpSeat(kindCalls: string[], tmuxCalls: string[], probe?: SessionProbe) {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "claude-code" });
    const seatKinds = new SeatKindRegistry([fakeKind(kindCalls, probe)]);
    const tmux = recordingTmux(tmuxCalls);
    const launched = await new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds })
      .launchNode(rig.id, "dev1-impl", { kind: "acp" });
    return { rig, node, seatKinds, tmux, launched };
  }

  it("launches through the kind's host and binds the seat by name, with no tmux call", async () => {
    const kindCalls: string[] = [];
    const tmuxCalls: string[] = [];
    const { node, launched } = await launchAcpSeat(kindCalls, tmuxCalls);
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.warnings).toEqual(["made elsewhere"]);
    expect(kindCalls).toEqual([`create:${launched.sessionName}`]);
    expect(tmuxCalls).toEqual([]);
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding).toMatchObject({ attachmentType: "acp", externalSessionName: launched.sessionName, tmuxSession: null, tmuxPane: null });
  });

  it("refuses a kind that is not registered, before anything is made", async () => {
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "claude-code" });
    const tmuxCalls: string[] = [];
    const result = await new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: recordingTmux(tmuxCalls) })
      .launchNode(rig.id, "dev1-impl", { kind: "acp" });
    expect(result).toMatchObject({ ok: false, code: "seat_kind_unknown" });
    expect(tmuxCalls).toEqual([]);
  });

  it("starts and checks the agent through the kind's host, not the runtime adapter", async () => {
    const kindCalls: string[] = [];
    const tmuxCalls: string[] = [];
    const { rig, node, seatKinds, tmux, launched } = await launchAcpSeat(kindCalls, tmuxCalls);
    if (!launched.ok) throw new Error("launch failed");
    const adapterCalls: string[] = [];
    const adapter = {
      runtime: "codex",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => { adapterCalls.push("launchHarness"); return { ok: true }; },
      checkReady: async () => { adapterCalls.push("checkReady"); return { ready: true }; },
    } as unknown as RuntimeAdapter;
    const binding = { ...sessionRegistry.getBindingForNode(node.id)!, cwd: "." } as NodeBinding;
    const result = await new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds, sleep: async () => {} })
      .startNode({
        rigId: rig.id, nodeId: node.id, sessionId: launched.session.id, sessionName: launched.sessionName, binding, adapter,
        plan: { runtime: "codex", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [], startupActions: [], isRestore: false,
      });
    expect(result.ok).toBe(true);
    expect(kindCalls).toContain(`launch:acp:${launched.sessionName}`);
    expect(kindCalls).toContain("checkReady");
    expect(adapterCalls).toEqual([]);
    expect(tmuxCalls).toEqual([]);
  });

  it("probes the seat through its host at boot reconcile", async () => {
    const kindCalls: string[] = [];
    const tmuxCalls: string[] = [];
    const { rig, seatKinds, tmux, launched } = await launchAcpSeat(kindCalls, tmuxCalls, { state: "absent" });
    if (!launched.ok) throw new Error("launch failed");
    const result = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds }).reconcile(rig.id);
    expect(result).toMatchObject({ checked: 1, detached: 1, errors: [] });
    expect(kindCalls).toContain(`probe:${launched.sessionName}`);
    expect(tmuxCalls).toEqual([]);
  });

  it("stops the seat through its host on rig down", async () => {
    const kindCalls: string[] = [];
    const tmuxCalls: string[] = [];
    const { rig, node, seatKinds, tmux, launched } = await launchAcpSeat(kindCalls, tmuxCalls);
    if (!launched.ok) throw new Error("launch failed");
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus,
      snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) });
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux, seatKinds })
      .teardown(rig.id);
    expect(down.errors).toEqual([]);
    expect(down.sessionsKilled).toBe(1);
    expect(kindCalls).toEqual(expect.arrayContaining([`probe:${launched.sessionName}`, `stop:${launched.sessionName}`]));
    expect(sessionRegistry.getBindingForNode(node.id)).toBeNull();
  });
});
