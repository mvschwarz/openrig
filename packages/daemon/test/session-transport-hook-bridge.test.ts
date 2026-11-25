// Slice 13: the hook bridge is one branch inside the delivery owner. A live bridge queues the message and nothing is
// typed. A bridge with no live arm gets today's typed delivery with a warning. The typing guard's hold still decides
// first. A message queued before its waiter vanished is typed by the sweep, under its own outbox id.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { HOOK_BRIDGE_LIVE_BOUND_MS, HOOK_BRIDGE_TURN_BOUND_MS, HookBridge } from "../src/domain/hook-bridge.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";

// A send bound to an original conversation: the native record check is the expected-identity suite's; here it passes,
// so the only question is whether the bridge takes the send.
vi.mock("../src/domain/expected-conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain/expected-conversation.js")>()),
  resolveExpectedConversation: async (identity: unknown) => ({ identity, path: "/dev/null", generation: "g", pane: "%1", assertCurrent: () => {} }),
}));

const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });

/** `withEvents`: wired with an event bus, as startup wires the transport, so its delivery-evidence observer runs. */
async function seat({ withEvents = false }: { withEvents?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hook-bridge-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const repo = new RigRepository(db), rig = repo.createRig("team"), node = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const registry = new SessionRegistry(db), sessionName = "dev-impl@team";
  const session = registry.registerSession(node.id, sessionName); registry.updateStatus(session.id, "running");
  registry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%1" });
  const occupant = registry.currentOccupantTenure(node.id)?.generationUuid ?? null;

  const writes: string[] = [];
  const hooks: { onPaste: (() => unknown) | null } = { onPaste: null };
  const tmux = new TmuxAdapter(async (command) => {
    if (command.includes("paste-buffer") || command.includes("send-keys")) writes.push(command.includes("paste-buffer") ? "paste" : "keys");
    if (command.includes("paste-buffer")) { const hook = hooks.onPaste; hooks.onPaste = null; await hook?.(); }
    return "";
  }, { writeFile: async () => {}, unlink: async () => {}, tmpName: () => join(root, "paste"), bufferName: () => "bridge-test" });
  vi.spyOn(tmux, "getPanePid").mockResolvedValue(10);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
  vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1", index: 0, cwd: root, width: 120, height: 40, active: true }]);
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" } as never);
  vi.spyOn(tmux, "isPaneInMode").mockResolvedValue(false);
  const screen = { text: "● ready\n────────\n❯ \n────────" };
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => screen.text);
  vi.spyOn(ProcessCensus.prototype, "list").mockResolvedValue([{ pid: 10, ppid: 1, command: "zsh" }, { pid: 20, ppid: 10, command: "claude" }] as never);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name), async () => {});
  tmux.deliveryGuard = guard;
  let now = Date.parse("2026-11-14T18:00:00Z");
  // The rig's delivery drain, as startup reads it (the queue's deliveryDrains.holds); a test points it at its queue.
  let drained: (sessionName: string) => boolean = () => false;
  const bridgeEvents: Array<Record<string, unknown>> = [];
  const bridge = new HookBridge(db, { now: () => now, lease: (id, fn) => guard.exclusive(id, fn), drained: (name) => drained(name), emit: (e) => { bridgeEvents.push(e as never); } });
  const eventBus = withEvents ? new EventBus(db) : undefined;
  const evidence: Array<Record<string, unknown>> = [];
  if (eventBus) { const emit = eventBus.emit.bind(eventBus); vi.spyOn(eventBus, "emit").mockImplementation(((e: Record<string, unknown>) => { if (e.type === "transport.delivery_evidence") evidence.push(e); return emit(e as never); }) as never); }
  const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: tmux, hookBridge: bridge, sleep: async () => {},
    listProcesses: async () => [], ...(eventBus ? { eventBus } : {}) } as never);
  const optInAndArm = () => {
    bridge.setPreference(node.id, true, "human@team", "wake at turn boundaries");
    return bridge.arm({ nodeId: node.id, sessionName, generation: occupant, hookEvent: "SessionStart" });
  };
  /** A new occupant in the same seat and pane, as a handover leaves it. */
  const replaceOccupant = () => { const next = registry.registerSession(node.id, sessionName, "handover"); registry.updateStatus(next.id, "running");
    registry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%1" }); return registry.currentOccupantTenure(node.id)?.generationUuid ?? null; };
  return { db, rigId: rig.id, drainWith: (read: (sessionName: string) => boolean) => { drained = read; },
    guard, bridge, bridgeEvents, transport, writes, hooks, screen, evidence, occupant, nodeId: node.id, sessionName, optInAndArm, replaceOccupant, advance: (ms: number) => { now += ms; } };
}

