// Slice 16 typography assertions for FeedCard.
//
// Updated 2026-05-14 for the FeedCard vellum-coherent refactor per
// for-you-feedcard-redesign-spec-2026-05-14.md. The chrome moved from
// VellumCard + bg-white/35 to the vellum recipe (bg-stone-100/45 +
// backdrop-blur-[10px] + ambient 3-stop box-shadow + 4 CornerBrackets)
// and prose body sizes bumped to 12px per the legibility north star.
//
// Updated for C11 Inbox v2: FeedCard renders as a list row (StatusDot +
// text-sm title + muted one-line body preview) inside one
// `rounded-lg border divide-y` container in Feed.tsx — no framed card,
// no CornerBrackets, no hard shadows, no uppercase.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const packageRoot = nodePath.resolve(here, "..");

async function readSource(packageRelPath: string): Promise<string> {
  return readFileSync(nodePath.join(packageRoot, packageRelPath), "utf-8");
}

describe("FeedCard typography + list-row chrome (C11 Inbox v2)", () => {
  it("FeedCard renders as a list row (no framed card, no hard shadow, no registration marks)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // Rows live inside one `rounded-lg border divide-y` container in Feed.tsx.
    const feed = await readSource("src/components/for-you/Feed.tsx");
    expect(feed).toContain("rounded-lg border");
    expect(feed).toContain("divide-y");
    // The old framed-card chrome is gone.
    expect(source).not.toMatch(/VellumCard/);
    expect(source).not.toMatch(/CornerBracket/);
    expect(source).not.toMatch(/border-l-4 border-l-/);
    expect(source).not.toMatch(/0 2px 4px rgba\(0, 0, 0, 0\.14\)/);
    // No uppercase prose on the row.
    expect(source).not.toMatch(/tracking-\[0\.16em\]/);
  });

  it("FeedCard no longer imports the dashboard/vellum barrel (C11 replaces the old CornerBracket test)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).not.toContain('from "../dashboard/vellum/index.js"');
    expect(source).not.toMatch(/boxShadow:\s*"0 /);
  });

  it("FeedCard row puts a StatusDot before the title (C11 replaces the old 16px headline test)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("<StatusDot status={KIND_STATUS[card.kind]}");
    expect(source).not.toContain("font-headline text-[16px] font-bold");
  });

  it("FeedCard title is text-sm font-medium with a muted one-line body preview", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("truncate text-sm font-medium text-on-surface");
    // Body preview keeps the muted one-line truncate (F17 builds the class
    // list conditionally for the expanded state, so assert the parts).
    expect(source).toContain("mt-0.5 text-sm text-on-surface-variant");
    expect(source).toContain("truncate");
  });

  it("FeedCard ActionOutcomePanel outcome sentence stays prose font-body 12px", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-on-surface");
  });

  it("FeedCard prose copy is font-body 12px (bumped from 11px; the 'Your turn' hint itself is GONE per corrective §7.1)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-on-surface");
  });

  it("FeedCard kind maps to a StatusDot status (no colored pills)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // KIND_STATUS maps each FeedCardKind to a status-vocabulary status.
    expect(source).toContain("KIND_STATUS");
    expect(source).toContain('"action-required": "attention_required"');
    expect(source).toContain('shipped: "done"');
    expect(source).toContain('progress: "running"');
    expect(source).toContain('observation: "idle"');
    // Old colored-pill chrome should be gone.
    expect(source).not.toMatch(/bg-emerald-50/);
    expect(source).not.toMatch(/bg-rose-50/);
    expect(source).not.toMatch(/bg-amber-50/);
    expect(source).not.toMatch(/text-emerald-800/);
    expect(source).not.toMatch(/text-rose-800/);
    expect(source).not.toMatch(/text-amber-800/);
  });
});
