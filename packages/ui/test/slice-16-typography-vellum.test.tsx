// Slice 16 regression tests — typography + vellum enforcement.
//
// DESIGN.md §Typography contract:
//   font-body Inter → prose (qitem bodies, narratives, descriptions, notes,
//                            markdown body content)
//   font-mono JetBrains → metadata (IDs, queue state, timestamps, tags,
//                                   terminal/transcript, labels, chips)
//
// DESIGN.md §Vellum contract:
//   bg-white/25 – bg-white/40 + paper-grid backdrop visible.
//
// These source-scan tests fail at CI if a future contributor re-introduces
// the prose-as-mono pattern on the surfaces this slice fixed. Paths
// anchored via fileURLToPath(import.meta.url) so the test runs from any
// cwd (repo root, packages/ui, IDE test runner) per banked convention.

import { describe, it, expect } from "vitest";

async function readSource(packageRelPath: string): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const nodePath = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const testFile = fileURLToPath(import.meta.url);
  const packageRoot = nodePath.resolve(nodePath.dirname(testFile), "..");
  return readFileSync(nodePath.join(packageRoot, packageRelPath), "utf-8");
}

describe("slice 16: FeedCard typography + vellum density", () => {
  it("FeedCard vellum opacity is in DESIGN §Vellum range (bg-white/35; not bg-white/50)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // The card surface bg should be in the 25–40 range. Slice 16 set
    // it to bg-white/35.
    expect(source).toMatch(/className="mb-3 bg-white\/35 backdrop-blur-sm group"/);
    // Negate the prior too-bright shape.
    expect(source).not.toMatch(/className="mb-3 bg-white\/50/);
  });

  it("FeedCard qitem body paragraph uses font-body (not font-mono)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // The body `<p>` rendered when `body` is present is prose. The new
    // shape is `font-body text-xs leading-relaxed`; the prior shape
    // was `font-mono text-xs leading-relaxed`.
    expect(source).toMatch(/font-body text-xs leading-relaxed text-on-surface-variant whitespace-pre-line/);
    expect(source).not.toMatch(/font-mono text-xs leading-relaxed text-on-surface-variant whitespace-pre-line/);
  });

  it("FeedCard ActionOutcomePanel outcome sentence is prose font-body", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // outcomeSentence narrative is prose.
    expect(source).toMatch(/font-body text-\[12px\] leading-relaxed text-stone-800/);
    expect(source).not.toMatch(/font-mono text-\[11px\] leading-relaxed text-stone-800/);
  });

  it("FeedCard 'Your turn' hint copy is prose font-body", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toMatch(/font-body text-\[11px\] leading-relaxed text-rose-800/);
    expect(source).not.toMatch(/font-mono text-\[10px\] leading-relaxed text-rose-800/);
  });
});

describe("slice 16: Storytelling preview typography + vellum density", () => {
  it("Storytelling CardShell vellum opacity is in DESIGN §Vellum range", async () => {
    const source = await readSource("src/components/feed/cards/storytelling-cards.tsx");
    expect(source).toMatch(/bg-white\/35 hard-shadow/);
    expect(source).not.toMatch(/bg-white\/85 hard-shadow/);
  });

  it("Storytelling prose preview uses font-body while metadata labels stay font-mono", async () => {
    const source = await readSource("src/components/feed/cards/storytelling-cards.tsx");
    expect(source).toMatch(/font-body text-\[11px\] leading-relaxed text-stone-700 line-clamp-2/);
    expect(source).toMatch(/inline-block border px-2 py-0\.5 font-mono text-\[8px\] uppercase/);
    expect(source).toMatch(/whitespace-pre-wrap break-words bg-stone-50 p-2 font-body text-\[11px\] leading-relaxed/);
    expect(source).not.toMatch(/whitespace-pre-wrap break-words bg-stone-50 p-2 font-mono text-\[10px\] text-stone-800/);
  });
});

describe("slice 16: TimelineTab event body is prose font-body", () => {
  it("event body <pre> uses font-body (preserves whitespace via whitespace-pre-wrap, font is body)", async () => {
    const source = await readSource("src/components/slices/tabs/TimelineTab.tsx");
    expect(source).toMatch(
      /whitespace-pre-wrap break-words font-body text-\[12px\] leading-relaxed text-stone-950/,
    );
    expect(source).not.toMatch(
      /whitespace-pre-wrap break-words font-mono text-\[11px\] leading-relaxed text-stone-950/,
    );
  });

  it("empty-state container is prose font-body; embedded code-identifier spans stay font-mono", async () => {
    const source = await readSource("src/components/slices/tabs/TimelineTab.tsx");
    // Outer empty-state wrapper carries font-body (prose container)
    expect(source).toMatch(/bg-white\/35 p-4 font-body text-\[11px\] leading-relaxed/);
    // Inner `<span class="font-mono">` for the file path / frontmatter
    // tokens is preserved (those are code identifiers per DESIGN).
    expect(source).toMatch(/<span className="font-mono text-stone-900">&lt;slice-dir&gt;\/timeline\.md<\/span>/);
  });
});

describe("slice 16: ScopePages proof-packet markdown body is prose font-body", () => {
  it("primaryMarkdown.content rendering uses font-body", async () => {
    const source = await readSource("src/components/project/ScopePages.tsx");
    expect(source).toMatch(
      /mt-2 line-clamp-3 font-body text-\[11px\] leading-relaxed text-stone-700/,
    );
    expect(source).not.toMatch(
      /mt-2 line-clamp-3 font-mono text-\[10px\] leading-relaxed text-stone-700/,
    );
  });
});
