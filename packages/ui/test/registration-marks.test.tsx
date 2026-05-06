// V1 Shell Redesign — Phase 1 — RegistrationMarks primitive.
//
// API surface tests + CSS-source-assertion regression test for the
// pseudo-element-paint contract (discipline ritual #7).
//
// The CSS-source-assertion test enforces DRIFT-2 fix: each corner
// (.reg-tl, .reg-tr, .reg-bl, .reg-br) must have its own ::before and
// ::after rules carrying content + position + background-color, so each
// corner renders symmetrically without requiring a .reg-mark parent.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RegistrationMarks } from "../src/components/ui/registration-marks";

const GLOBALS_CSS = readFileSync(
  path.resolve(__dirname, "../src/globals.css"),
  "utf8",
);

describe("RegistrationMarks (Phase 1 primitive)", () => {
  it("renders 4 corner spans (tl/tr/bl/br)", () => {
    const { container } = render(<RegistrationMarks />);
    expect(container.querySelector(".reg-tl")).toBeTruthy();
    expect(container.querySelector(".reg-tr")).toBeTruthy();
    expect(container.querySelector(".reg-bl")).toBeTruthy();
    expect(container.querySelector(".reg-br")).toBeTruthy();
  });

  it("attaches testIds when testIdPrefix is provided", () => {
    const { getByTestId } = render(<RegistrationMarks testIdPrefix="card-x" />);
    expect(getByTestId("card-x-reg-tl")).toBeTruthy();
    expect(getByTestId("card-x-reg-tr")).toBeTruthy();
    expect(getByTestId("card-x-reg-bl")).toBeTruthy();
    expect(getByTestId("card-x-reg-br")).toBeTruthy();
  });

  it("omits testIds when testIdPrefix not provided", () => {
    const { container } = render(<RegistrationMarks />);
    const tl = container.querySelector(".reg-tl") as HTMLElement | null;
    expect(tl?.dataset.testid).toBeUndefined();
  });

  it("merges className onto every corner span", () => {
    const { container } = render(<RegistrationMarks className="opacity-50" />);
    const corners = container.querySelectorAll(
      ".reg-tl, .reg-tr, .reg-bl, .reg-br",
    );
    expect(corners.length).toBe(4);
    corners.forEach((c) => {
      expect((c as HTMLElement).className).toContain("opacity-50");
    });
  });

  it("each corner span carries aria-hidden true", () => {
    const { container } = render(<RegistrationMarks />);
    const corners = container.querySelectorAll(
      ".reg-tl, .reg-tr, .reg-bl, .reg-br",
    );
    corners.forEach((c) => {
      expect(c.getAttribute("aria-hidden")).toBe("true");
    });
  });
});

// CSS-source-assertion: pseudo-element-paint test contract.
//
// jsdom does not paint pseudo-elements, so we verify the CSS source
// directly. Each corner class MUST carry self-contained ::before and
// ::after rules with content, position, and background-color — the
// DRIFT-2 fix from V1 attempt-3 dispatch.
describe("globals.css registration-mark CSS source (DRIFT-2 regression)", () => {
  const corners = ["reg-tl", "reg-tr", "reg-bl", "reg-br"] as const;

  for (const c of corners) {
    it(`.${c}::before is self-contained (content + position + bg-color)`, () => {
      // Match the standalone selector — NOT the .reg-mark > .${c} parent-qualified one.
      const re = new RegExp(
        `(^|[^>\\s])\\s*\\.${c}::before\\s*\\{[^}]*content:\\s*'';[^}]*position:\\s*absolute;[^}]*background-color:\\s*#546073;`,
        "m",
      );
      expect(GLOBALS_CSS).toMatch(re);
    });
    it(`.${c}::after is self-contained (content + position + bg-color)`, () => {
      const re = new RegExp(
        `(^|[^>\\s])\\s*\\.${c}::after\\s*\\{[^}]*content:\\s*'';[^}]*position:\\s*absolute;[^}]*background-color:\\s*#546073;`,
        "m",
      );
      expect(GLOBALS_CSS).toMatch(re);
    });
  }

  it("paper-grid radial-gradient uses 1px dot radius (DRIFT-3)", () => {
    expect(GLOBALS_CSS).toMatch(
      /radial-gradient\(#d1d1cf\s+1px,\s*transparent\s+1px\)/,
    );
  });
});
