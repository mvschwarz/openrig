// Slice 13: an opted-in Claude seat's hook bridge, without a real Claude. The preference and its attribution, which
// occupant it routes, the waiter's arm/poll/ack in send order, holding during a turn, the live bound and its typed
// fallback, expiry, and a claimed batch whose waiter vanished. The launch hooks and the waiter script have their own
// tests (kernel-authority, claude-hook-bridge-script); the transport's branch has session-transport-hook-bridge.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { HOOK_BRIDGE_LIVE_BOUND_MS, HOOK_BRIDGE_TURN_BOUND_MS, HookBridge, UNATTRIBUTED_ACTOR, type HookBridgeEvent } from "../src/domain/hook-bridge.js";

describe("the hook bridge (slice 13)", () => {
  let db: Database.Database;
  let now: number;
  let events: HookBridgeEvent[];
  let bridge: HookBridge;
  let nodeId: string;
  let held = false;
  const session = "dev-impl@team";
  const occupant = "gen-1";
  const target = () => ({ nodeId, session, occupant, pane: "%1" });

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const repo = new RigRepository(db);
    nodeId = repo.addNode(repo.createRig("team").id, "dev.impl", { runtime: "claude-code" }).id;
    now = Date.parse("2026-11-14T18:00:00Z");
    events = [];
    bridge = new HookBridge(db, { now: () => now, emit: (e) => events.push(e), version: () => "2.1.322", holds: () => held });
    held = false;
  });
  afterEach(() => db.close());

  const optIn = () => bridge.setPreference(nodeId, true, "human@team", "wake at turn boundaries");
  const queue = (text: string, id: string) => bridge.deposit(target(), session, text, { actorSession: "peer@team" }, [id]);
  const state = (id: string) => new OutboxHandler(db).getById(id)?.deliveryState;

  it("records who opted a seat in and why, and routes only an occupant whose own waiter armed", () => {
    expect(() => bridge.setPreference(nodeId, true, "human@team", " ")).toThrow(/reason is required/);
    // A person's terminal with no seat identity can opt in; the change is recorded as unattributed.
    expect(bridge.setPreference(nodeId, false, null, "from a plain terminal").actor).toBe(UNATTRIBUTED_ACTOR);
    expect(bridge.launchWanted(nodeId)).toBe(false);
    optIn();
    expect(bridge.launchWanted(nodeId)).toBe(true);
    expect(bridge.preference(nodeId)).toMatchObject({ desired: true, actor: "human@team", reason: "wake at turn boundaries", armedGeneration: null });
    // Opted in, but this occupant was launched before it: no waiter has armed, so delivery stays typed.
    expect(bridge.routes(target())).toBe(false);
    bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "SessionStart" });
    expect(bridge.routes(target())).toBe(true);
    expect(bridge.routes({ ...target(), occupant: "gen-2" })).toBe(false); // a successor needs its own launch
    bridge.setPreference(nodeId, false, "human@team", "back to typed");
    expect(bridge.routes(target())).toBe(false);
    // Every change is kept: the unattributed one, the opt-in and the opt-out.
    expect(db.prepare("SELECT COUNT(*) AS n FROM seat_hook_bridge_changes").get()).toEqual({ n: 3 });
  });

  it("delivers queued messages to the armed waiter in send order, and records them delivered into context, not done", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    const first = queue("From: peer@team\n---\nfirst\n---", "m1");
    queue("From: peer@team\n---\nsecond\n---", "m2");
    expect(first).toMatchObject({ ok: true, outcome: "bridged", sent: false, inputPhase: "not_reached", outboxIds: ["m1"] });
    expect(first.warning).toMatch(/one model turn on the seat's own login/);
    expect(state("m1")).toBe("sending");
    const polled = bridge.poll(nodeId, armId);
    expect(polled).toMatchObject({ action: "deliver" });
    expect(polled.action === "deliver" && polled.messages.map((m) => m.outboxId)).toEqual(["m1", "m2"]);
    // A second poll before the ack (its answer was lost) gets the same batch again, never a second one.
    const again = bridge.poll(nodeId, armId);
    expect(again).toMatchObject({ action: "deliver", batchId: (polled as { batchId: string }).batchId });
    expect(again.action === "deliver" && again.messages.map((m) => m.outboxId)).toEqual(["m1", "m2"]);
    const acked = bridge.ack(nodeId, session, armId, (polled as { batchId: string }).batchId);
    expect(acked.outboxIds).toEqual(["m1", "m2"]);
    expect(state("m1")).toBe("delivered");
    const receipt = JSON.parse((db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id = 'm1'").get() as { guard_delivery: string }).guard_delivery);
    expect(receipt).toMatchObject({ channel: "hook-bridge", state: "handed-to-hook", armId });
    expect(events.filter((e) => e.type === "transport.hook_bridge_wake")).toEqual([expect.objectContaining({ outboxIds: ["m1", "m2"] })]);
    expect(bridge.status(nodeId, occupant)).toMatchObject({ wakesSinceDaemonStart: 1, cost: expect.stringMatching(/one model turn/) });
  });

  it("never delivers into a running turn: a prompt holds messages until the turn's Stop re-arms", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    bridge.turnStarted(nodeId);
    queue("mid-turn", "m1");
    expect(bridge.poll(nodeId, armId)).toEqual({ action: "wait" });
    expect(bridge.live(nodeId)).toBe(true); // the waiter still polls: this isn't a dead bridge
    const next = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    expect(bridge.poll(nodeId, armId)).toEqual({ action: "superseded" });
    expect(bridge.poll(nodeId, next.armId)).toMatchObject({ action: "deliver" });
  });

  it("types after the live bound when the waiter is gone, and reports why", () => {
    optIn();
    bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("waiting", "m1");
    expect(bridge.dueForFallback()).toEqual([]);
    now += HOOK_BRIDGE_LIVE_BOUND_MS + 1;
    expect(bridge.live(nodeId)).toBe(false);
    const due = bridge.dueForFallback();
    expect(due).toEqual([{ nodeId, outboxIds: ["m1"], reason: expect.stringMatching(/hasn't polled for 20 s/) }]);
    expect(bridge.releaseForTyping(nodeId, session, "m1", due[0]!.reason)).toBe(true);
    expect(state("m1")).toBe("pending");
    expect(events.at(-1)).toMatchObject({ type: "transport.hook_bridge_fallback", outboxIds: ["m1"] });
  });

  it("waits on its own wake's turn up to the turn bound, then types", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("first", "m1");
    const polled = bridge.poll(nodeId, armId) as { batchId: string };
    bridge.ack(nodeId, session, armId, polled.batchId);
    queue("during the woken turn", "m2");
    now += HOOK_BRIDGE_LIVE_BOUND_MS * 3;
    expect(bridge.live(nodeId)).toBe(true);
    expect(bridge.dueForFallback()).toEqual([]);
    now += HOOK_BRIDGE_TURN_BOUND_MS;
    expect(bridge.dueForFallback().map((d) => d.outboxIds)).toEqual([["m2"]]);
  });

  it("reports an expired waiter, after which the bridge isn't live", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    bridge.expired(nodeId, session, armId);
    expect(bridge.live(nodeId)).toBe(false);
    expect(bridge.unavailable(nodeId)).toMatch(/expired at .* no turn has re-armed it/);
    expect(events.at(-1)).toMatchObject({ type: "transport.hook_bridge_expired", armId });
  });

  it("marks a claimed batch indeterminate, never resent, when its waiter is gone without an ack", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("claimed", "m1");
    bridge.poll(nodeId, armId);
    expect(bridge.reconcileUnacked()).toEqual([]); // its arm is still current
    bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    expect(bridge.reconcileUnacked()).toEqual(["m1"]);
    expect(state("m1")).toBe("indeterminate");
    expect(bridge.queued(nodeId)).toEqual([]);
  });
  // #3270 round 1.
  it("holds a polling arm's seat in a turn for at most the turn bound, then types (no Stop, a person's turn)", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    bridge.turnStarted(nodeId);
    queue("mid-turn", "m1");
    for (let t = 0; t < HOOK_BRIDGE_TURN_BOUND_MS; t += HOOK_BRIDGE_LIVE_BOUND_MS / 2) { now += HOOK_BRIDGE_LIVE_BOUND_MS / 2; expect(bridge.poll(nodeId, armId)).toEqual({ action: "wait" }); }
    expect(bridge.live(nodeId)).toBe(false); // fresh polls don't renew the turn
    expect(bridge.dueForFallback()).toEqual([{ nodeId, outboxIds: ["m1"], reason: expect.stringMatching(/past the 15-minute bound/) }]);
  });

  it("treats a daemon restart's re-arm as an unknown turn, within the turn bound, however often it polls", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "rearm" });
    queue("after a restart", "m1");
    expect(bridge.poll(nodeId, armId)).toEqual({ action: "wait" });
    for (let t = 0; t < HOOK_BRIDGE_TURN_BOUND_MS; t += 5000) { now += 5000; bridge.poll(nodeId, armId); }
    expect(bridge.dueForFallback().map((d) => d.outboxIds)).toEqual([["m1"]]);
  });

  it("hands a batch whose answer was lost to the same arm again, never twice to two arms", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("one", "m1");
    const first = bridge.poll(nodeId, armId) as { batchId: string };
    const again = bridge.poll(nodeId, armId) as { batchId: string; messages: Array<{ outboxId: string }> };
    expect(again).toMatchObject({ action: "deliver", batchId: first.batchId });
    expect(again.messages.map((x) => x.outboxId)).toEqual(["m1"]);
  });

  it("marks a batch uncertain, never resent, when its own arm stops polling without an ack, and names it in the status", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("taken", "m1");
    bridge.poll(nodeId, armId);
    expect(bridge.reconcileUnacked()).toEqual([]);
    now += HOOK_BRIDGE_LIVE_BOUND_MS;
    expect(bridge.reconcileUnacked()).toEqual(["m1"]);
    expect(state("m1")).toBe("indeterminate");
    expect(events.at(-1)).toMatchObject({ type: "transport.hook_bridge_uncertain", outboxIds: ["m1"] });
    expect(bridge.status(nodeId, occupant).uncertain.outboxIds).toEqual(["m1"]);
    expect(bridge.queued(nodeId)).toEqual([]);
  });

  it("rechecks the opt-out, the row's occupant and the guard's hold at each poll, and hands what it can't deliver to typing at once", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    // Held now: the guard decides again, so the poll leaves it and the typed path (where the guard retains it) takes it.
    bridge.deposit(target(), session, "held now", { actorSession: "peer@team", admission: { source: "agent", urgent: false, override: false } }, ["h1"]);
    held = true;
    expect(bridge.poll(nodeId, armId)).toEqual({ action: "wait" });
    expect(bridge.dueForFallback()).toEqual([{ nodeId, outboxIds: ["h1"], reason: "the seat's typing guard holds it now" }]);
    held = false;
    bridge.releaseForTyping(nodeId, session, "h1", "test");
    // Queued for an earlier occupant: a new occupant's arm doesn't get it.
    bridge.deposit({ ...target(), occupant: "gen-0" }, session, "for the old occupant", { actorSession: "peer@team" }, ["o1"]);
    expect(bridge.poll(nodeId, armId)).toEqual({ action: "wait" });
    expect(bridge.dueForFallback()).toEqual([{ nodeId, outboxIds: ["o1"], reason: "it was queued for another occupant of the seat" }]);
    bridge.releaseForTyping(nodeId, session, "o1", "test");
    // Opted out after the deposit: the waiter stops and the message is typed.
    queue("before the opt-out", "x1");
    bridge.setPreference(nodeId, false, "human@team", "back to typed");
    expect(bridge.poll(nodeId, armId)).toEqual({ action: "stop" });
    expect(bridge.dueForFallback()).toEqual([{ nodeId, outboxIds: ["x1"], reason: "the seat opted out of its hook bridge" }]);
  });

  it("releases a row for typing only while it's still queued, and says whether it did", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("claimed first", "m1");
    bridge.poll(nodeId, armId);
    expect(bridge.releaseForTyping(nodeId, session, "m1", "test")).toBe(false);
    queue("still queued", "m2");
    now += 1;
    expect(bridge.releaseForTyping(nodeId, session, "m2", "test")).toBe(true);
    expect(state("m2")).toBe("pending");
  });

  it("adds the hooks only on a Claude with asyncRewake, and says why otherwise", () => {
    optIn();
    const old = new HookBridge(db, { now: () => now, version: () => "2.1.200" });
    expect(old.launchWanted(nodeId, "/opt/claude")).toBe(false);
    expect(old.status(nodeId, occupant).launch).toMatch(/2\.1\.200 is older than 2\.1\.287/);
    const unknown = new HookBridge(db, { now: () => now, version: () => null });
    expect(unknown.launchWanted(nodeId)).toBe(false);
    expect(unknown.status(nodeId, occupant).launch).toMatch(/version couldn't be read/);
    expect(bridge.launchWanted(nodeId)).toBe(true);
  });

  it("leaves a row only queued for the bridge out of the restart's indeterminate marking", () => {
    optIn();
    bridge.deposit(target(), session, "queued wake", { actorSession: "peer@team" }, ["wake-intent-q1"]);
    expect(new OutboxHandler(db).reconcileAbandonedSending("wake-intent-")).toBe(0);
    expect(state("wake-intent-q1")).toBe("sending");
    expect(bridge.queued(nodeId).map((r) => r.outboxId)).toEqual(["wake-intent-q1"]);
  });
});
