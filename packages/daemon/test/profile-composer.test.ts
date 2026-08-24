// OPR.0.5.3.5 Atom 3 — the composition algebra (locked SPEC, founder refinement):
//   FRESH           = the base walk (atoms tagged fresh)
//   HANDOVER        = FRESH + the handover material (atoms tagged handover)
//   POST-COMPACTION = a SUBSET of fresh (atoms tagged post-compaction) + the handover
//                     material, CLOSED over requires
// Every profile is closed over requires (a subset profile must close, intake rule);
// runtime filters per mini-req 3 (claude and codex compose DIFFERENT profiles, never
// assumed identical); pieces resolve through the Atom-1 address machinery and carry
// per-piece SOURCE LABELS (Q2-Amendment 1's binding multi-source contract); budgets
// are evaluated at compose and REPORT overage + priority-ordered drop candidates —
// composition never silently truncates (mini-req 9, D2: budgets flag, never govern).

import { describe, it, expect } from "vitest";
import type { ContextPackAtom } from "../src/domain/context-packs/context-pack-types.js";
import { composeProfile, ProfileComposeError } from "../src/domain/context-packs/profile-composer.js";

const FILES: Record<string, string> = {
  "ontology.md": [
    "## Identity",
    "who you are",
    "## Affordances",
    "what you can do",
    "### Verbs",
    "send and capture",
  ].join("\n"),
  "recap.md": ["## Recent Decisions", "we chose X because Y"].join("\n"),
  "walk.md": ["## Welcome", "hello"].join("\n"),
};

const readFile = (ref: string): string => {
  const text = FILES[ref];
  if (text === undefined) throw new Error(`no such file ${ref}`);
  return text;
};

function atom(over: Partial<ContextPackAtom> & { id: string; address: string }): ContextPackAtom {
  return {
    taxonomy: "world",
    situations: ["fresh"],
    purpose: "depth",
    runtime: "any",
    order: 0,
    priority: "core",
    ...over,
  } as ContextPackAtom;
}

const GRAPH: ContextPackAtom[] = [
  atom({ id: "welcome", address: "walk.md#welcome", order: 1, situations: ["fresh"] }),
  atom({ id: "identity", address: "ontology.md#identity", order: 2, situations: ["fresh"] }),
  atom({ id: "affordances", address: "ontology.md#affordances", order: 3, purpose: "width", situations: ["fresh", "post-compaction"], requires: ["identity"] }),
  atom({ id: "recap", address: "recap.md#recent-decisions", order: 9, taxonomy: "lore", situations: ["handover"] }),
];

describe("composeProfile — the situation algebra over ONE atom graph (mini-req 5)", () => {
  it("FRESH is the ordered base walk; HANDOVER is FRESH + the handover material", () => {
    const fresh = composeProfile({ atoms: GRAPH, situation: "fresh", runtime: "claude", readFile });
    expect(fresh.pieces.map((p) => p.atomId)).toEqual(["welcome", "identity", "affordances"]);
    const handover = composeProfile({ atoms: GRAPH, situation: "handover", runtime: "claude", readFile });
    expect(handover.pieces.map((p) => p.atomId)).toEqual(["welcome", "identity", "affordances", "recap"]);
  });

  it("POST-COMPACTION is the tagged subset + handover material, CLOSED over requires", () => {
    const pc = composeProfile({ atoms: GRAPH, situation: "post-compaction", runtime: "claude", readFile });
    // affordances is tagged; identity arrives ONLY via requires-closure; recap is
    // the handover material; welcome (fresh-only) is absent.
    expect(pc.pieces.map((p) => p.atomId)).toEqual(["identity", "affordances", "recap"]);
  });

  it("pieces carry the resolved SPAN and a source label (Q2-Amendment 1 contract)", () => {
    const pc = composeProfile({ atoms: GRAPH, situation: "post-compaction", runtime: "claude", readFile });
    const aff = pc.pieces.find((p) => p.atomId === "affordances")!;
    expect(aff.text).toContain("what you can do");
    expect(aff.text).toContain("### Verbs"); // full span: children included (Q1)
    expect(aff.sourceKind).toBe("library"); // default; seat/mission label via sourceKindFor
    const labelled = composeProfile({
      atoms: GRAPH, situation: "post-compaction", runtime: "claude", readFile,
      sourceKindFor: (a) => (a.taxonomy === "lore" ? "seat" : "library"),
    });
    expect(labelled.pieces.find((p) => p.atomId === "recap")!.sourceKind).toBe("seat");
  });
});

describe("composeProfile — runtime split (mini-req 3)", () => {
  it("claude and codex compose measurably different profiles from the same graph", () => {
    const graph = [
      ...GRAPH,
      atom({ id: "claude-only", address: "walk.md", order: 4, runtime: "claude", situations: ["fresh"] }),
      atom({ id: "codex-only", address: "walk.md", order: 5, runtime: "codex", situations: ["fresh"] }),
    ];
    const claude = composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile });
    const codex = composeProfile({ atoms: graph, situation: "fresh", runtime: "codex", readFile });
    expect(claude.pieces.map((p) => p.atomId)).toContain("claude-only");
    expect(claude.pieces.map((p) => p.atomId)).not.toContain("codex-only");
    expect(codex.pieces.map((p) => p.atomId)).toContain("codex-only");
    expect(codex.pieces.map((p) => p.atomId)).not.toContain("claude-only");
  });

  it("a requires-closure that crosses the runtime filter FAILS LOUD (never a thinned walk)", () => {
    const graph = [
      atom({ id: "base", address: "walk.md", order: 1, runtime: "codex", situations: ["fresh"] }),
      atom({ id: "top", address: "ontology.md#identity", order: 2, runtime: "any", situations: ["fresh"], requires: ["base"] }),
    ];
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(ProfileComposeError);
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(/base.*runtime|runtime.*base/);
  });
});

describe("composeProfile — fail-loud resolution (the Atom-1 contract carried through)", () => {
  it("a missing file stops the compose with the atom named", () => {
    const graph = [atom({ id: "ghosty", address: "ghost.md#nope", order: 1 })];
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(/ghosty/);
  });

  it("an address that matches nothing stops the compose (never thins the walk)", () => {
    const graph = [atom({ id: "misaddressed", address: "walk.md#not-there", order: 1 })];
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(/misaddressed|not-there/);
  });
});

describe("composeProfile — budget at compose (mini-req 9, D2)", () => {
  it("over budget: reports the overage and priority-ordered drop candidates, and NOTHING is truncated", () => {
    const graph = [
      atom({ id: "must", address: "ontology.md#identity", order: 1, priority: "core" }),
      atom({ id: "nice", address: "ontology.md#affordances", order: 2, priority: "recommended" }),
      atom({ id: "extra", address: "recap.md#recent-decisions", order: 3, priority: "optional", situations: ["fresh"] }),
    ];
    const composed = composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile, budgetTokens: 1 });
    expect(composed.pieces).toHaveLength(3); // never silently truncated
    expect(composed.budget).toBeDefined();
    expect(composed.budget!.limitTokens).toBe(1);
    expect(composed.budget!.overageTokens).toBeGreaterThan(0);
    // Drop candidates: optional first, then recommended, then core.
    expect(composed.budget!.dropCandidates.map((d) => d.atomId)).toEqual(["extra", "nice", "must"]);
  });

  it("within budget: no budget report", () => {
    const graph = [atom({ id: "small", address: "walk.md#welcome", order: 1 })];
    const composed = composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile, budgetTokens: 100000 });
    expect(composed.budget).toBeUndefined();
    expect(composed.totalEstimatedTokens).toBeGreaterThan(0);
  });
});