describe("the transport's hook-bridge branch (slice 13)", () => {
  it("queues for a live bridge and types nothing", async () => {
    const s = await seat();
    s.optInAndArm();
    const result = await s.transport.send(s.sessionName, "From: peer@team\n---\nhello\n---", { actorSession: "peer@team" });
    expect(result).toMatchObject({ ok: true, outcome: "bridged", sent: false });
    expect(s.writes).toEqual([]);
    expect(s.bridge.queued(s.nodeId)).toHaveLength(1);
  });

  it("keeps an old bridge attempt on its typed fallback after the preference switches to native", async () => {
    const pendingAtExpiry = async (s: Awaited<ReturnType<typeof seat>>) => {
      const { armId } = s.optInAndArm();
      s.bridge.turnStarted(s.nodeId);
      const queued = await s.transport.send(s.sessionName, "pending before route switch", { actorSession: "peer@team" });
      expect(queued.outcome).toBe("bridged");
      const id = queued.outboxIds![0]!;
      expect(new OutboxHandler(s.db).inputRoute(id)).toBeNull();
      new RigRepository(s.db).setNodeInputRoute(s.nodeId, "native");
      s.bridge.expired(s.nodeId, s.sessionName, armId);
      s.advance(HOOK_BRIDGE_LIVE_BOUND_MS);
      return id;
    };

    const s = await seat();
    const id = await pendingAtExpiry(s);
    const fallback = await s.transport.sweepHookBridge();
    expect(fallback.map(r => r.outboxId)).toEqual([id]);
    expect(fallback[0]!.result.reason).not.toBe("runner_unavailable");
    expect(fallback[0]!.result).toMatchObject({ ok: true });
    expect(fallback[0]!.result.runnerReceipt).toBeUndefined();
    expect(s.writes).toEqual(["paste", "keys"]);
    expect(new OutboxHandler(s.db).getById(id)?.deliveryState).toBe("delivered");
    expect(s.bridge.queued(s.nodeId)).toEqual([]);

    // The preference still selects new messages; an ordinary Claude seat has no native runner.
    const next = await s.transport.send(s.sessionName, "new after route switch", { actorSession: "peer@team" });
    expect(next).toMatchObject({ ok: false, reason: "runner_unavailable" });
    expect(s.writes).toEqual(["paste", "keys"]);

    // The original typed fallback still obeys the typing guard.
    const held = await seat();
    const heldId = await pendingAtExpiry(held);
    await held.guard.set(held.nodeId, { mode: "hold" }, "human@team", "quiet");
    const retained = await held.transport.sweepHookBridge();
    expect(retained[0]!.result).toMatchObject({ outcome: "retained", reason: "typing_guard_enabled" });
    expect(new OutboxHandler(held.db).getById(heldId)?.deliveryState).toBe("retained");
    expect(held.writes).toEqual([]);
  });

  it("types when the bridge has no live arm, and says the bridge wasn't available", async () => {
    const s = await seat();
    s.optInAndArm();
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS + 1);
    const result = await s.transport.send(s.sessionName, "From: peer@team\n---\nhello\n---", { actorSession: "peer@team" });
    expect(result.outcome).not.toBe("bridged");
    expect(s.writes).toContain("paste");
    expect(result.warning).toMatch(/hook bridge isn't available .*delivered by typing instead/);
  });

  // #3270 follow-up: a message sent after its seat's waiter expired is typed, and the expiry reached only the sender's
  // warning. Its own delivery record, persisted, now says why it was typed; a send the bridge wasn't in the way of doesn't.
  it("names the expiry on the delivery record of a message typed because its waiter expired", async () => {
    const s = await seat({ withEvents: true });
    const records = () => (s.db.prepare("SELECT payload FROM events WHERE type = 'transport.delivery_evidence' ORDER BY seq").all() as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    await s.transport.send(s.sessionName, "From: peer@team\n---\nbefore opting in\n---", { actorSession: "peer@team" });
    const { armId } = s.optInAndArm();
    s.bridge.expired(s.nodeId, s.sessionName, armId);
    const result = await s.transport.send(s.sessionName, "From: peer@team\n---\nfresh after expiry\n---", { actorSession: "peer@team" });
    expect(s.writes).toEqual(["paste", "keys", "paste", "keys"]);
    const reason = "its waiter expired at 2026-11-14T18:00:00.000Z and no turn has re-armed it";
    expect(result.warning).toContain(reason);
    const [before, fresh] = records();
    expect(records()).toHaveLength(2);
    expect(before).not.toHaveProperty("hookBridgeUnavailable");
    expect(fresh).toMatchObject({ messageId: s.evidence[1]!.messageId, written: "submitted", hookBridgeUnavailable: reason });
    expect(fresh!.wireSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lets the typing guard's hold decide first: held, not queued for the bridge", async () => {
    const s = await seat();
    s.optInAndArm();
    await s.guard.set(s.nodeId, { mode: "hold" }, "human@team", "quiet");
    const result = await s.transport.send(s.sessionName, "From: peer@team\n---\nhello\n---", { actorSession: "peer@team" });
    expect(result).toMatchObject({ outcome: "retained", reason: "typing_guard_enabled" });
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
    expect(s.writes).toEqual([]);
  });

  // #3270 proof item 2, as corrected (slice 13 SPEC:44): a message pending when the waiter expires isn't held for the
  // next turn; once it has waited the live bound it's typed through the ordinary typed path, under the typing guard, and
  // the record names the expiry as the reason.
  it("types a message pending when its waiter expires once it has waited the live bound, under the typing guard, with the expiry as its reason (proof item 2)", async () => {
    /** A person's turn holds the message while the waiter polls; then the waiter reaches its deadline and expires. */
    const pendingAtExpiry = async (s: Awaited<ReturnType<typeof seat>>) => {
      const { armId } = s.optInAndArm();
      s.bridge.turnStarted(s.nodeId);
      const queued = await s.transport.send(s.sessionName, "From: peer@team\n---\npending at expiry\n---", { actorSession: "peer@team" });
      expect(queued.outcome).toBe("bridged");
      const id = queued.outboxIds![0]!;
      expect(s.bridge.poll(s.nodeId, armId)).toEqual({ action: "wait" });
      s.bridge.expired(s.nodeId, s.sessionName, armId);
      // 1. Pending at the moment the waiter expires.
      expect(s.bridge.queued(s.nodeId).map((r) => r.outboxId)).toEqual([id]);
      expect(s.bridgeEvents.at(-1)).toMatchObject({ type: "transport.hook_bridge_expired", armId });
      return id;
    };

    const s = await seat();
    const id = await pendingAtExpiry(s);
    // 2. Not held for a next turn: typed once it has waited the live bound, with no turn boundary in between.
    expect(await s.transport.sweepHookBridge()).toEqual([]);
    expect(s.writes).toEqual([]);
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS);
    const typed = await s.transport.sweepHookBridge();
    expect(typed.map((t) => t.outboxId)).toEqual([id]);
    // 3. Through the ordinary typed path: pasted and submitted under its own outbox id, and delivered.
    expect(typed[0]!.result.ok).toBe(true);
    expect(s.writes).toEqual(["paste", "keys"]);
    expect(new OutboxHandler(s.db).getById(id)?.deliveryState).toBe("delivered");
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
    // 4. The record names the expiry as the reason.
    expect(s.bridgeEvents.filter((e) => e.type === "transport.hook_bridge_fallback")).toEqual([
      expect.objectContaining({ outboxIds: [id], reason: expect.stringMatching(/its waiter expired at .* and no turn has re-armed it/) })]);

    // 3. Under the typing guard: a seat whose guard holds gets the same fallback held, not typed.
    const h = await seat();
    const heldId = await pendingAtExpiry(h);
    await h.guard.set(h.nodeId, { mode: "hold" }, "human@team", "quiet");
    h.advance(HOOK_BRIDGE_LIVE_BOUND_MS);
    const held = await h.transport.sweepHookBridge();
    expect(held.map((t) => t.outboxId)).toEqual([heldId]);
    expect(held[0]!.result).toMatchObject({ outcome: "retained", reason: "typing_guard_enabled" });
    expect(h.writes).toEqual([]);
  });

  it("types a message queued before its waiter vanished, under its own outbox id, after the bound", async () => {
    const s = await seat();
    s.optInAndArm();
    const queued = await s.transport.send(s.sessionName, "From: peer@team\n---\nhello\n---", { actorSession: "peer@team" });
    const id = queued.outboxIds![0]!;
    expect(await s.transport.sweepHookBridge()).toEqual([]); // still live
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS + 1);
    const typed = await s.transport.sweepHookBridge();
    expect(typed.map((t) => t.outboxId)).toEqual([id]);
    expect(s.writes).toContain("paste");
    expect(new OutboxHandler(s.db).getById(id)?.deliveryState).not.toBe("sending");
  });
  // #3270 round 1: exactly once on the fallback.
  it("types each queued message once when two sweeps overlap", async () => {
    const s = await seat();
    s.optInAndArm();
    await s.transport.send(s.sessionName, "From: peer@team\n---\none\n---", { actorSession: "peer@team" });
    await s.transport.send(s.sessionName, "From: peer@team\n---\ntwo\n---", { actorSession: "peer@team" });
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS + 1);
    const [a, b] = await Promise.all([s.transport.sweepHookBridge(), s.transport.sweepHookBridge()]);
    expect(a.map((t) => t.outboxId)).toEqual(b.map((t) => t.outboxId));
    expect(a).toHaveLength(2);
    expect(s.writes.filter((w) => w === "paste")).toHaveLength(2);
  });

  it("never types a message a waiter claimed during the sweep, and doesn't let anything behind it overtake", async () => {
    const s = await seat();
    s.optInAndArm();
    await s.transport.send(s.sessionName, "From: peer@team\n---\none\n---", { actorSession: "peer@team" });
    const second = await s.transport.send(s.sessionName, "From: peer@team\n---\ntwo\n---", { actorSession: "peer@team" });
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS + 1);
    // While the first is typed, its turn's Stop arms a new waiter, which claims the second.
    s.hooks.onPaste = () => {
      const { armId } = s.bridge.arm({ nodeId: s.nodeId, sessionName: s.sessionName, generation: s.occupant, hookEvent: "Stop" });
      s.bridge.poll(s.nodeId, armId);
    };
    const typed = await s.transport.sweepHookBridge();
    expect(typed).toHaveLength(1);
    expect(s.writes.filter((w) => w === "paste")).toHaveLength(1);
    expect(new OutboxHandler(s.db).getById(second.outboxIds![0]!)?.deliveryState).toBe("sending"); // the bridge's, claimed
  });
  // #3270 round 2.
  /** A queue whose wakes go through this seat's real transport, as startup wires it. */
  const queueOn = (s: Awaited<ReturnType<typeof seat>>) => {
    const repo = new QueueRepository(s.db, new EventBus(s.db), { validateRig: () => true });
    repo.attachTransport(s.transport as never);
    repo.attachOutbox(new OutboxHandler(s.db));
    return repo;
  };
  const handoffTo = async (s: Awaited<ReturnType<typeof seat>>, repo: QueueRepository) => {
    const source = await repo.create({ nudge: false, sourceSession: "planner@team", destinationSession: "driver@team", body: "x" });
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "driver@team", toSession: s.sessionName, body: "your turn" });
    const id = `wake-intent-${created.qitemId}`;
    await vi.waitFor(() => expect(repo.getById(created.qitemId)?.lastNudgeResult).toBe("bridged:queued"));
    return { qitemId: created.qitemId, id };
  };

  it("hands a queue handoff's wake to an armed seat's waiter once, and leaves it to the bridge (R2-F2)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const repo = queueOn(s);
    const { id } = await handoffTo(s, repo);
    expect(s.writes).toEqual([]);
    expect(new OutboxHandler(s.db).getById(id)?.deliveryState).toBe("sending");
    const polled = s.bridge.poll(s.nodeId, armId) as { action: string; batchId: string; messages: Array<{ outboxId: string }> };
    expect(polled.messages.map((m) => m.outboxId)).toEqual([id]);
    s.bridge.ack(s.nodeId, s.sessionName, s.occupant, armId, polled.batchId);
    expect(new OutboxHandler(s.db).getById(id)?.deliveryState).toBe("delivered");
    await repo.drainPendingWakeIntents();
    expect(await s.transport.sweepHookBridge()).toEqual([]);
    expect(s.writes).toEqual([]);
  });

  it("types a queue handoff's wake once when its waiter is gone, and the queue's own drain doesn't type it again (R2-F2)", async () => {
    const s = await seat();
    s.optInAndArm();
    const repo = queueOn(s);
    const { id } = await handoffTo(s, repo);
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS + 1);
    expect((await s.transport.sweepHookBridge()).map((t) => t.outboxId)).toEqual([id]);
    await repo.drainPendingWakeIntents();
    expect(await s.transport.sweepHookBridge()).toEqual([]);
    expect(s.writes.filter((w) => w === "paste")).toHaveLength(1);
    expect(new OutboxHandler(s.db).getById(id)?.deliveryState).not.toBe("sending");
  });

  it("doesn't type a message queued for an earlier occupant into the seat's new one (R2-F3)", async () => {
    const s = await seat();
    s.optInAndArm();
    const queued = await s.transport.send(s.sessionName, "From: peer@team\n---\nfor the first occupant\n---", { actorSession: "peer@team" });
    // The new occupant's own launch arms its waiter.
    const next = s.replaceOccupant();
    s.bridge.arm({ nodeId: s.nodeId, sessionName: s.sessionName, generation: next, hookEvent: "SessionStart" });
    const typed = await s.transport.sweepHookBridge();
    expect(s.writes).toEqual([]);
    expect(typed.map((t) => t.result.reason)).toEqual(["guard_target_changed"]);
    expect(new OutboxHandler(s.db).getById(queued.outboxIds![0]!)?.deliveryState).toBe("failed");
    expect(await s.transport.sweepHookBridge()).toEqual([]);
  });

  it("keeps an OpenRig notice's own admission through the fallback: a seat that admits only OpenRig's notices lets it through (R2-F3)", async () => {
    const s = await seat();
    s.optInAndArm();
    await s.transport.send(s.sessionName, "From: openrig\n---\nnotice\n---", { actorSession: "queue@system", openrigNotice: true });
    await s.guard.set(s.nodeId, { mode: "openrig-urgent" }, "human@team", "only OpenRig's notices");
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS + 1);
    const [typed] = await s.transport.sweepHookBridge();
    // Admitted as OpenRig's notice, not held by the level as an agent's send would be. The level delivers what it admits
    // as draft-aware, which reads the input box; this scripted terminal reports no cursor, so draft-aware holds it there.
    expect(typed!.result.reason).not.toBe("typing_guard_enabled");
    expect(typed!.result.reason).toBe("draft_input_unknown");
  });

  it("doesn't bridge a send bound to an original conversation: it takes the typed path, where that's enforced (R2-F3)", async () => {
    const s = await seat();
    s.optInAndArm();
    const result = await s.transport.send(s.sessionName, "From: peer@team\n---\nfor that conversation\n---", { actorSession: "peer@team",
      expectedIdentity: { nodeId: s.nodeId, sessionName: s.sessionName, runtime: "claude-code", nativeId: "native-1" } } as never);
    expect(result.outcome).not.toBe("bridged");
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
  });

  it("doesn't let a poll take the next message while the first one's typed fallback is unfinished, nor a newer send overtake (R2-F5)", async () => {
    const s = await seat();
    s.optInAndArm();
    const first = await s.transport.send(s.sessionName, "From: peer@team\n---\none\n---", { actorSession: "peer@team" });
    const second = await s.transport.send(s.sessionName, "From: peer@team\n---\ntwo\n---", { actorSession: "peer@team" });
    s.advance(HOOK_BRIDGE_LIVE_BOUND_MS + 1);
    let resume!: () => void;
    s.hooks.onPaste = () => new Promise<void>((r) => { resume = r; }); // the first typed write pauses inside the seat's lease
    const sweeping = s.transport.sweepHookBridge();
    await vi.waitFor(() => expect(s.writes).toContain("paste"));
    // Meanwhile a turn boundary arms a new waiter, which polls, and a newer message arrives.
    const { armId } = s.bridge.arm({ nodeId: s.nodeId, sessionName: s.sessionName, generation: s.occupant, hookEvent: "Stop" });
    const order: string[] = [];
    const polled = s.bridge.pollUnderLease(s.nodeId, armId).then((r) => { order.push("poll"); return r; });
    const newer = s.transport.send(s.sessionName, "From: peer@team\n---\nthree\n---", { actorSession: "peer@team" }).then((r) => { order.push("newer"); return r; });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]);
    resume();
    const typed = await sweeping;
    expect(typed.map((t) => t.outboxId)).toEqual([first.outboxIds![0]]);
    expect(((await polled) as { messages: Array<{ outboxId: string }> }).messages.map((m) => m.outboxId)).toEqual([second.outboxIds![0]]);
    expect((await newer).outcome).toBe("bridged");
    expect(order).toEqual(["poll", "newer"]);
    expect(s.writes.filter((w) => w === "paste")).toHaveLength(1);
  });
  // #3270 round 3.
  it("doesn't bridge a send that carries a write-time check, such as managed compaction's /compact: it's typed, and its check runs (F5)", async () => {
    const s = await seat();
    s.optInAndArm();
    let checked = 0;
    const compact = await s.transport.send(s.sessionName, "/compact OpenRig managed compaction", { actorSession: "openrig@system", openrigNotice: true, beforeWrite: () => { checked++; } });
    expect(compact.outcome).not.toBe("bridged");
    expect(checked).toBeGreaterThan(0);
    expect(s.writes).toContain("paste");
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
  });

  it("doesn't bridge a slash command even without a check: Claude runs those only from typed input (F5)", async () => {
    const s = await seat();
    s.optInAndArm();
    const result = await s.transport.send(s.sessionName, "/clear", { actorSession: "peer@team" });
    expect(result.outcome).not.toBe("bridged");
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
  });

  it("types the watchdog's periodic reminders and parked-owner wakes to an armed seat, never queuing them (R3-F2, interim)", async () => {
    const s = await seat();
    s.optInAndArm();
    const deliver = makeWatchdogDeliver({ sessionTransport: s.transport, outbox: new OutboxHandler(s.db) });
    const periodic = await deliver({ targetSession: s.sessionName, message: "periodic check" }, { jobId: "job-p", policy: "periodic-reminder", occurrenceId: "occ-1" });
    const parked = await deliver({ targetSession: s.sessionName, message: "you hold an open row" }, { jobId: "job-q", policy: "parked-owner-consumer" });
    expect([periodic.status, parked.status]).toEqual(["ok", "ok"]);
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
    expect(s.writes.filter((w) => w === "paste")).toHaveLength(2);
  });

  it("doesn't claim a send is queued when its id is already settled: it takes today's path for a reused id, and a new id still queues (R3-F3)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const first = await s.transport.send(s.sessionName, "From: peer@team\n---\none\n---", { actorSession: "peer@team", deliveryId: "reused-1" });
    expect(first.outcome).toBe("bridged");
    const polled = s.bridge.poll(s.nodeId, armId) as { batchId: string };
    s.bridge.ack(s.nodeId, s.sessionName, s.occupant, armId, polled.batchId);
    s.bridge.arm({ nodeId: s.nodeId, sessionName: s.sessionName, generation: s.occupant, hookEvent: "Stop" });
    const again = await s.transport.send(s.sessionName, "From: peer@team\n---\none again\n---", { actorSession: "peer@team", deliveryId: "reused-1" });
    expect(again.outcome).not.toBe("bridged");
    expect(again.warning ?? "").not.toMatch(/Queued for/);
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
    expect((await s.transport.send(s.sessionName, "From: peer@team\n---\nnew\n---", { actorSession: "peer@team", deliveryId: "fresh-1" })).outcome).toBe("bridged");
  });

  it("writes a queue wake's end at the bridge back to its row: a refused fallback reads as the refusal, so prompt-clear recovery sees it (R3)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const repo = queueOn(s);
    s.bridge.onEnd = (end) => { if (end.auditPointer) repo.recordBridgedWakeEnd(end.auditPointer, end); };
    // Handed to the hook.
    const handed = await handoffTo(s, repo);
    const polled = s.bridge.poll(s.nodeId, armId) as { batchId: string };
    s.bridge.ack(s.nodeId, s.sessionName, s.occupant, armId, polled.batchId);
    expect(repo.getById(handed.qitemId)?.lastNudgeResult).toBe("bridged:handed-to-hook");
    // Typed by the fallback into a seat at a permission prompt: refused, as typed delivery records it.
    const refused = await handoffTo(s, repo);
    // The woken turn never ends with a Stop: past the turn bound, the queued wake is typed.
    s.advance(HOOK_BRIDGE_TURN_BOUND_MS + 1);
    s.screen.text = "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)";
    const typed = await s.transport.sweepHookBridge();
    expect(typed.map((t) => t.outboxId)).toEqual([refused.id]);
    expect(repo.getById(refused.qitemId)?.lastNudgeResult).toMatch(/^failed:(target_needs_input|Refused:.*interactive prompt)/);
  });
  // #3270 round 4, R4-F1: wired as startup wires it, with the delivery-evidence observer running.
  it("bridges a plain message to an armed seat when the transport records delivery evidence, as in production, and the evidence says nothing was typed (R4-F1)", async () => {
    const s = await seat({ withEvents: true });
    s.optInAndArm();
    const result = await s.transport.send(s.sessionName, "From: peer@team\n---\nhello\n---", { actorSession: "peer@team" });
    expect(result).toMatchObject({ ok: true, outcome: "bridged", sent: false });
    expect(s.writes).toEqual([]);
    expect(s.bridge.queued(s.nodeId)).toHaveLength(1);
    expect(s.evidence.at(-1)).toMatchObject({ written: "none", terminalObserved: { outcome: "bridged" }, admitted: { outboxIds: result.outboxIds } });
  });

  it("still types a send whose caller watches its input effect, and a plain-text send with a write-time check, with the evidence observer running (R4-F1)", async () => {
    const s = await seat({ withEvents: true });
    s.optInAndArm();
    const effects: string[] = [];
    const watched = await s.transport.send(s.sessionName, "From: peer@team\n---\nwatched\n---", { actorSession: "peer@team", onInputEffect: (phase) => { effects.push(phase); } });
    expect(watched.outcome).not.toBe("bridged");
    expect(effects).toContain("pasted");
    let checked = 0;
    const checkedSend = await s.transport.send(s.sessionName, "From: peer@team\n---\nchecked\n---", { actorSession: "peer@team", beforeWrite: () => { checked++; } });
    expect(checkedSend.outcome).not.toBe("bridged");
    expect(checked).toBeGreaterThan(0);
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
  });

  it("types the watchdog's reminders to an armed seat with the evidence observer running too (R4-F1)", async () => {
    const s = await seat({ withEvents: true });
    s.optInAndArm();
    const deliver = makeWatchdogDeliver({ sessionTransport: s.transport, outbox: new OutboxHandler(s.db) });
    expect((await deliver({ targetSession: s.sessionName, message: "periodic check" }, { jobId: "job-p", policy: "periodic-reminder", occurrenceId: "occ-1" })).status).toBe("ok");
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
    expect(s.writes).toContain("paste");
  });
  // #3270 round 6, F1: a rig's delivery drain holds the bridge's automatic deliveries as it holds typed ones.
  it("holds a bridged queue wake while the seat's rig is drained: the poll waits and the sweep types nothing; once the drain ends, the poll delivers in order (F1)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const repo = queueOn(s);
    s.drainWith((name) => repo.deliveryDrains.holds(name));
    const first = await handoffTo(s, repo);
    const second = await handoffTo(s, repo);
    expect(s.bridge.queued(s.nodeId).map((r) => r.outboxId)).toEqual([first.id, second.id]);
    const jobs = new WatchdogJobsRepository(s.db);
    repo.deliveryDrains.begin(s.rigId, { drainId: "maintenance-1", owner: "owner@team", reviewAt: new Date(Date.now() + 3_600_000).toISOString() }, jobs);
    expect(s.bridge.poll(s.nodeId, armId)).toEqual({ action: "wait" });
    s.advance(HOOK_BRIDGE_TURN_BOUND_MS + 1);
    expect(await s.transport.sweepHookBridge()).toEqual([]);
    expect(s.writes).toEqual([]);
    expect(s.bridge.queued(s.nodeId).map((r) => r.outboxId)).toEqual([first.id, second.id]);
    repo.deliveryDrains.end(s.rigId, "maintenance-1", jobs);
    const polled = s.bridge.poll(s.nodeId, armId) as { action: string; messages: Array<{ outboxId: string }> };
    expect(polled.action).toBe("deliver");
    expect(polled.messages.map((m) => m.outboxId)).toEqual([first.id, second.id]);
    expect(s.writes).toEqual([]);
  });

  it("lets a direct send through the bridge during a drain, as typed direct sends pass it (F1)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const repo = queueOn(s);
    s.drainWith((name) => repo.deliveryDrains.holds(name));
    repo.deliveryDrains.begin(s.rigId, { drainId: "maintenance-2", owner: "owner@team", reviewAt: new Date(Date.now() + 3_600_000).toISOString() }, new WatchdogJobsRepository(s.db));
    const direct = await s.transport.send(s.sessionName, "From: peer@team\n---\ndirect\n---", { actorSession: "peer@team" });
    expect(direct.outcome).toBe("bridged");
    expect((s.bridge.poll(s.nodeId, armId) as { messages: Array<{ outboxId: string }> }).messages.map((m) => m.outboxId)).toEqual(direct.outboxIds);
  });
  // #3270 round 7.
  const beginDrain = (s: Awaited<ReturnType<typeof seat>>, repo: QueueRepository, id: string) => {
    const jobs = new WatchdogJobsRepository(s.db);
    repo.deliveryDrains.begin(s.rigId, { drainId: id, owner: "owner@team", reviewAt: new Date(Date.now() + 3_600_000).toISOString() }, jobs);
    return () => repo.deliveryDrains.end(s.rigId, id, jobs);
  };
  const state = (s: Awaited<ReturnType<typeof seat>>, id: string) => new OutboxHandler(s.db).getById(id)?.deliveryState;

  it("doesn't type a drain-held wake when a direct send to a seat with no live waiter sweeps its queue; the direct send arrives (R7-1)", async () => {
    const s = await seat();
    s.optInAndArm();
    const repo = queueOn(s);
    s.drainWith((name) => repo.deliveryDrains.holds(name));
    const held = await handoffTo(s, repo);
    beginDrain(s, repo, "m-r7-1");
    s.advance(HOOK_BRIDGE_TURN_BOUND_MS + 1); // no live waiter now
    const direct = await s.transport.send(s.sessionName, "From: peer@team\n---\ndirect\n---", { actorSession: "peer@team" });
    await s.transport.sweepHookBridge({ nodeId: s.nodeId });
    expect(direct).toMatchObject({ ok: true });
    expect(direct.outcome).not.toBe("bridged");
    expect(s.writes.filter((w) => w === "paste")).toHaveLength(1);
    expect(s.bridge.queued(s.nodeId).map((r) => r.outboxId)).toEqual([held.id]);
  });

  it("doesn't hand back a wake whose rig's drain began after the sweep selected it, before the final handback (R7-1)", async () => {
    const s = await seat();
    s.optInAndArm();
    const repo = queueOn(s);
    s.drainWith((name) => repo.deliveryDrains.holds(name));
    const wake = await handoffTo(s, repo);
    s.advance(HOOK_BRIDGE_TURN_BOUND_MS + 1);
    let release!: () => void;
    const holding = s.guard.exclusive(s.nodeId, () => new Promise<void>((r) => { release = r; }));
    const sweeping = s.transport.sweepHookBridge();
    await new Promise((r) => setTimeout(r, 30)); // the sweep has selected the wake and waits for the seat's lease
    beginDrain(s, repo, "m-r7-2");
    release(); await holding;
    expect(await sweeping).toEqual([]);
    expect(s.writes).toEqual([]);
    expect(s.bridge.queued(s.nodeId).map((r) => r.outboxId)).toEqual([wake.id]);
  });

  it("lets a direct send and the explicit resolve notice pass a drain-held wake; the held wake arrives after the drain ends (R7-2)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const repo = queueOn(s);
    s.drainWith((name) => repo.deliveryDrains.holds(name));
    const held = await handoffTo(s, repo);
    const end = beginDrain(s, repo, "m-r7-3");
    const direct = await s.transport.send(s.sessionName, "From: peer@team\n---\ndirect\n---", { actorSession: "peer@team" });
    const explicit = await s.transport.send(s.sessionName, "From: openrig\n---\nresolved\n---", { actorSession: "lead@team", queueWake: true, drainExempt: true, deliveryId: "explicit-1" } as never);
    const during = s.bridge.poll(s.nodeId, armId) as { action: string; batchId: string; messages: Array<{ outboxId: string }> };
    expect(during.messages.map((m) => m.outboxId)).toEqual([direct.outboxIds![0], explicit.outboxIds![0]]);
    s.bridge.ack(s.nodeId, s.sessionName, s.occupant, armId, during.batchId);
    end();
    const next = s.bridge.arm({ nodeId: s.nodeId, sessionName: s.sessionName, generation: s.occupant, hookEvent: "Stop" });
    expect((s.bridge.poll(s.nodeId, next.armId) as { messages: Array<{ outboxId: string }> }).messages.map((m) => m.outboxId)).toEqual([held.id]);
  });

  it("doesn't hand over a queue wake whose row was claimed while it waited: it ends not delivered (R7-3)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const repo = queueOn(s);
    const wake = await handoffTo(s, repo);
    repo.claim({ qitemId: wake.qitemId, destinationSession: s.sessionName });
    expect(s.bridge.poll(s.nodeId, armId)).toEqual({ action: "wait" });
    expect(state(s, wake.id)).toBe("failed");
    expect(s.bridge.status(s.nodeId, s.occupant).notDelivered.outboxIds).toEqual([wake.id]);
  });

  it("doesn't queue a send whose caller cancelled it while it waited for the seat's lease (R7-4)", async () => {
    const s = await seat();
    s.optInAndArm();
    let release!: () => void;
    const holding = s.guard.exclusive(s.nodeId, () => new Promise<void>((r) => { release = r; }));
    const controller = new AbortController();
    const sending = s.transport.send(s.sessionName, "From: peer@team\n---\ncancelled\n---", { actorSession: "peer@team", signal: controller.signal });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    release(); await holding;
    expect((await sending).outcome).not.toBe("bridged");
    expect(s.bridge.queued(s.nodeId)).toEqual([]);
    expect(s.writes).toEqual([]);
  });
  it("puts a new message behind ones already queued after the seat opted out, so the fallback types them in order (R7-5)", async () => {
    const s = await seat();
    s.optInAndArm();
    const first = await s.transport.send(s.sessionName, "From: peer@team\n---\none\n---", { actorSession: "peer@team" });
    expect(first.outcome).toBe("bridged");
    s.bridge.setPreference(s.nodeId, false, "human@team", "back to typed");
    const second = await s.transport.send(s.sessionName, "From: peer@team\n---\ntwo\n---", { actorSession: "peer@team" });
    expect(second.outcome).toBe("bridged"); // queued behind the first, not typed ahead of it
    const typed = await s.transport.sweepHookBridge();
    expect(typed.map((t) => t.outboxId)).toEqual([first.outboxIds![0], second.outboxIds![0]]);
  });

  it("delivers and reports when the wake check throws before deposit (R8)", async () => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const error = new Error("wake read unavailable");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    s.transport.configureGuardedWakes(() => { throw error; });
    const result = await s.transport.send(s.sessionName, "automatic wake", { actorSession: "peer@team", queueWake: true });
    expect(result).toMatchObject({ ok: true, outcome: "bridged" });
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/queue wake.*couldn't be read; delivering/), error);
    expect(s.bridge.poll(s.nodeId, armId)).toMatchObject({ action: "deliver", messages: [{ text: "automatic wake" }] });
    expect(s.writes).toEqual([]);
  });

  it.each(["poll", "handback"] as const)("delivers and reports when the wake check throws at %s (R8)", async (stage) => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    s.transport.configureGuardedWakes(() => true);
    const queued = await s.transport.send(s.sessionName, "automatic wake", { actorSession: "peer@team", queueWake: true });
    expect(queued.outcome).toBe("bridged");
    const error = new Error("later wake read unavailable");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    s.transport.configureGuardedWakes(() => { throw error; });
    if (stage === "poll") {
      expect(s.bridge.poll(s.nodeId, armId)).toMatchObject({ action: "deliver", messages: [{ text: "automatic wake" }] });
    } else {
      s.advance(HOOK_BRIDGE_TURN_BOUND_MS + 1);
      const handedBack = await s.transport.sweepHookBridge({ nodeId: s.nodeId });
      expect(handedBack).toHaveLength(1);
      expect(handedBack[0]!.result).toMatchObject({ ok: true });
      expect(s.writes).toContain("paste");
    }
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/queue wake.*couldn't be read; delivering/), error);
  });

  it.each([false, true])("keeps the known wake decision %s at deposit (R8)", async (applicable) => {
    const s = await seat();
    s.optInAndArm();
    const check = vi.fn(() => applicable);
    s.transport.configureGuardedWakes(check);
    const result = await s.transport.send(s.sessionName, "automatic wake", { actorSession: "peer@team", queueWake: true });
    expect(check).toHaveBeenCalled();
    if (applicable) {
      expect(result).toMatchObject({ ok: true, outcome: "bridged" });
      expect(s.bridge.queued(s.nodeId)).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ ok: true, sent: false, verified: false, outcome: "retained", reason: "draft_wake_superseded" });
      expect(result.warning).toMatch(/Held, not delivered/);
      expect(s.bridge.queued(s.nodeId)).toEqual([]);
    }
    expect(s.writes).toEqual([]);
  });

  it.each([false, true])("exempts a direct or explicit send from the wake check: explicit=%s (R8)", async (explicit) => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const check = vi.fn(() => { throw new Error("must not check an exempt send"); });
    s.transport.configureGuardedWakes(check);
    const result = await s.transport.send(s.sessionName, "exempt message", { actorSession: "peer@team", ...(explicit ? { queueWake: true, drainExempt: true } : {}) });
    expect(result.outcome).toBe("bridged");
    expect(s.bridge.poll(s.nodeId, armId)).toMatchObject({ action: "deliver" });
    expect(check).not.toHaveBeenCalled();
  });

  it.each(["poll", "fallback"] as const)("skips an explicit wake fenced after bridge deposit at %s", async (mode) => {
    const s = await seat();
    const { armId } = s.optInAndArm();
    const repo = new QueueRepository(s.db, new EventBus(s.db), { validateRig: () => true, transport: s.transport });
    const row = await repo.create({ sourceSession: "peer@team", destinationSession: s.sessionName, body: "work", nudge: false });
    await repo.maybeNudge(row.qitemId, s.sessionName, true, row.sourceSession, undefined, "agent", { explicit: true });
    await s.transport.send(s.sessionName, "unrelated input", { actorSession: "peer@team" });
    expect(s.bridge.queued(s.nodeId)).toHaveLength(2);
    s.db.exec(`INSERT INTO queue_transfer_ledger (record_id, side, kind, transfer_id, archive_digest, origin_host_id,
      origin_minted_at, destination_host_id, authorization_digest, mapping_digest, actor, recorded_at)
      VALUES ('rel', 'origin', 'relinquished', 'transfer', 'digest', 'origin', 'minted', 'target', 'auth', 'map', 'operator', '1')`);
    s.db.prepare(`INSERT INTO queue_transfer_relinquished (qitem_id, record_id, archive_digest, destination_host_id, source_state)
      VALUES (?, 'rel', 'digest', 'target', 'pending')`).run(row.qitemId);

    if (mode === "poll") {
      expect(s.bridge.poll(s.nodeId, armId)).toMatchObject({ action: "deliver", messages: [{ text: "unrelated input" }] });
    } else {
      s.advance(HOOK_BRIDGE_TURN_BOUND_MS + 1);
      const typed = await s.transport.sweepHookBridge({ nodeId: s.nodeId });
      expect(typed.filter(item => item.result.ok)).toHaveLength(1);
      expect(s.writes.filter(write => write === "paste")).toHaveLength(1);
    }
  });

});
