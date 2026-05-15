// Slice 16 typography + vellum density assertions for FeedCard.
//
// Updated 2026-05-14 for the FeedCard vellum-coherent refactor per
// for-you-feedcard-redesign-spec-2026-05-14.md. The chrome moved from
// VellumCard + bg-white/35 to the vellum recipe (bg-stone-100/45 +
// backdrop-blur-[10px] + ambient 3-stop box-shadow + 4 CornerBrackets)
// and prose body sizes bumped to 12px per the legibility north star.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const packageRoot = nodePath.resolve(here, "..");

async function readSource(packageRelPath: string): Promise<string> {
  return readFileSync(nodePath.join(packageRoot, packageRelPath), "utf-8");
}

describe("FeedCard typography + vellum-coherent chrome", () => {
  it("FeedCard outer chrome uses the vellum recipe (bg-stone-100/45 + backdrop-blur-[10px])", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // Card surface = vellum-coherent (matches CardShell in
    // storytelling-cards.tsx so /for-you reads as one surface).
    expect(source).toContain("bg-stone-100/45 backdrop-blur-[10px]");
    // The old VellumCard + left-stripe chrome is gone.
    expect(source).not.toMatch(/VellumCard/);
    expect(source).not.toMatch(/border-l-4 border-l-/);
    // Ambient 3-stop shadow defines the card edges through the vellum.
    expect(source).toContain("CARD_SHADOW_STYLE");
    expect(source).toContain("0 2px 4px rgba(0, 0, 0, 0.14)");
  });

  it("FeedCard imports CornerBracket from the dashboard/vellum barrel", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain('from "../dashboard/vellum/index.js"');
    expect(source).toContain("CornerBracket");
  });

  it("FeedCard title is 16px font-headline bold (legibility north star)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-headline text-[16px] font-bold leading-tight text-stone-900");
  });

  it("FeedCard qitem body paragraph is 12px font-body (prose; not font-mono; not 11px)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-stone-700 whitespace-pre-line");
    expect(source).not.toMatch(/font-mono text-xs leading-relaxed text-on-surface-variant whitespace-pre-line/);
  });

  it("FeedCard ActionOutcomePanel outcome sentence stays prose font-body 12px", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-stone-800");
  });

  it("FeedCard 'Your turn' hint copy is prose font-body 12px (bumped from 11px)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-stone-700");
  });

  it("FeedCard kind indicator uses mono+leading-dot (no colored pills)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // KIND_DOT map maps each FeedCardKind to a design-token dot color.
    expect(source).toContain("KIND_DOT");
    expect(source).toContain('"action-required": "bg-tertiary"');
    expect(source).toContain('approval: "bg-warning"');
    expect(source).toContain('shipped: "bg-success"');
    expect(source).toContain('progress: "bg-secondary"');
    // Old colored-pill chrome should be gone.
    expect(source).not.toMatch(/bg-emerald-50/);
    expect(source).not.toMatch(/bg-rose-50/);
    expect(source).not.toMatch(/bg-amber-50/);
    expect(source).not.toMatch(/text-emerald-800/);
    expect(source).not.toMatch(/text-rose-800/);
    expect(source).not.toMatch(/text-amber-800/);
  });
});
