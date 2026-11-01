import { describe, expect, it } from "vitest";
import { DEFAULT_FOLLOW_POLICY, planFollowingTiles, type FollowObservation, type FollowPolicy } from "../src/domain/terminal/terminal-follow-policy.js";

const members = ["a", "b", "c"].map(key => ({ key, seat: `${key}@team` }));
const empty = new Map<string, FollowObservation>(members.map(m => [m.key, { focused: false, input: "empty" }]));
const policy = (overrides: Partial<FollowPolicy> = {}): FollowPolicy => ({ ...DEFAULT_FOLLOW_POLICY, ...overrides });

describe("task-following presentation policy", () => {
  it("changes 3 -> 4 -> 3, retaining existing tile identities and explaining changes", () => {
    const initial = planFollowingTiles([], members, true, empty, policy(), 0);
    const fourth = { key: "d", seat: "d@team" };
    const joined = planFollowingTiles(initial.tiles, [...members, fourth], true, empty, policy(), 100);
    expect(joined.tiles.slice(0, 3)).toEqual(initial.tiles);
    expect(joined.joins).toEqual([{ ...fourth, reason: expect.stringContaining("open obligation") }]);
    const grace = planFollowingTiles(joined.tiles, members, true, empty, policy(), 200);
    expect(grace.tiles).toHaveLength(4);
    expect(grace.nextAt).toBe(4200);
    const left = planFollowingTiles(grace.tiles, members, true,
      new Map([...empty, ["d", { focused: false, input: "empty" }]]), policy(), 4200);
    expect(left.tiles).toEqual(initial.tiles);
    expect(left.leaves).toMatchObject([{ ...fourth, reason: expect.stringContaining("only its viewer") }]);
  });

  it("never turns an incomplete read into departures or joins", () => {
    for (const desired of [[], [{ key: "other", seat: "other@team" }]]) {
      const result = planFollowingTiles(members, desired, false, empty, policy(), 50000);
      expect(result).toMatchObject({ state: "retained", tiles: members, joins: [], leaves: [] });
    }
  });

  it("a complete empty task drains after grace while a focused reader gets finite retention", () => {
    const first = planFollowingTiles([members[0]!], [], true, empty, policy(), 100);
    const focused = new Map<string, FollowObservation>([["a", { focused: true, input: "empty" }]]);
    const held = planFollowingTiles(first.tiles, [], true, focused, policy(), 4100);
    expect(held.tiles).toHaveLength(1);
    expect(held.nextAt).toBe(16100);
    expect(planFollowingTiles(held.tiles, [], true, focused, policy(), 16100)).toMatchObject({ state: "empty", tiles: [] });
    expect(planFollowingTiles(held.tiles, [], true, empty, policy(), 4200)).toMatchObject({ state: "empty", tiles: [] });
  });

  it("pins and typed or unconfirmed input retain nonparticipants without inventing membership", () => {
    const first = planFollowingTiles(members, [], true, empty, policy(), 0);
    const input = new Map<string, FollowObservation>([["b", { focused: false, input: "text" }], ["c", { focused: false, input: "unknown" }]]);
    const result = planFollowingTiles(first.tiles, [], true, input, policy({ pins: ["a"] }), 100000);
    expect(result.tiles).toHaveLength(3);
    expect(result.retained.map(t => t.reason)).toEqual([
      expect.stringContaining("Pinned"), expect.stringContaining("typed draft"), expect.stringContaining("unconfirmed"),
    ]);
    expect(result.joins).toEqual([]);
    expect(result.nextAt).toBe(130000); // one delayed input check, never a recurring poll
    const checked = planFollowingTiles(result.tiles, [], true, input, policy({ pins: ["a"] }), 130000);
    expect(checked.nextAt).toBeUndefined();
  });

  it("suppression expires on a one-shot deadline; raising the explicit cap admits overflow", () => {
    const hidden = planFollowingTiles(members, members, true, empty, policy({ suppressed: { b: 15000 }, maxTiles: 1 }), 0);
    expect(hidden.tiles).toEqual([members[0]]);
    expect(hidden.nextAt).toBe(15000);
    expect(hidden.overflow.map(t => t.key)).toEqual(["c"]);
    const restored = planFollowingTiles(hidden.tiles, members, true, empty, policy({ suppressed: { b: 15000 }, maxTiles: 3 }), 15000);
    expect(restored.tiles).toEqual(members);
    expect(restored.joins.map(t => t.key)).toEqual(["b", "c"]);
  });
  it("departed unreadable input keeps its tile without taking the joining member's cap slot", () => {
    const unknown = new Map<string, FollowObservation>([["a", { focused: false, input: "unknown" }]]);
    const initial = planFollowingTiles([members[0]!], [members[1]!], true, unknown, policy({ maxTiles: 1, graceMs: 0 }), 0);
    expect(initial.tiles.map(t => t.key)).toEqual(["a", "b"]);
    expect(initial.joins.map(t => t.key)).toEqual(["b"]);
    expect(initial.overflow).toEqual([]); expect(initial.nextAt).toBe(30000);
    const once = planFollowingTiles(initial.tiles, [members[1]!], true, unknown, policy({ maxTiles: 1, graceMs: 0 }), 30000);
    expect(once.nextAt).toBeUndefined(); expect(once.tiles.map(t => t.key)).toEqual(["a", "b"]);
  });
});
