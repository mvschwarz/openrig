import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { presentStatus, TABLE, TONE_CLASSES } from "../src/lib/status-vocabulary.js";
import { StatusBadge, StatusDot } from "../src/components/ui/status-badge.jsx";

describe("presentStatus table entries", () => {
  for (const [raw, expected] of Object.entries(TABLE)) {
    it(`maps ${JSON.stringify(raw)} to tone ${expected.tone} / label ${JSON.stringify(expected.label)}`, () => {
      expect(presentStatus(raw)).toEqual(expected);
    });
  }
});

describe("presentStatus edge cases", () => {
  it("presentStatus(null) is Unknown/neutral", () => {
    expect(presentStatus(null)).toEqual({ tone: "neutral", label: "Unknown" });
  });

  it("presentStatus(undefined) and empty/blank strings are Unknown/neutral", () => {
    expect(presentStatus(undefined)).toEqual({ tone: "neutral", label: "Unknown" });
    expect(presentStatus("")).toEqual({ tone: "neutral", label: "Unknown" });
    expect(presentStatus("   ")).toEqual({ tone: "neutral", label: "Unknown" });
  });

  it('presentStatus("  RUNNING ") is Running/running (trim + case-insensitive)', () => {
    expect(presentStatus("  RUNNING ")).toEqual({ tone: "running", label: "Running" });
  });

  it('presentStatus("in_review") falls back to neutral with a sentence-case label', () => {
    expect(presentStatus("in_review")).toEqual({ tone: "neutral", label: "In review" });
  });

  it("falls back to neutral with dashes and underscores replaced by spaces", () => {
    expect(presentStatus("custom-state_here")).toEqual({
      tone: "neutral",
      label: "Custom state here",
    });
  });
});

describe("TONE_CLASSES", () => {
  it("covers every tone with dot + badge classes, running dot respects reduced motion", () => {
    for (const tone of ["success", "running", "warning", "danger", "info", "neutral"] as const) {
      expect(TONE_CLASSES[tone].dot.length).toBeGreaterThan(0);
      expect(TONE_CLASSES[tone].badge.length).toBeGreaterThan(0);
    }
    expect(TONE_CLASSES.running.dot).toContain("motion-reduce:animate-none");
  });
});

describe("StatusBadge", () => {
  it("renders the table label with the matching data-tone", () => {
    render(<StatusBadge status="attention_required" testId="b" />);
    const el = screen.getByTestId("b");
    expect(el.getAttribute("data-tone")).toBe("danger");
    expect(el.textContent).toBe("Needs attention");
  });

  it("prefers an explicit label override", () => {
    render(<StatusBadge status="failed" label="Custom" testId="b2" />);
    const el = screen.getByTestId("b2");
    expect(el.getAttribute("data-tone")).toBe("danger");
    expect(el.textContent).toBe("Custom");
  });

  it("maps unknown input to Unknown/neutral", () => {
    render(<StatusBadge status={null} testId="b3" />);
    const el = screen.getByTestId("b3");
    expect(el.getAttribute("data-tone")).toBe("neutral");
    expect(el.textContent).toBe("Unknown");
  });
});

describe("StatusDot", () => {
  it("exposes the presentation as an accessible label", () => {
    render(<StatusDot status="running" />);
    const el = screen.getByRole("img", { name: "Running" });
    expect(el.getAttribute("data-tone")).toBe("running");
    expect(el.getAttribute("title")).toBe("Running");
  });
});
