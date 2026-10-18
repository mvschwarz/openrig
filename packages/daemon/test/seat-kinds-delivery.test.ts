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
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatKindRegistry, type SeatKind, type SeatRef } from "../src/domain/seat-kinds.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function recordingTmux(calls: string[], deliveryGuard?: SeatDeliveryGuard): TmuxAdapter {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "deliveryGuard") return deliveryGuard;
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return async () => { calls.push(String(prop)); return { ok: true }; };
    },
  }) as TmuxAdapter;
}

function fakeKind(received: Array<{ ref: SeatRef; text?: string; lines?: number }>): SeatKind {
  const refuse = async () => { throw new Error("not under test"); };
  return {
    kind: "acp",
    host: {
      create: async () => ({ ok: true, binding: {}, warnings: [] }),
      launch: async () => ({ ok: true }),
      checkReady: async () => ({ ready: true }),
      probe: refuse, stop: refuse,
    },
    inbound: {
      deliver: async (ref, text) => { received.push({ ref, text }); return { ok: true, sessionName: ref.sessionName, verified: true }; },
      capture: async (ref, lines) => { received.push({ ref, lines }); return { ok: true, sessionName: ref.sessionName, content: "agent says hi", lines }; },
    },
    activity: { probe: refuse },
  };
}

describe("a registered seat kind owns send and capture", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => { db.close(); });

  async function setup(withGuard = false) {
    const received: Array<{ ref: SeatRef; text?: string; lines?: number }> = [];
    const tmuxCalls: string[] = [];
    const seatKinds = new SeatKindRegistry([fakeKind(received)]);
    const guard = withGuard ? new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target)) : undefined;
    const tmux = recordingTmux(tmuxCalls, guard);
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "claude-code" });
    const launched = await new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds })
      .launchNode(rig.id, "dev1-impl", { kind: "acp" });
    if (!launched.ok) throw new Error(launched.message);
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus, seatKinds });
    return { received, tmuxCalls, transport, node, rig, tmux, seatKinds, launched, sessionName: launched.sessionName };
  }

  it("delivers a send through the kind's inbound, with no tmux call", async () => {
    const { received, tmuxCalls, transport, node, sessionName } = await setup();
    const result = await transport.send(sessionName, "hello");
    expect(result).toMatchObject({ ok: true, sessionName, verified: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ ref: { nodeId: node.id, sessionName, runtime: "claude-code", kind: "acp", pane: null }, text: "hello" });
    expect(tmuxCalls).toEqual([]);
  });

  it("delivers inside the delivery guard's lease", async () => {
    const { received, tmuxCalls, transport, sessionName } = await setup(true);
    const result = await transport.send(sessionName, "hello");
    expect(result).toMatchObject({ ok: true, verified: true });
    expect(received.map((r) => r.text)).toEqual(["hello"]);
    expect(tmuxCalls).toEqual([]);
  });

  it("captures through the kind's inbound", async () => {
    const { received, tmuxCalls, transport, sessionName } = await setup();
    const result = await transport.capture(sessionName, { lines: 7 });
    expect(result).toMatchObject({ ok: true, content: "agent says hi", lines: 7 });
    expect(received.map((r) => r.lines)).toEqual([7]);
    expect(tmuxCalls).toEqual([]);
  });

  it("includes the seat when a whole rig is the target", async () => {
    const { transport, sessionName } = await setup();
    const resolved = await transport.resolveSessions({ rig: "r01" });
    expect(resolved).toMatchObject({ ok: true, sessions: [{ sessionName, rigName: "r01", nodeLogicalId: "dev1-impl" }] });
  });

  it("sends startup text through the kind's inbound", async () => {
    const { received, tmuxCalls, node, rig, tmux, seatKinds, launched, sessionName } = await setup();
    const adapter = {
      runtime: "codex",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true }),
      checkReady: async () => ({ ready: true }),
    } as unknown as RuntimeAdapter;
    const binding = { ...sessionRegistry.getBindingForNode(node.id)!, cwd: "." } as NodeBinding;
    const result = await new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, seatKinds, sleep: async () => {} })
      .startNode({
        rigId: rig.id, nodeId: node.id, sessionId: launched.session.id, sessionName, binding, adapter,
        plan: { runtime: "codex", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [],
        startupActions: [{ type: "send_text", value: "read the brief", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }],
        isRestore: false,
      });
    expect(result.ok).toBe(true);
    expect(received.map((r) => r.text)).toContain("read the brief");
    expect(tmuxCalls).toEqual([]);
  });
});
