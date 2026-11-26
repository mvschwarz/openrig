import { describe, expect, it } from "vitest";
import {
  buildStoryForest,
  formatStoryDate,
  type StoryQitemInput,
} from "../src/lib/story-graph-model.js";

// OPR.0.4.1.19 — the qitems -> forest-of-DAGs reconstruction is the load-bearing
// core of the Story tab. Edges are REAL lineage (chain_of_record tail / handedOffFrom),
// NOT inferred. Single-parent forest => true acyclic git-history DAG. Visual fan-in is a
// rendering affordance, never a 2-parent data node (founder guardrail 1).

function qitem(partial: Partial<StoryQitemInput> & { qitemId: string }): StoryQitemInput {
  return {
    tsCreated: "2026-06-23T02:00:00.000Z",
    tsUpdated: "2026-06-23T02:00:00.000Z",
    sourceSession: "dev1-planner@openrig-delivery",
    destinationSession: "dev1-driver@openrig-delivery",
    state: "done",
    closureReason: null,
    tags: [],
    body: "agent-speak body line one\nmore detail",
    summary: null,
    chainOfRecord: null,
    handedOffFrom: null,
    handedOffTo: null,
    ...partial,
  };
}

describe("buildStoryForest", () => {
  it("returns an empty forest for no items", () => {
    const forest = buildStoryForest([]);
    expect(forest.nodes).toEqual([]);
    expect(forest.roots).toEqual([]);
    expect(forest.laneCount).toBe(0);
  });

  it("treats a null/empty-chain qitem as a root on lane 0", () => {
    const forest = buildStoryForest([qitem({ qitemId: "A", chainOfRecord: null })]);
    expect(forest.roots).toEqual(["A"]);
    const a = forest.nodes.find((n) => n.qitemId === "A")!;
    expect(a.isRoot).toBe(true);
    expect(a.parentId).toBeNull();
    expect(a.lane).toBe(0);
  });

  it("resolves the direct parent from the chain_of_record tail", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "A", chainOfRecord: null, tsCreated: "2026-06-23T02:00:00.000Z" }),
      qitem({ qitemId: "B", chainOfRecord: ["A"], tsCreated: "2026-06-23T02:05:00.000Z" }),
      qitem({ qitemId: "C", chainOfRecord: ["A", "B"], tsCreated: "2026-06-23T02:10:00.000Z" }),
    ]);
    const byId = new Map(forest.nodes.map((n) => [n.qitemId, n]));
    expect(byId.get("B")!.parentId).toBe("A");
    expect(byId.get("C")!.parentId).toBe("B"); // tail of chain, not the root
    expect(byId.get("A")!.childIds).toContain("B");
    expect(byId.get("B")!.childIds).toContain("C");
    expect(forest.roots).toEqual(["A"]);
    // a linear handoff chain stays on one lane (no fan-out)
    expect(byId.get("A")!.lane).toBe(byId.get("C")!.lane);
  });

  it("prefers handedOffFrom when chain_of_record is absent", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "A", chainOfRecord: null }),
      qitem({ qitemId: "B", chainOfRecord: null, handedOffFrom: "A" }),
    ]);
    expect(forest.nodes.find((n) => n.qitemId === "B")!.parentId).toBe("A");
    expect(forest.roots).toEqual(["A"]);
  });

  it("assigns distinct lanes on fan-out (one parent, two children)", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "A", chainOfRecord: null, tsCreated: "2026-06-23T02:00:00.000Z" }),
      qitem({ qitemId: "B", chainOfRecord: ["A"], tsCreated: "2026-06-23T02:05:00.000Z" }),
      qitem({ qitemId: "C", chainOfRecord: ["A"], tsCreated: "2026-06-23T02:06:00.000Z" }),
    ]);
    const byId = new Map(forest.nodes.map((n) => [n.qitemId, n]));
    expect(byId.get("A")!.childIds.sort()).toEqual(["B", "C"]);
    expect(byId.get("B")!.lane).not.toBe(byId.get("C")!.lane);
    expect(forest.laneCount).toBeGreaterThanOrEqual(2);
  });

  it("tolerates a non-resolving chain entry (fallback sentinel) without crashing -> treated as a root", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "B", chainOfRecord: ["fallback-from:dev1-driver@openrig-delivery"] }),
      qitem({ qitemId: "C", chainOfRecord: ["does-not-exist"] }),
    ]);
    const byId = new Map(forest.nodes.map((n) => [n.qitemId, n]));
    expect(byId.get("B")!.parentId).toBeNull();
    expect(byId.get("C")!.parentId).toBeNull();
    expect(forest.roots.sort()).toEqual(["B", "C"]);
  });

  it("produces a forest with multiple roots (mission spine + human-origin branch)", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "spine", chainOfRecord: null, sourceSession: "orch-advisor@openrig-delivery" }),
      qitem({
        qitemId: "human",
        chainOfRecord: null,
        sourceSession: "founder",
        tags: ["human-origin"],
      }),
    ]);
    expect(forest.roots.sort()).toEqual(["human", "spine"]);
    const human = forest.nodes.find((n) => n.qitemId === "human")!;
    expect(human.isHumanOrigin).toBe(true);
    expect(human.lane).not.toBe(forest.nodes.find((n) => n.qitemId === "spine")!.lane);
  });

  it("degrades summary to the first body line when no summary field is present", () => {
    const withSummary = buildStoryForest([qitem({ qitemId: "A", summary: "Merged the harness." })]);
    expect(withSummary.nodes[0].summary).toBe("Merged the harness.");
    const noSummary = buildStoryForest([
      qitem({ qitemId: "A", summary: null, body: "first body line\nsecond line" }),
    ]);
    expect(noSummary.nodes[0].summary).toBe("first body line");
  });

  it("orders nodes most-recent-first (top of the upward-growing graph)", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "old", chainOfRecord: null, tsCreated: "2026-06-23T01:00:00.000Z" }),
      qitem({ qitemId: "new", chainOfRecord: ["old"], tsCreated: "2026-06-23T05:00:00.000Z" }),
    ]);
    expect(forest.nodes[0].qitemId).toBe("new");
    expect(forest.nodes[forest.nodes.length - 1].qitemId).toBe("old");
  });
});

