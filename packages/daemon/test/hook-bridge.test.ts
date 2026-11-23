// Slice 13: an opted-in Claude seat's hook bridge, without a real Claude. The preference and its attribution, which
// occupant it routes, the waiter's arm/poll/ack in send order, holding during a turn, the live bound and its typed
// fallback, expiry, and a claimed batch whose waiter vanished. The launch hooks and the waiter script have their own
// tests (kernel-authority, claude-hook-bridge-script); the transport's branch has session-transport-hook-bridge.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let rigId: string;
  let held = false;
  const session = "dev-impl@team";
  const occupant = "gen-1";
  const target = () => ({ nodeId, session, occupant, pane: "%1" });

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const repo = new RigRepository(db);
    rigId = repo.createRig("team").id;
    nodeId = repo.addNode(rigId, "dev.impl", { runtime: "claude-code" }).id;
    now = Date.parse("2026-11-14T18:00:00Z");
    events = [];
    bridge = new HookBridge(db, { now: () => now, emit: (e) => events.push(e), version: () => "2.1.322", holds: () => held });
    held = false;
  });
  afterEach(() => db.close());

  const optIn = () => bridge.setPreference(nodeId, true, "human@team", "wake at turn boundaries");
  const queue = (text: string, id: string) => bridge.deposit(target(), session, text, { actorSession: "peer@team" }, [id]);
  const state = (id: string) => new OutboxHandler(db).getById(id)?.deliveryState;

  it("records who opted a seat in and why, and routes only an occupant whose own waiter armed", async () => {
    expect(() => bridge.setPreference(nodeId, true, "human@team", " ")).toThrow(/reason is required/);
    // A person's terminal with no seat identity can opt in; the change is recorded as unattributed.
    expect(bridge.setPreference(nodeId, false, null, "from a plain terminal").actor).toBe(UNATTRIBUTED_ACTOR);
    expect(await bridge.launchWanted(nodeId)).toBe(false);
    optIn();
    expect(await bridge.launchWanted(nodeId)).toBe(true);
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
    const acked = bridge.ack(nodeId, session, occupant, armId, (polled as { batchId: string }).batchId);
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
    // The typed send that released it owns it now: still sending, no longer the bridge's.
    expect(state("m1")).toBe("sending");
    expect(bridge.queued(nodeId)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "transport.hook_bridge_fallback", outboxIds: ["m1"] });
  });

  it("waits on its own wake's turn up to the turn bound, then types", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("first", "m1");
    const polled = bridge.poll(nodeId, armId) as { batchId: string };
    bridge.ack(nodeId, session, occupant, armId, polled.batchId);
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

  it("marks a claimed batch indeterminate, never resent by the bridge, when its waiter is gone without an ack", () => {
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

  // #3270 round 9: Claude Code fires UserPromptSubmit for the input its own wake delivered (2.1.322, R3270-prompt).
  it("keeps the turn a wake started as that turn when Claude reports the woken input's prompt, so messages wait for its end", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("the wake", "m1");
    const polled = bridge.poll(nodeId, armId) as { batchId: string };
    bridge.ack(nodeId, session, occupant, armId, polled.batchId);
    bridge.turnStarted(nodeId); // the woken input's own UserPromptSubmit
    expect(bridge.status(nodeId, occupant)).toMatchObject({ turn: { state: "woken" } });
    expect(bridge.live(nodeId)).toBe(true);
    queue("during the woken turn", "m2");
    now += HOOK_BRIDGE_LIVE_BOUND_MS * 2;
    expect(bridge.dueForFallback()).toEqual([]); // held for the turn's end, not typed
    // Only that one prompt is the wake's: another before a boundary is a person's turn, as before.
    bridge.turnStarted(nodeId);
    expect(bridge.status(nodeId, occupant)).toMatchObject({ turn: { state: "user" } });
    // The turn's Stop re-arms, and the held message is handed over.
    const next = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    const delivered = bridge.poll(nodeId, next.armId);
    expect(delivered.action === "deliver" && delivered.messages.map((m) => m.outboxId)).toEqual(["m2"]);
    // A boundary ends the allowance: the next prompt after an arm is a person's turn.
    bridge.turnStarted(nodeId);
    expect(bridge.status(nodeId, occupant)).toMatchObject({ turn: { state: "user" } });
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

  it("marks a batch uncertain, never resent by the bridge, when its own arm stops polling without an ack, and names it in the status", () => {
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
    expect(state("m2")).toBe("sending");
  });

  it("adds the hooks only on a Claude with asyncRewake, and says why otherwise", async () => {
    optIn();
    const old = new HookBridge(db, { now: () => now, version: () => "2.1.200" });
    expect(await old.launchWanted(nodeId, "/opt/claude")).toBe(false);
    expect(old.status(nodeId, occupant).launch).toMatch(/2\.1\.200 is older than 2\.1\.287/);
    const unknown = new HookBridge(db, { now: () => now, version: () => null });
    expect(await unknown.launchWanted(nodeId)).toBe(false);
    expect(unknown.status(nodeId, occupant).launch).toMatch(/version couldn't be read/);
    expect(await bridge.launchWanted(nodeId)).toBe(true);
  });

  it("leaves a row only queued for the bridge out of the restart's indeterminate marking", () => {
    optIn();
    bridge.deposit(target(), session, "queued wake", { actorSession: "peer@team" }, ["wake-intent-q1"]);
    expect(new OutboxHandler(db).reconcileAbandonedSending("wake-intent-")).toBe(0);
    expect(state("wake-intent-q1")).toBe("sending");
    expect(bridge.queued(nodeId).map((r) => r.outboxId)).toEqual(["wake-intent-q1"]);
  });
  // #3270 round 2.
  it("names a wake its waiter had claimed uncertain after a restart, in the status and an event, and never resends it (R2-F2)", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    bridge.deposit(target(), session, "claimed wake", { actorSession: "peer@team" }, ["wake-intent-c1"]);
    bridge.poll(nodeId, armId);
    // The restart: startup's reconcile of abandoned claims, then a bridge with no arms.
    expect(new OutboxHandler(db).reconcileAbandonedSending("wake-intent-")).toBe(0);
    const after = new HookBridge(db, { now: () => now, emit: (e) => events.push(e) });
    expect(after.reconcileUnacked()).toEqual(["wake-intent-c1"]);
    expect(state("wake-intent-c1")).toBe("indeterminate");
    expect(after.status(nodeId, occupant).uncertain.outboxIds).toEqual(["wake-intent-c1"]);
    expect(events.at(-1)).toMatchObject({ type: "transport.hook_bridge_uncertain", outboxIds: ["wake-intent-c1"] });
  });

  it("reconciles every abandoned send at a restart whatever its receipt, with no bridge in use, and leaves only the bridge's own rows to it (R2-F1)", () => {
    const outbox = new OutboxHandler(db);
    const add = (id: string, receipt: string | null) => {
      outbox.record({ outboxId: id, senderSession: "peer@team", destinationSession: session, body: id });
      db.prepare("UPDATE outbox_entries SET delivery_state = 'sending', guard_delivery = ? WHERE outbox_id = ?").run(receipt, id);
    };
    add("wake-intent-none", null);
    add("wake-intent-ordinary", JSON.stringify({ expectedIdentity: { nodeId, sessionName: session, runtime: "claude-code", nativeId: "n1" } }));
    add("wake-intent-garbled", "not json");
    add("wake-intent-queued", JSON.stringify({ channel: "hook-bridge", state: "queued" }));
    add("wake-intent-claimed", JSON.stringify({ channel: "hook-bridge", state: "claimed", armId: "a", batchId: "b" }));
    expect(outbox.reconcileAbandonedSending("wake-intent-")).toBe(3);
    expect(["none", "ordinary", "garbled", "queued", "claimed"].map((k) => state(`wake-intent-${k}`)))
      .toEqual(["indeterminate", "indeterminate", "indeterminate", "sending", "sending"]);
  });

  it("scopes a claimed batch's retry and ack to the waiter's own seat and occupant, even when two seats name the same arm (R2-F4)", () => {
    optIn();
    const otherId = new RigRepository(db).addNode(rigId, "dev.other", { runtime: "claude-code" }).id;
    bridge.setPreference(otherId, true, "human@team", "on");
    bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop", armId: "arm-shared" });
    queue("for the first seat", "a1");
    const first = bridge.poll(nodeId, "arm-shared") as { batchId: string }; // this answer is lost
    bridge.arm({ nodeId: otherId, sessionName: "dev-other@team", generation: "gen-b", hookEvent: "Stop", armId: "arm-shared" });
    expect(bridge.poll(otherId, "arm-shared")).toEqual({ action: "wait" });
    expect(bridge.ack(otherId, "dev-other@team", "gen-b", "arm-shared", first.batchId).outboxIds).toEqual([]);
    expect(state("a1")).toBe("sending");
    // The first seat's own retry and ack still work.
    expect(bridge.poll(nodeId, "arm-shared")).toMatchObject({ action: "deliver", batchId: first.batchId });
    expect(bridge.ack(nodeId, session, occupant, "arm-shared", first.batchId).outboxIds).toEqual(["a1"]);
    expect(state("a1")).toBe("delivered");
  });

  it("doesn't hand a claimed batch out again once the guard holds it: it stays uncertain, never requeued (R2-F4)", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    bridge.deposit(target(), session, "taken, then held", { actorSession: "peer@team", admission: { source: "agent", urgent: false } }, ["h1"]);
    expect(bridge.poll(nodeId, armId)).toMatchObject({ action: "deliver" }); // this answer is lost
    held = true; // an operator's hold since the claim
    expect(bridge.poll(nodeId, armId)).toEqual({ action: "wait" });
    expect(state("h1")).toBe("indeterminate");
    expect(bridge.queued(nodeId)).toEqual([]);
    expect(bridge.status(nodeId, occupant).uncertain.outboxIds).toEqual(["h1"]);
    expect(events.at(-1)).toMatchObject({ type: "transport.hook_bridge_uncertain", outboxIds: ["h1"] });
  });

  it("never queues a row again once it was delivered (N3)", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("once", "m1");
    const polled = bridge.poll(nodeId, armId) as { batchId: string };
    bridge.ack(nodeId, session, occupant, armId, polled.batchId);
    queue("once", "m1");
    expect(state("m1")).toBe("delivered");
    expect(bridge.queued(nodeId)).toEqual([]);
  });

  it("reads Claude's version without blocking, once per executable until the executable changes (N6)", async () => {
    optIn();
    let probes = 0, version = "2.1.322", stamp = "first";
    const probing = new HookBridge(db, { now: () => now, version: async () => { probes++; return version; }, stamp: () => stamp });
    expect(await probing.launchWanted(nodeId, "/opt/claude")).toBe(true);
    expect(await probing.launchWanted(nodeId, "/opt/claude")).toBe(true);
    expect(probes).toBe(1);
    stamp = "replaced"; version = "2.1.200"; // a downgrade under a running daemon
    expect(await probing.launchWanted(nodeId, "/opt/claude")).toBe(false);
    expect(probes).toBe(2);
  });
  // #3270 round 3.
  it("queues nothing, and says so, for an id that's already settled; a new id queues as before (R3-F3)", () => {
    optIn();
    const { armId } = bridge.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    queue("once", "m1");
    const polled = bridge.poll(nodeId, armId) as { batchId: string };
    bridge.ack(nodeId, session, occupant, armId, polled.batchId);
    expect(queue("once again", "m1")).toBeNull();
    expect(state("m1")).toBe("delivered");
    expect(queue("new", "m2")).toMatchObject({ outcome: "bridged", outboxIds: ["m2"] });
  });

  it("names what it didn't deliver in the seat's status, with the reason (R4)", () => {
    optIn();
    bridge.deposit({ ...target(), occupant: "gen-0" }, session, "for the occupant who left", { actorSession: "peer@team" }, ["o1"]);
    expect(bridge.abandon(nodeId, session, "o1", "it was queued for an earlier occupant of the seat, which is gone")).toBe(true);
    expect(bridge.status(nodeId, occupant).notDelivered).toEqual({ outboxIds: ["o1"], reasons: { o1: "it was queued for an earlier occupant of the seat, which is gone" },
      note: expect.stringMatching(/not typed into the seat's current occupant.*sender isn't told/) });
    expect(bridge.status(nodeId, occupant).uncertain.note).toMatch(/[Tt]he bridge never resends them; a queue wake's own recovery may, saying delivery may repeat/);
  });

  it("reads an unreadable Claude version again at the next launch (optional)", async () => {
    optIn();
    let version: string | null = null;
    const probing = new HookBridge(db, { now: () => now, version: async () => version, stamp: () => "same" });
    expect(await probing.launchWanted(nodeId, "/opt/claude")).toBe(false);
    version = "2.1.322";
    expect(await probing.launchWanted(nodeId, "/opt/claude")).toBe(true);
  });
  // #3270 round 6, F1: the drain read fails open, as the drain's own admission does.
  it("delivers when the rig's drain can't be read, and says so (F1)", () => {
    optIn();
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
    const unread = new HookBridge(db, { now: () => now, drained: () => { throw new Error("drain table unreadable"); } });
    const { armId } = unread.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    unread.deposit(target(), session, "queued wake", { actorSession: "peer@team", queueWake: true }, ["w1"]);
    expect(unread.poll(nodeId, armId)).toMatchObject({ action: "deliver" });
    expect(JSON.stringify(errors)).toMatch(/delivery drain.*couldn't be read/);
    spy.mockRestore();
  });
  it("holds only automatic deliveries in a drain: an explicit queue notification and a direct send pass it (F1)", () => {
    optIn();
    const drained = new HookBridge(db, { now: () => now, drained: () => true });
    const { armId } = drained.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    drained.deposit(target(), session, "explicit resolve notice", { actorSession: "peer@team", queueWake: true, drainExempt: true }, ["e1"]);
    drained.deposit(target(), session, "direct send", { actorSession: "peer@team" }, ["d1"]);
    expect((drained.poll(nodeId, armId) as { messages: Array<{ outboxId: string }> }).messages.map((m) => m.outboxId)).toEqual(["e1", "d1"]);
    const { armId: next } = drained.arm({ nodeId, sessionName: session, generation: occupant, hookEvent: "Stop" });
    drained.deposit(target(), session, "automatic wake", { actorSession: "peer@team", queueWake: true }, ["w1"]);
    expect(drained.poll(nodeId, next)).toEqual({ action: "wait" });
  });
});
