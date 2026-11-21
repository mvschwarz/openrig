import { describe, it, expect, beforeEach } from "vitest";
import {
  planSeatPool,
  seatPoolAboveMax,
  seatPoolCanReceive,
  seatPoolRoom,
  type SeatPoolAgentFacts,
  type SeatPoolIntent,
  type SeatPoolPendingRow,
  type SeatPoolPlanSpec,
  type SeatPoolPlanState,
} from "../src/domain/policies/seat-pool.js";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const MODEL = "dev-impl@r";

function spec(overrides: Partial<SeatPoolPlanSpec> = {}): SeatPoolPlanSpec {
  return {
    max: 3, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, drain: false,
    ...overrides,
  };
}

let nextSlot = 1;
/** A free agent: live, running, idle at its prompt for 10 minutes, nothing open or held. */
function agent(overrides: Partial<SeatPoolAgentFacts> = {}): SeatPoolAgentFacts {
  const slotNumber = overrides.slotNumber ?? nextSlot++;
  return {
    slotNumber, sessionName: `dev-impl-s${slotNumber}@r`, phase: "live", attemptState: "settled", running: true,
    idleAtPrompt: true, idleSince: ago(600), openRows: 0, heldCount: 0, ...overrides,
  };
}
/** An agent being added: `reserved` (no call yet) or `issued` (the call is out), with no node yet. */
const starting = (attemptState: "reserved" | "issued", overrides: Partial<SeatPoolAgentFacts> = {}) =>
  agent({ phase: "adding", attemptState, sessionName: null, running: false, idleAtPrompt: false, idleSince: null, ...overrides });

let nextRow = 1;
/** Pending rows to `destination` (the model by default), waiting for `ageSeconds`: past the default dispatch_after_s. */
function rows(count: number, destination = MODEL, ageSeconds = 120, tags: string[] = []): SeatPoolPendingRow[] {
  return Array.from({ length: count }, () => ({ qitemId: `q-${nextRow++}`, destination, waitingSince: ago(ageSeconds), tags }));
}

function state(overrides: Partial<SeatPoolPlanState> = {}): SeatPoolPlanState {
  return { modelSession: MODEL, agents: [], pending: [], lastStepAt: null, ...overrides };
}

const plan = (s: SeatPoolPlanSpec, st: SeatPoolPlanState) => planSeatPool(s, st, NOW);
const ofKind = <K extends SeatPoolIntent["kind"]>(intents: SeatPoolIntent[], kind: K) =>
  intents.filter((intent): intent is Extract<SeatPoolIntent, { kind: K }> => intent.kind === kind);

beforeEach(() => {
  nextSlot = 1;
  nextRow = 1;
});

