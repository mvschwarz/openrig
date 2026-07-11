// release-0.4.7 intent-stage/scaffold-projection — T1 (helper unit vectors) +
// T6 (generic-triple durability sync).
//
// T1 derives its placeholder vectors FROM THE SHIPPED TEMPLATES (every
// proof-contract checkbox text and mini-reqs numbered item across
// scope-templates/*.md must classify placeholder) so template drift breaks
// these tests honestly instead of silently un-classifying a placeholder.
// T6 parses the shipped slice-progress.md and asserts the exported
// GENERIC_SCAFFOLD_ACCEPTANCE constant is in sync (kills silent
// template/constant drift — the plan's durability pin).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isScaffoldPlaceholderText,
  GENERIC_SCAFFOLD_ACCEPTANCE,
} from "../src/domain/scope/scaffold-placeholder.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TEMPLATES_DIR = path.join(REPO_ROOT, "packages/cli/src/lib/scope-templates");

/** Body of a `## <heading>` section up to the next `#`-heading (test-local,
 *  line-anchored — mirrors the production extractors' section shape). */
function sectionBody(content: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "mi");
  const m = re.exec(content);
  if (!m) return null;
  const rest = content.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,6}\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function checkboxTexts(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-?\s*\[(?:\s|x|X|~)\]\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

function numberedTexts(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

const SLICE_TEMPLATES_WITH_CONTRACT = [
  "placeholder.md",
  "implementation-prd.md",
  "bug-fix.md",
  "research.md",
  "release-feature.md",
  "backlog-deprecation.md",
  "backlog-tech-debt.md",
];

describe("T1 — isScaffoldPlaceholderText unit vectors", () => {
  it("every shipped template's proof-contract checkbox text classifies placeholder", () => {
    let vectors = 0;
    for (const file of SLICE_TEMPLATES_WITH_CONTRACT) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf8");
      const body = sectionBody(content, "Proof contract");
      expect(body, `${file} must have a ## Proof contract section`).not.toBeNull();
      for (const text of checkboxTexts(body!)) {
        expect(isScaffoldPlaceholderText(text), `${file}: ${text}`).toBe(true);
        vectors++;
      }
    }
    expect(vectors).toBeGreaterThanOrEqual(SLICE_TEMPLATES_WITH_CONTRACT.length);
  });

  it("every shipped template's mini-reqs numbered item classifies placeholder", () => {
    let vectors = 0;
    for (const file of ["placeholder.md", "implementation-prd.md"]) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf8");
      const body = sectionBody(content, "Mini-requirements");
      expect(body, `${file} must have a ## Mini-requirements section`).not.toBeNull();
      for (const text of numberedTexts(body!)) {
        expect(isScaffoldPlaceholderText(text), `${file}: ${text}`).toBe(true);
        vectors++;
      }
    }
    expect(vectors).toBeGreaterThanOrEqual(2);
  });

  it("real text is NOT a placeholder", () => {
    expect(isScaffoldPlaceholderText("phone journey video")).toBe(false);
    expect(isScaffoldPlaceholderText("Implementation complete")).toBe(false);
    expect(isScaffoldPlaceholderText("1080p capture of the drawer opening")).toBe(false);
  });

  it("bracket edge: ANY character outside the brackets makes it real", () => {
    expect(isScaffoldPlaceholderText("[P0] ship the drawer")).toBe(false);
    expect(isScaffoldPlaceholderText("a [placeholder-looking] middle")).toBe(false);
    expect(isScaffoldPlaceholderText("[almost].")).toBe(false);
    expect(isScaffoldPlaceholderText("x[wrapped]")).toBe(false);
  });

  it("trims before classifying; degenerate `[]` is a placeholder", () => {
    expect(isScaffoldPlaceholderText("  [padded placeholder]  ")).toBe(true);
    expect(isScaffoldPlaceholderText("[]")).toBe(true);
  });

  it("`[a] and [b]` classifies placeholder — arch-grammar-faithful (starts `[`, ends `]`); deliberately NOT special-cased", () => {
    // The grammar is `^\[.*\]$` verbatim (no private grammar). A real
    // deliverable written this way is written in template grammar — the
    // documented honest edge, pinned here so a future "fix" is a decision.
    expect(isScaffoldPlaceholderText("[a] and [b]")).toBe(true);
  });
});

