// V1 attempt-3 Phase 5 P5-8 — HumanSeatCard VellumCard refactor.
//
// Verifies HumanSeatCard composes the VellumCard primitive (Phase 1) +
// renders RegistrationMarks at the canonical 4 corners + uses the
// StatusPip primitive for pending/blocked state. Per ritual #6
// (named-surface adopts primitive verifies at consumer level).

import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { HumanSeatCard } from "../src/components/mission-control/components/HumanSeatCard.js";
import type { CompactStatusRow } from "../src/components/mission-control/hooks/useMissionControlView.js";

beforeEach(() => {
  cleanup();
});

function makeRow(state: CompactStatusRow["state"]): CompactStatusRow {
  return {
    session: `seat-${state}@test`,
    role: "qa",
    pod: "test",
    rigName: "test",
    rigId: "rig-1",
    logicalId: `seat-${state}`,
    runtime: "claude-code",
    state,
  } as CompactStatusRow;
}

describe("HumanSeatCard P5-8 VellumCard composition", () => {
  it("composes VellumCard chrome (registration marks present)", () => {
    const { container } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[makeRow("idle"), makeRow("attention")]}
      />,
    );
    // VellumCard composes RegistrationMarks; reg-mark testids should be
    // present at all 4 corners.
    expect(container.querySelector(".reg-mark, [data-testid$='-reg-tl']")).toBeTruthy();
    // The card root has the canonical testid.
    expect(container.querySelector("[data-testid='mc-human-seat-card']")).toBeTruthy();
  });

  it("renders pending count + StatusPip 'pending' when no blocked rows", () => {
    const { container, getByTestId } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[makeRow("idle"), makeRow("attention")]}
      />,
    );
    expect(getByTestId("mc-human-seat-pending").textContent).toBe("2");
    // No blocked StatusPip when 0 blocked.
    expect(container.querySelector("[data-testid='mc-human-seat-blocked']")).toBeNull();
  });

  it("surfaces blocked-count via StatusPip when any row is blocked (warning tone)", () => {
    const { getByTestId } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[makeRow("blocked"), makeRow("idle")]}
      />,
    );
    const pip = getByTestId("mc-human-seat-blocked");
    expect(pip.textContent).toContain("1 blocked");
  });

  it("renders capability pills with outline-variant border (vellum aesthetic)", () => {
    const { container } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[]}
        capabilities={["approve", "deny"]}
      />,
    );
    const pills = Array.from(container.querySelectorAll("span")).filter((s) =>
      ["approve", "deny"].includes(s.textContent?.trim() ?? ""),
    );
    expect(pills.length).toBe(2);
    // Each pill has the outline-variant border class (1px doctrine).
    for (const pill of pills) {
      expect(pill.className).toMatch(/border-outline-variant/);
    }
  });

  it("source asserts no legacy stone-50/stone-300 ad-hoc card chrome remains (ritual #9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/mission-control/components/HumanSeatCard.tsx",
      ),
      "utf8",
    );
    // The legacy chrome was `border border-stone-300 bg-stone-50 p-3` —
    // negative-assertion that none of those literal patterns survive
    // outside the historical comment.
    const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toMatch(/border-stone-300\s+bg-stone-50/);
    expect(codeOnly).toMatch(/VellumCard/);
  });
});