describe("seat-pool planner: dispatch", () => {
  it("moves rows waiting past dispatch_after_s to free agents oldest first, ignoring priority, and counts the rest as demand", () => {
    const free = agent();
    // A newer row with a higher priority still waits behind the older one: the planner reads no priority.
    const urgent = rows(1, MODEL, 300).map((row) => ({ ...row, priority: "urgent" }));
    const newest = rows(1, MODEL, 120);
    const fresh = rows(1, MODEL, 30); // not waiting yet: still the model's to take
    // Created last, so its id sorts last: it moves first by age alone.
    const older = rows(1, MODEL, 900);
    const result = plan(spec({ max: 9 }), state({ agents: [free], pending: [...newest, ...fresh, ...urgent, ...older] }));
    expect(result.intents).toEqual<SeatPoolIntent[]>([
      { kind: "dispatch", qitemId: older[0]!.qitemId, from: MODEL, slotNumber: free.slotNumber },
      { kind: "add", count: 2 },
    ]);
    expect(result.counts.unplaced).toBe(2);
    // The agent that receives the row counts as occupied: target = R (2) + O (1).
    expect(result.target).toBe(3);
  });

  it("gives a row only to an agent that is live, running, idle at its prompt, with no open row and no held message", () => {
    const notFree = [
      starting("issued"),
      agent({ phase: "draining" }),
      agent({ phase: "drained" }),
      agent({ running: false }),
      agent({ idleAtPrompt: false, idleSince: null }),
      agent({ openRows: 1 }),
      agent({ heldCount: 1 }),
    ];
    const blocked = plan(spec({ max: 9 }), state({ agents: notFree, pending: rows(1) }));
    expect(ofKind(blocked.intents, "dispatch")).toEqual([]);
    for (const facts of notFree) expect(seatPoolCanReceive(spec({ max: 9 }), notFree, facts)).toBe(false);

    const free = agent();
    const all = [...notFree, free];
    const given = plan(spec({ max: 9 }), state({ agents: all, pending: rows(1) }));
    expect(ofKind(given.intents, "dispatch").map((intent) => intent.slotNumber)).toEqual([free.slotNumber]);
    expect(seatPoolCanReceive(spec({ max: 9 }), all, free)).toBe(true);
  });

  it("with dispatch_tag, moves and counts only the model's rows carrying the tag, while a row to a drained agent moves whatever its tag", () => {
    const drained = agent({ phase: "drained", running: false, idleAtPrompt: false, idleSince: null });
    const free = [agent(), agent()];
    const tagged = rows(1, MODEL, 900, ["role:impl"]);
    const reply = rows(1, MODEL, 900, ["review"]);
    const untagged = rows(2, MODEL, 900);
    const toDrained = rows(1, drained.sessionName!, 600, ["review"]);
    // Carrying the tag and the oldest of all, but addressed to a live agent, not the model: it stays with that agent.
    const busy = agent({ openRows: 1, idleAtPrompt: false, idleSince: null });
    const toBusy = rows(1, busy.sessionName!, 1200, ["role:impl"]);
    const result = plan(
      spec({ dispatchTag: "role:impl", max: 9 }),
      state({ agents: [drained, busy, ...free], pending: [...toBusy, ...tagged, ...reply, ...untagged, ...toDrained] }),
    );
    expect(ofKind(result.intents, "dispatch")).toEqual([
      { kind: "dispatch", qitemId: tagged[0]!.qitemId, from: MODEL, slotNumber: free[0]!.slotNumber },
      { kind: "dispatch", qitemId: toDrained[0]!.qitemId, from: drained.sessionName, slotNumber: free[1]!.slotNumber },
    ]);
    // The reply and the untagged rows stay with the model, and the tagged row to the busy agent stays with it: none of
    // them is demand, so nothing is added for them.
    expect(result.counts.unplaced).toBe(0);
    expect(ofKind(result.intents, "add")).toEqual([]);
  });

  it("moves a pending row addressed to a drained agent, and not one addressed to an agent in adding, live or draining", () => {
    const drained = agent({ phase: "drained", running: false, idleAtPrompt: false, idleSince: null });
    const adding = starting("issued", { sessionName: "dev-impl-s9@r" });
    const busy = agent({ openRows: 1, idleAtPrompt: false, idleSince: null });
    const draining = agent({ phase: "draining" });
    const free = agent();
    const toDrained = rows(1, drained.sessionName!);
    const stay = [...rows(1, adding.sessionName!), ...rows(1, busy.sessionName!), ...rows(1, draining.sessionName!)];
    const result = plan(spec({ max: 9 }), state({ agents: [drained, adding, busy, draining, free], pending: [...stay, ...toDrained] }));
    expect(ofKind(result.intents, "dispatch")).toEqual([
      { kind: "dispatch", qitemId: toDrained[0]!.qitemId, from: drained.sessionName, slotNumber: free.slotNumber },
    ]);
    // The rows that stay count only through their agent's occupancy, never as unplaced rows.
    expect(result.counts.unplaced).toBe(0);
  });

  it("under drain: true moves and wakes nothing", () => {
    const free = agent();
    const drained = agent({ phase: "drained", running: false, idleAtPrompt: false, idleSince: null });
    const result = plan(
      spec({ drain: true }),
      state({ agents: [free, drained], pending: [...rows(2), ...rows(1, drained.sessionName!)] }),
    );
    expect(ofKind(result.intents, "dispatch")).toEqual([]);
    expect(result.intents.every((intent) => intent.kind === "drain" || intent.kind === "cancel")).toBe(true);
    expect(seatPoolCanReceive(spec({ drain: true }), [free], free)).toBe(false);
  });

  it("after max is lowered above 0, an agent above max, counted newest first, receives no new rows", () => {
    const [s1, s2, s3] = [agent(), agent(), agent()];
    const all = [s1!, s2!, s3!];
    const result = plan(spec({ max: 1 }), state({ agents: all, pending: rows(3) }));
    expect(ofKind(result.intents, "dispatch").map((intent) => intent.slotNumber)).toEqual([s1!.slotNumber]);
    expect([...seatPoolAboveMax(spec({ max: 1 }), all)].sort()).toEqual([s2!.slotNumber, s3!.slotNumber].sort());
    expect(seatPoolCanReceive(spec({ max: 1 }), all, s1!)).toBe(true);
    expect(seatPoolCanReceive(spec({ max: 1 }), all, s3!)).toBe(false);
    // A starting slot below a free agent takes its place under max, so the higher free agent is the one above max.
    nextSlot = 1;
    const low = agent();
    const adding = starting("issued");
    const high = agent();
    const mixed = plan(spec({ max: 2 }), state({ agents: [low, adding, high], pending: rows(2) }));
    expect(ofKind(mixed.intents, "dispatch").map((intent) => intent.slotNumber)).toEqual([low.slotNumber]);
    expect([...seatPoolAboveMax(spec({ max: 2 }), [low, adding, high])]).toEqual([high.slotNumber]);
    // A drained slot takes no place under max.
    nextSlot = 1;
    const drained = agent({ phase: "drained", running: false, idleAtPrompt: false, idleSince: null });
    const [d2, d3] = [agent(), agent()];
    expect([...seatPoolAboveMax(spec({ max: 1 }), [drained, d2!, d3!])]).toEqual([d3!.slotNumber]);
    const afterDrained = plan(spec({ max: 1 }), state({ agents: [drained, d2!, d3!], pending: rows(1) }));
    expect(ofKind(afterDrained.intents, "dispatch").map((intent) => intent.slotNumber)).toEqual([d2!.slotNumber]);
  });
});