describe("T6 — GENERIC_SCAFFOLD_ACCEPTANCE stays in sync with the shipped slice-progress.md", () => {
  it("the exported constant equals the template's Acceptance checkbox texts, in order", () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, "slice-progress.md"), "utf8");
    const body = sectionBody(content, "Acceptance");
    expect(body, "slice-progress.md must have an ## Acceptance section").not.toBeNull();
    expect(checkboxTexts(body!)).toEqual([...GENERIC_SCAFFOLD_ACCEPTANCE]);
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 placeholder-suppression completeness micro-bundle —
// T-B2 (isPlaceholderOnlyBlock unit vectors), T-A grammar
// (hasAuthoredNumberedItem unit vectors), T-C (prose/bullet-only suppression
// pin — asserts the arch-ruled, reviewer-L1 behavior).
// ---------------------------------------------------------------------------

import {
  hasAuthoredNumberedItem,
  isPlaceholderOnlyBlock,
} from "../src/domain/scope/scaffold-placeholder.js";

describe("T-B2 — isPlaceholderOnlyBlock (block-level 'nothing authored here')", () => {
  it("null/empty → false (absence is its own state; callers keep null handling)", () => {
    expect(isPlaceholderOnlyBlock(null)).toBe(false);
    expect(isPlaceholderOnlyBlock("")).toBe(false);
    expect(isPlaceholderOnlyBlock("   \n  \n")).toBe(false);
  });

  it("single fully-bracket-wrapped line → true (the shipped template Intent scaffold)", () => {
    expect(isPlaceholderOnlyBlock("[The recorded intent, verbatim — what was asked for and why.]")).toBe(true);
    expect(isPlaceholderOnlyBlock("\n  [padded placeholder]  \n")).toBe(true);
  });

  it("multi-line per-LINE case: `[a]\\n[b]` → true (the whole-string trim would miss this)", () => {
    expect(isPlaceholderOnlyBlock("[a]\n[b]")).toBe(true);
  });

  it("blank lines are ignored between placeholder lines", () => {
    expect(isPlaceholderOnlyBlock("[a]\n\n[b]\n")).toBe(true);
  });

  it("ANY authored line makes the block authored (mixed → false)", () => {
    expect(isPlaceholderOnlyBlock("[a]\nreal authored words")).toBe(false);
    expect(isPlaceholderOnlyBlock("The founder's exact words.")).toBe(false);
  });
});

describe("T-A grammar — hasAuthoredNumberedItem (the ONE authored-numbered-item grammar)", () => {
  it("dot-form and paren-form authored items both count (`1.` / `1)`)", () => {
    expect(hasAuthoredNumberedItem("1. Drawer opens from the right side.")).toBe(true);
    expect(hasAuthoredNumberedItem("1) Drawer opens from the right side.")).toBe(true);
  });

  it("placeholder-only numbered item → false (template `1. [...]` scaffold)", () => {
    expect(hasAuthoredNumberedItem("1. [The concise one-glance requirement tier.]")).toBe(false);
  });

  it("null → false", () => {
    expect(hasAuthoredNumberedItem(null)).toBe(false);
  });

  it("T-C: prose-only body → false (reviewer-L1 ruling — deliberately not-authored)", () => {
    expect(hasAuthoredNumberedItem("Some prose describing intent without structure.")).toBe(false);
  });

  it("T-C: bullet-only body → false (bullets are not the numbered requirement tier)", () => {
    expect(hasAuthoredNumberedItem("- bullet item one\n- bullet item two")).toBe(false);
  });

  it("T-C: mixed prose + one authored numbered item → true", () => {
    expect(hasAuthoredNumberedItem("Context prose first.\n\n1. One real observable outcome.")).toBe(true);
  });
});