describe("formatStoryDate (date-not-time bug fix)", () => {
  it("shows month + day + time, never a relative 'Today'/'Yesterday' label", () => {
    // A same-day timestamp is exactly the case the old formatter hid behind
    // "Today HH:MM". The fix must surface the calendar date even for today.
    const now = new Date().toISOString();
    const formatted = formatStoryDate(now);
    expect(formatted).not.toMatch(/today|yesterday/i);
    // Calendar fields in the host locale, including numeric month names.
    for (const part of new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).formatToParts(new Date(now))) {
      if (part.type === "month" || part.type === "day") expect(formatted).toContain(part.value);
    }
    expect(formatted).toMatch(/\d{1,2}:\d{2}/);
  });

  it("renders a known instant with its calendar date", () => {
    // Midday UTC keeps the calendar day stable across local timezones.
    const formatted = formatStoryDate("2026-06-23T12:00:00.000Z");
    for (const part of new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).formatToParts(new Date("2026-06-23T12:00:00.000Z"))) {
      if (part.type === "month" || part.type === "day") expect(formatted).toContain(part.value);
    }
    expect(formatted).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns 'unknown' for nullish and echoes an unparseable value", () => {
    expect(formatStoryDate(null)).toBe("unknown");
    expect(formatStoryDate(undefined)).toBe("unknown");
    expect(formatStoryDate("not-a-date")).toBe("not-a-date");
  });
});

describe("OPR.0.4.1.18 — Story node summary prefers the authored summary, degrades on null", () => {
  it("uses the authored summary to label the node; full body stays inspectable", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "A", summary: "Wire the version row to the daemon.", body: "agent-speak body line one\nmore detail" }),
    ]);
    const a = forest.nodes.find((n) => n.qitemId === "A")!;
    expect(a.summary).toBe("Wire the version row to the daemon.");
    // body is unchanged + inspectable (the source of truth for the drawer).
    expect(a.body).toBe("agent-speak body line one\nmore detail");
  });

  it("degrades to the first body line when summary is null (pre-18 qitem)", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "A", summary: null, body: "first meaningful line\nsecond line" }),
    ]);
    const a = forest.nodes.find((n) => n.qitemId === "A")!;
    expect(a.summary).toBe("first meaningful line");
  });

  it("a handoff child does NOT inherit the parent's summary (deriveSummary is per-item)", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "P", summary: "Parent summary.", body: "parent body", chainOfRecord: null }),
      qitem({
        qitemId: "C",
        summary: null,
        body: "child body line",
        chainOfRecord: ["P"],
        handedOffFrom: "P",
        tsCreated: "2026-06-23T02:05:00.000Z",
      }),
    ]);
    const c = forest.nodes.find((n) => n.qitemId === "C")!;
    expect(c.summary).toBe("child body line"); // its OWN body line, not the parent's summary
    expect(c.summary).not.toBe("Parent summary.");
  });
});