describe("seat-pool planner: sizing", () => {
  it("with rows waiting past dispatch_after_s for the model and no free agent, adds one agent per row, up to max", () => {
    expect(plan(spec(), state({ pending: rows(2) })).intents).toEqual([{ kind: "add", count: 2 }]);
    expect(plan(spec(), state({ pending: rows(9) })).intents).toEqual([{ kind: "add", count: 3 }]);
    const busy = agent({ openRows: 1 });
    expect(plan(spec(), state({ agents: [busy], pending: rows(9) })).intents).toEqual([{ kind: "add", count: 2 }]);
    // A row younger than dispatch_after_s is still the model's to take: it is not demand.
    expect(plan(spec(), state({ pending: rows(2, MODEL, 30) })).intents).toEqual([]);
    expect(plan(spec({ dispatchAfterSeconds: 10 }), state({ pending: rows(2, MODEL, 30) })).intents)
      .toEqual([{ kind: "add", count: 2 }]);
    // A drained slot takes no room: with one busy agent and one drained slot under max 2, one agent is added.
    const drained = agent({ phase: "drained", running: false, idleAtPrompt: false, idleSince: null });
    const reuse = plan(spec({ max: 2 }), state({ agents: [busy, drained], pending: rows(3) }));
    expect(reuse.room).toBe(1);
    expect(seatPoolRoom(spec({ max: 2 }), [busy, drained])).toBe(1);
    expect(reuse.intents).toEqual([{ kind: "add", count: 1 }]);
    // A draining agent is not in current but still takes room: with no room left, nothing is added and the plan says why.
    const full = plan(spec({ max: 2 }), state({ agents: [busy, agent({ phase: "draining" })], pending: rows(3) }));
    expect(full.target).toBe(2);
    expect(full.current).toBe(1);
    expect(full.room).toBe(0);
    expect(full.intents).toEqual([]);
    expect(full.reason).toBe("max_reached");
  });

  it("a pool full at max with every live agent occupied and rows waiting reports max_reached, with the same target and no add", () => {
    const busy = () => agent({ openRows: 1, idleAtPrompt: false, idleSince: null });
    const full = plan(spec({ max: 2 }), state({ agents: [busy(), busy()], pending: rows(3) }));
    expect(full.reason).toBe("max_reached");
    expect(full.intents).toEqual([]);
    expect(full.target).toBe(2);
    expect(full.current).toBe(2);
    // The unclamped demand R (3) + O (2) is kept apart from the clamped target.
    expect(full.counts).toMatchObject({ occupied: 2, unplaced: 3, wanted: 5 });
    // With room under max, the same facts still scale up as before.
    nextSlot = 1;
    const roomy = plan(spec({ max: 5 }), state({ agents: [busy(), busy()], pending: rows(3) }));
    expect(roomy.reason).toBe("scale_up");
    expect(roomy.intents).toEqual([{ kind: "add", count: 3 }]);
    expect(roomy.target).toBe(5);
    expect(roomy.counts.wanted).toBe(5);
    // Full at max with no row waiting stays steady, and under drain: true the reason stays draining.
    nextSlot = 1;
    expect(plan(spec({ max: 2 }), state({ agents: [busy(), busy()] })).reason).toBe("steady");
    nextSlot = 1;
    expect(plan(spec({ max: 2, drain: true }), state({ agents: [busy(), busy()], pending: rows(3) })).reason).toBe("draining");
  });

  it("two free agents at max take two of three waiting rows, and the same plan reports max_reached for the row left waiting", () => {
    const [s1, s2] = [agent(), agent()];
    const result = plan(spec({ max: 2 }), state({ agents: [s1!, s2!], pending: rows(3) }));
    expect(ofKind(result.intents, "dispatch").map((intent) => intent.slotNumber)).toEqual([s1!.slotNumber, s2!.slotNumber]);
    expect(ofKind(result.intents, "add")).toEqual([]);
    expect(result.reason).toBe("max_reached");
    expect(result.counts).toMatchObject({ occupied: 2, unplaced: 1, wanted: 3 });
    expect(result.target).toBe(2);
    // Inside the cooldown the moves and the reason are the same: a move is not a step.
    const cooling = plan(spec({ max: 2 }), state({ agents: [s1!, s2!], pending: rows(3), lastStepAt: ago(10) }));
    expect(ofKind(cooling.intents, "dispatch")).toHaveLength(2);
    expect(cooling.reason).toBe("max_reached");
    // With max lowered below current, the reason stays scale_down though rows wait.
    nextSlot = 1;
    const busy = [1, 2, 3].map(() => agent({ openRows: 1, idleAtPrompt: false, idleSince: null }));
    expect(plan(spec({ max: 2 }), state({ agents: busy, pending: rows(3) })).reason).toBe("scale_down");
  });

  it("an agent with only a held message gives the same target as one with an open row, with no unread term and no +1", () => {
    const withRow = plan(spec({ max: 9 }), state({ agents: [agent({ openRows: 1 })], pending: rows(2) }));
    const withHeld = plan(spec({ max: 9 }), state({ agents: [agent({ heldCount: 1 })], pending: rows(2) }));
    expect(withHeld.target).toBe(withRow.target);
    expect(withHeld.intents).toEqual(withRow.intents);
    // R (2) + O (1), nothing more.
    expect(withHeld.target).toBe(3);
    expect(withHeld.intents).toEqual([{ kind: "add", count: 2 }]);
    // Held work counts once and is never drained.
    const alone = plan(spec(), state({ agents: [agent({ heldCount: 3 })] }));
    expect(alone.target).toBe(1);
    expect(alone.intents).toEqual([]);
  });

  it("the posted example: max 4, one busy, one held, one starting, three rows and no free agent add 1", () => {
    const busy = agent({ openRows: 1, idleAtPrompt: false, idleSince: null });
    const held = agent({ heldCount: 1 });
    const result = plan(spec({ max: 4 }), state({ agents: [busy, held, starting("issued")], pending: rows(3) }));
    expect(result.counts).toMatchObject({ occupied: 2, starting: 1, unplaced: 3 });
    expect(result.target).toBe(4);
    expect(result.current).toBe(3);
    expect(result.intents).toEqual([{ kind: "add", count: 1 }]);
  });

  it("with no demand, keeps the target at min and adds up to it, within max", () => {
    const result = plan(spec({ max: 3, min: 2 }), state());
    expect(result.target).toBe(2);
    expect(result.intents).toEqual([{ kind: "add", count: 2 }]);
    // Agents at min are kept: no surplus, nothing drained.
    const kept = plan(spec({ max: 3, min: 2 }), state({ agents: [agent(), agent()] }));
    expect(kept.surplus).toBe(0);
    expect(kept.intents).toEqual([]);
  });

  it("an issued starting slot counts in current and room, is never cancelled or drained by sizing, never lets the target fall below O + S, and stops a second add for the same rows", () => {
    const issued = starting("issued");
    // Counted in current and in room.
    const quiet = plan(spec({ max: 3 }), state({ agents: [issued] }));
    expect(quiet.current).toBe(1);
    expect(quiet.room).toBe(2);
    expect(seatPoolRoom(spec({ max: 3 }), [issued])).toBe(2);
    // No demand at all: the floor O + S keeps the target at 1, and nothing is cancelled or drained.
    expect(quiet.target).toBe(1);
    expect(quiet.intents).toEqual([]);
    // With one agent occupied and one add still reserved, the floor O + S is 2: the target stays at 2 and the reserved
    // add is not cancelled, though no row waits.
    const busy = agent({ openRows: 1, idleAtPrompt: false, idleSince: null });
    const floor = plan(spec({ max: 3 }), state({ agents: [busy, starting("reserved")] }));
    expect(floor.counts).toMatchObject({ occupied: 1, starting: 1, unplaced: 0 });
    expect(floor.target).toBe(2);
    expect(floor.surplus).toBe(0);
    expect(ofKind(floor.intents, "cancel")).toEqual([]);
    // The row it was added for is still waiting: no second add for it.
    const same = plan(spec({ max: 3 }), state({ agents: [issued], pending: rows(1) }));
    expect(same.target).toBe(1);
    expect(ofKind(same.intents, "add")).toEqual([]);
    // Even with max lowered to 0 and drain set, sizing leaves the issued attempt alone.
    for (const lowered of [spec({ max: 0 }), spec({ drain: true })]) {
      const result = plan(lowered, state({ agents: [issued] }));
      expect(result.surplus).toBe(0);
      expect(result.intents).toEqual([]);
    }
  });

  it("surplus drains only free agents idle past idle_grace_s, newest first", () => {
    const busy = agent({ openRows: 1 });
    const older = agent();
    const newer = agent();
    const recent = agent({ idleSince: ago(10) });
    const result = plan(spec({ max: 9 }), state({ agents: [busy, older, newer, recent] }));
    // target = O (1); current = 4; surplus 3, but only two agents are free and past the grace.
    expect(result.surplus).toBe(3);
    expect(result.intents).toEqual<SeatPoolIntent[]>([
      { kind: "drain", slotNumber: newer.slotNumber, idleSince: newer.idleSince! },
      { kind: "drain", slotNumber: older.slotNumber, idleSince: older.idleSince! },
    ]);
    // Newest first even inside the grace: with surplus 1, an older agent past the grace is not drained in place of the
    // newer one, which drains once its own grace has passed.
    nextSlot = 1;
    const kept = agent();
    const settled = agent({ idleSince: ago(10) });
    const waiting = plan(spec({ max: 1, min: 1 }), state({ agents: [kept, settled] }));
    expect(waiting.surplus).toBe(1);
    expect(waiting.intents).toEqual([]);
    const later = plan(spec({ max: 1, min: 1 }), state({ agents: [kept, { ...settled, idleSince: ago(300) }] }));
    expect(later.intents).toEqual([{ kind: "drain", slotNumber: settled.slotNumber, idleSince: ago(300) }]);
  });

  it("add and drain steps wait for cooldown_s, except under drain: true, and the plan never cancels an issued add", () => {
    const issued = starting("issued");
    const free = [agent(), agent()];
    // Inside the cooldown: no add for the waiting rows.
    const adding = plan(spec(), state({ pending: rows(2), lastStepAt: ago(10) }));
    expect(adding.intents).toEqual([]);
    expect(adding.reason).toBe("cooldown");
    expect(plan(spec(), state({ pending: rows(2), lastStepAt: ago(61) })).intents).toEqual([{ kind: "add", count: 2 }]);
    // Inside the cooldown: no drain of a surplus free agent.
    const draining = plan(spec(), state({ agents: [...free, issued], lastStepAt: ago(10) }));
    expect(draining.intents).toEqual([]);
    expect(draining.reason).toBe("cooldown");
    // Under drain: true the cooldown does not apply.
    const kill = plan(spec({ drain: true }), state({ agents: [...free, issued], lastStepAt: ago(10) }));
    expect(ofKind(kill.intents, "drain").map((intent) => intent.slotNumber)).toEqual([free[1]!.slotNumber, free[0]!.slotNumber]);
    // A move is not a step: a waiting row still moves to a free agent inside the cooldown.
    const free3 = agent();
    const moving = plan(spec(), state({ agents: [free3], pending: rows(1), lastStepAt: ago(10) }));
    expect(ofKind(moving.intents, "dispatch").map((intent) => intent.slotNumber)).toEqual([free3.slotNumber]);
    // In none of these is the issued add cancelled.
    for (const result of [adding, draining, kill]) {
      expect(ofKind(result.intents, "cancel")).toEqual([]);
    }
  });

  it("drain: true sets the target to 0, ignores the cooldown, and drains each agent only once it is free, without touching claimed work", () => {
    const busy = agent({ openRows: 2, idleAtPrompt: false, idleSince: null });
    const held = agent({ heldCount: 1 });
    const free = agent();
    const recent = agent({ idleSince: ago(10) });
    const reserved = starting("reserved");
    const issued = starting("issued");
    const result = plan(
      spec({ drain: true, min: 2 }),
      state({ agents: [busy, held, free, recent, reserved, issued], pending: rows(4), lastStepAt: ago(1) }),
    );
    expect(result.target).toBe(0);
    expect(result.reason).toBe("draining");
    // The reserved add is cancelled and the free agent past the grace drains, inside the cooldown. The busy and held
    // agents, the issued add and the rows are left alone.
    expect(result.intents).toEqual<SeatPoolIntent[]>([
      { kind: "cancel", slotNumber: reserved.slotNumber },
      { kind: "drain", slotNumber: free.slotNumber, idleSince: free.idleSince! },
    ]);
    // Once the busy agent is free and past the grace, it drains too.
    const later = plan(spec({ drain: true }), state({ agents: [{ ...busy, openRows: 0, idleAtPrompt: true, idleSince: ago(600) }] }));
    expect(later.intents).toEqual([{ kind: "drain", slotNumber: busy.slotNumber, idleSince: ago(600) }]);
  });

  it("a max: 0 spec moves no row and drains free agents after idle_grace_s", () => {
    const free = agent();
    const recent = agent({ idleSince: ago(10) });
    const drained = agent({ phase: "drained", running: false, idleAtPrompt: false, idleSince: null });
    const result = plan(
      spec({ max: 0 }),
      state({ agents: [free, recent, drained], pending: [...rows(3), ...rows(1, drained.sessionName!)] }),
    );
    expect(result.target).toBe(0);
    expect(result.intents).toEqual<SeatPoolIntent[]>([
      { kind: "drain", slotNumber: free.slotNumber, idleSince: free.idleSince! },
    ]);
    // The agent inside the grace drains once it has been idle for idle_grace_s.
    const later = plan(spec({ max: 0 }), state({ agents: [{ ...recent, idleSince: ago(300) }] }));
    expect(later.intents).toEqual([{ kind: "drain", slotNumber: recent.slotNumber, idleSince: ago(300) }]);
    // Unlike drain: true, max: 0 keeps the cooldown.
    const cooling = plan(spec({ max: 0 }), state({ agents: [free], lastStepAt: ago(10) }));
    expect(cooling.intents).toEqual([]);
    expect(cooling.reason).toBe("cooldown");
    expect(plan(spec({ max: 0 }), state({ agents: [free], lastStepAt: ago(61) })).intents)
      .toEqual([{ kind: "drain", slotNumber: free.slotNumber, idleSince: free.idleSince! }]);
  });

  it("with surplus under a lowered max, reserved adds are cancelled newest first before any free agent is drained, and an issued add is never cancelled or drained by sizing", () => {
    const [s1, s2] = [agent(), agent()];
    const s3 = starting("reserved");
    const s4 = starting("reserved");
    const s5 = starting("issued");
    const all = [s1!, s2!, s3, s4, s5];
    const result = plan(spec({ max: 1 }), state({ agents: all }));
    // L 2, S 3, I 1, target 1 (the floor O + S is capped by max): surplus 5 - 1 - 1 = 3.
    expect(result.surplus).toBe(3);
    expect(result.intents).toEqual<SeatPoolIntent[]>([
      { kind: "cancel", slotNumber: s4.slotNumber },
      { kind: "cancel", slotNumber: s3.slotNumber },
      { kind: "drain", slotNumber: s2!.slotNumber, idleSince: s2!.idleSince! },
    ]);
    // A smaller surplus is taken by the reserved adds alone: no free agent is drained.
    const one = plan(spec({ max: 2 }), state({ agents: [s1!, s3, s4, s5] }));
    expect(one.surplus).toBe(1);
    expect(one.intents).toEqual<SeatPoolIntent[]>([{ kind: "cancel", slotNumber: s4.slotNumber }]);
    // Cancelling a reserved add is not a step: it does not wait for the cooldown, while the drain does.
    const cooling = plan(spec({ max: 1 }), state({ agents: all, lastStepAt: ago(10) }));
    expect(cooling.intents).toEqual<SeatPoolIntent[]>([
      { kind: "cancel", slotNumber: s4.slotNumber },
      { kind: "cancel", slotNumber: s3.slotNumber },
    ]);
  });
});
