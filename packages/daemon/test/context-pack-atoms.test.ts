// OPR.0.5.3.5 mini-req 1 (Atom 2) — install atoms declare composition metadata.
// RED-first against the locked SPEC + the intake schema (DESIGN-INTAKE-ATOM-SCHEMA,
// dev-planner 2026-08-22): an ATOM is an ADDRESS plus metadata, never a new file —
// atoms live in the pack manifest (the one metadata home per profile-library), each
// referencing a declared pack file (optionally #header-path via the Atom-1 grammar)
// and carrying: taxonomy (founder vocabulary), regions (world anatomy), situations
// (the composition algebra's selector), purpose depth|width, runtime claude|codex|any
// (mini-req 3), order, requires, priority (what drops first when a budget binds,
// mini-req 9), probe (mini-req 2: changed behavior, one-harness shape). Token counts
// are DERIVED at compose, never stored (the intake's volatility rule) — the schema
// deliberately has no token field.

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";

const BASE = `
name: world-install
version: "1"
files:
  - { path: 04-ontology.md, role: world }
  - { path: what-you-can-do.md, role: world }
  - { path: probes.yaml, role: probes }
`;

function withAtoms(atomsYaml: string): string {
  return `${BASE}atoms:\n${atomsYaml}`;
}

const GOOD_ATOM = `
  - id: ontology-width
    address: "04-ontology.md#affordances"
    taxonomy: world
    regions: [affordances, terrain]
    situations: [fresh, post-compaction]
    purpose: width
    runtime: claude
    order: 10
    priority: core
    probe:
      prompt: "A seat asks what verbs exist for reaching a peer."
      expect: "Names rig send/capture without re-reading the install."
`;

describe("context-pack atoms — parse + round-trip (mini-req 1)", () => {
  it("a manifest without atoms still parses (atoms are optional)", () => {
    const m = parseManifest(BASE, "m.yaml");
    expect(m.atoms).toBeUndefined();
  });

  it("a valid atom round-trips every schema field", () => {
    const m = parseManifest(withAtoms(GOOD_ATOM), "m.yaml");
    expect(m.atoms).toHaveLength(1);
    const a = m.atoms![0]!;
    expect(a).toMatchObject({
      id: "ontology-width",
      address: "04-ontology.md#affordances",
      taxonomy: "world",
      regions: ["affordances", "terrain"],
      situations: ["fresh", "post-compaction"],
      purpose: "width",
      runtime: "claude",
      order: 10,
      priority: "core",
    });
    expect(a.probe).toEqual({
      prompt: "A seat asks what verbs exist for reaching a peer.",
      expect: "Names rig send/capture without re-reading the install.",
    });
  });

  it("defaults: runtime 'any'; regions/requires/probe optional", () => {
    const m = parseManifest(withAtoms(`
  - id: minimal
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 20
    priority: recommended
`), "m.yaml");
    const a = m.atoms![0]!;
    expect(a.runtime).toBe("any");
    expect(a.regions).toBeUndefined();
    expect(a.requires).toBeUndefined();
    expect(a.probe).toBeUndefined();
  });

  it("a whole-file atom (no #) may reference any declared file; header addressing needs markdown", () => {
    const whole = parseManifest(withAtoms(`
  - id: probes-file
    address: probes.yaml
    taxonomy: skills
    situations: [fresh]
    purpose: depth
    order: 30
    priority: optional
`), "m.yaml");
    expect(whole.atoms![0]!.address).toBe("probes.yaml");
    expect(() => parseManifest(withAtoms(`
  - id: bad
    address: "probes.yaml#some-header"
    taxonomy: skills
    situations: [fresh]
    purpose: depth
    order: 31
    priority: optional
`), "m.yaml")).toThrow(/header|markdown/i);
  });
});

