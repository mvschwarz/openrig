// 0.3.1 slice 06 — pure-logic tests for the storytelling-primitives
// foundation: kind extraction, fenced-block parsing, kind dispatch
// table. React rendering tests live alongside in storytelling-*.test.tsx.

import { describe, it, expect } from "vitest";
import {
  extractKind,
  KNOWN_KINDS,
  parseTimelineBlock,
  parseStatsBlock,
  parseRiskTableBlock,
  parseCompareBlock,
  parseSlateBlock,
  type KindName,
} from "../src/components/markdown/storytelling-primitives.js";

describe("extractKind", () => {
  it("returns null when frontmatter is null", () => {
    expect(extractKind(null)).toBeNull();
  });

  it("returns null when frontmatter has no kind field", () => {
    expect(extractKind({ title: "hello" })).toBeNull();
  });

  it("returns the kind name when frontmatter declares a known kind", () => {
    expect(extractKind({ kind: "incident-timeline" })).toBe("incident-timeline");
    expect(extractKind({ kind: "progress" })).toBe("progress");
    expect(extractKind({ kind: "feature-shipped" })).toBe("feature-shipped");
  });

  it("returns null for an unknown kind value (so the renderer falls back to plain markdown)", () => {
    expect(extractKind({ kind: "not-a-real-kind" })).toBeNull();
  });

  it("covers all 7 declared kinds from the IMPL-PRD §3", () => {
    expect(KNOWN_KINDS).toEqual([
      "incident-timeline",
      "progress",
      "feature-shipped",
      "implementation-plan",
      "concept-explainer",
      "pr-writeup",
      "post-mortem",
    ] satisfies KindName[]);
  });
});

describe("parseTimelineBlock", () => {
  it("parses a list of entries with time/status/title/body", () => {
    const body = `- time: "2026-05-09 14:02"
  status: success
  title: Plugin primitive design landed
  body: DESIGN.md authored at substrate
- time: "2026-05-09 16:30"
  status: warning
  title: Hooks pivot
  body: Decision to rip hooks scaffolding`;
    const result = parseTimelineBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.status).toBe("success");
      expect(result.entries[0]!.title).toBe("Plugin primitive design landed");
      expect(result.entries[1]!.status).toBe("warning");
    }
  });

  it("returns ok:false on unparseable YAML so the caller can fall back to a plain code block", () => {
    const body = `- time: 2026-05-09
  status: [broken`;
    const result = parseTimelineBlock(body);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when the body is not a YAML list (kind mismatch)", () => {
    const body = `title: not-a-list-of-entries`;
    const result = parseTimelineBlock(body);
    expect(result.ok).toBe(false);
  });

  it("normalizes an unknown status string to 'info' (graceful)", () => {
    const body = `- time: "now"
  status: bogus
  title: x
  body: y`;
    const result = parseTimelineBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries[0]!.status).toBe("info");
  });
});

describe("parseStatsBlock", () => {
  it("parses a list of label/value/trend entries", () => {
    const body = `- label: Slices in 0.3.1
  value: 10
  trend: up
- label: Driver seats
  value: 3`;
    const result = parseStatsBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.label).toBe("Slices in 0.3.1");
      expect(result.entries[0]!.value).toBe("10");
      expect(result.entries[0]!.trend).toBe("up");
      // trend omitted on second entry → undefined
      expect(result.entries[1]!.trend).toBeUndefined();
    }
  });

  it("coerces numeric values into strings for display", () => {
    const body = `- label: x
  value: 42`;
    const result = parseStatsBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries[0]!.value).toBe("42");
  });

  it("returns ok:false on unparseable input", () => {
    const result = parseStatsBlock("[broken");
    expect(result.ok).toBe(false);
  });
});

describe("parseRiskTableBlock", () => {
  it("parses risk/probability/impact/mitigation entries", () => {
    const body = `- risk: Hooks may not fire reliably
  probability: low
  impact: high
  mitigation: Phase 3b dogfood
- risk: Convention complexity grows
  probability: med
  impact: med
  mitigation: Curated set at v0`;
    const result = parseRiskTableBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.probability).toBe("low");
      expect(result.entries[0]!.impact).toBe("high");
    }
  });

  it("normalizes invalid probability/impact values to 'med'", () => {
    const body = `- risk: x
  probability: extreme
  impact: bogus
  mitigation: y`;
    const result = parseRiskTableBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries[0]!.probability).toBe("med");
      expect(result.entries[0]!.impact).toBe("med");
    }
  });
});

describe("parseCompareBlock", () => {
  it("parses columns + rows with values aligned to columns", () => {
    const body = `columns: [Old approach, New approach]
rows:
  - label: Editability
    values: [Easy with HTML editor, Easy with any text editor]
  - label: Diffability
    values: [Hard, Trivial]`;
    const result = parseCompareBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["Old approach", "New approach"]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]!.label).toBe("Editability");
      expect(result.rows[0]!.values).toEqual(["Easy with HTML editor", "Easy with any text editor"]);
    }
  });

  it("returns ok:false when columns array is missing", () => {
    const body = `rows: []`;
    const result = parseCompareBlock(body);
    expect(result.ok).toBe(false);
  });
});

describe("parseSlateBlock", () => {
  it("returns the raw body as a slate string (no YAML structure needed)", () => {
    const body = "TL;DR text. Three sentences. Renders as dark vellum slab.";
    const result = parseSlateBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe(body);
  });

  it("trims surrounding whitespace", () => {
    const body = "  TL;DR.  \n\n";
    const result = parseSlateBlock(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("TL;DR.");
  });

  it("returns ok:false when the body is empty (caller falls back to code block)", () => {
    const result = parseSlateBlock("   \n  ");
    expect(result.ok).toBe(false);
  });
});