describe("context-pack atoms — fail-loud validation", () => {
  const stub = (over: string) => withAtoms(`
  - id: a1
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
${over}`);

  it("rejects a duplicate atom id", () => {
    expect(() => parseManifest(stub(`
  - id: a1
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
`), "m.yaml")).toThrow(/duplicate.*a1/i);
  });

  it("rejects a requires ref to an undeclared atom, and a self-requires", () => {
    expect(() => parseManifest(stub(`
  - id: a2
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
    requires: [ghost]
`), "m.yaml")).toThrow(/ghost/);
    expect(() => parseManifest(withAtoms(`
  - id: selfy
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
    requires: [selfy]
`), "m.yaml")).toThrow(/itself|self/i);
  });

  it("rejects a requires CYCLE — a subset profile could never close over it", () => {
    expect(() => parseManifest(withAtoms(`
  - id: a
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
    requires: [b]
  - id: b
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
    requires: [a]
`), "m.yaml")).toThrow(/cycle/i);
  });

  it("rejects an address whose ref is not a declared pack file", () => {
    expect(() => parseManifest(withAtoms(`
  - id: stray
    address: "not-in-pack.md#x"
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
`), "m.yaml")).toThrow(/not-in-pack\.md/);
  });

  it("rejects a malformed address via the one grammar (fail-loud, Atom-1 rules)", () => {
    expect(() => parseManifest(withAtoms(`
  - id: bad
    address: "04-ontology.md#a#b"
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
`), "m.yaml")).toThrow(/#/);
  });

  it("r1 F1: a DEEP requires chain stays inside the fail-loud channel — no RangeError escape at any depth", () => {
    // r1's measured discriminator: the recursive visit() blew the call stack at
    // n=5000 with a RangeError carrying no atoms[i], no id, no path — bypassing
    // the channel the module's own header promises. Packs install FROM URLS
    // (slice-07 R4), so depth is attacker-choosable and no threshold is safe.
    const N = 8000;
    const entries: string[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(
        `  - id: a${i}\n    address: 04-ontology.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    order: ${i}\n    priority: core${i < N - 1 ? `\n    requires: [a${i + 1}]` : ""}`,
      );
    }
    const m = parseManifest(withAtoms(entries.join("\n")), "m.yaml");
    expect(m.atoms).toHaveLength(N); // parses clean — the chain is legal, just deep
    // And a cycle at the same depth still rejects through the RIGHT channel.
    const cyclic = entries.join("\n") + `\n  - id: z\n    address: 04-ontology.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    order: ${N}\n    priority: core\n    requires: [z2]\n  - id: z2\n    address: 04-ontology.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    order: ${N + 1}\n    priority: core\n    requires: [z]`;
    expect(() => parseManifest(withAtoms(cyclic), "m.yaml")).toThrow(/cycle/i);
  });

  it("r1 F2: an UNKNOWN key on an atom entry rejects loud — a typo must never silently drop metadata", () => {
    // r1's measured discriminator: `require:` (typo for requires) parsed clean
    // with the dependency edge silently gone — the exact failure the field
    // exists to prevent, arriving with no error. Ingest knows the legal key set.
    expect(() => parseManifest(stub(`
  - id: a2
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
    require: [a1]
`), "m.yaml")).toThrow(/unknown field 'require'/);
    expect(() => parseManifest(withAtoms(`
  - id: x
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
    probes: { prompt: p, expect: e }
`), "m.yaml")).toThrow(/unknown field 'probes'/);
  });

  it("rejects bad enums and shapes: taxonomy, empty situations, purpose, runtime, order, priority, half a probe", () => {
    const cases: Array<[string, RegExp]> = [
      ["taxonomy: cosmos", /taxonomy/],
      ["situations: []", /situations/],
      ["purpose: girth", /purpose/],
      ["runtime: gemini", /runtime/],
      ["order: 1.5", /order/],
      ["priority: urgent", /priority/],
      ["probe: { prompt: only-half }", /probe/],
    ];
    for (const [line, want] of cases) {
      const good: Record<string, string> = {
        taxonomy: "taxonomy: world",
        situations: "situations: [fresh]",
        purpose: "purpose: depth",
        runtime: "",
        order: "order: 1",
        priority: "priority: core",
        probe: "",
      };
      const key = line.split(":")[0]!;
      good[key] = line;
      const yaml = withAtoms(`
  - id: x
    address: 04-ontology.md
    ${good["taxonomy"]}
    ${good["situations"]}
    ${good["purpose"]}
    ${good["runtime"]}
    ${good["order"]}
    ${good["priority"]}
    ${good["probe"]}
`);
      expect(() => parseManifest(yaml, "m.yaml"), `case: ${line}`).toThrow(want);
    }
  });
});
