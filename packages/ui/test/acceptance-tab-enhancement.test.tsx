// UI Enhancement Pack v0 — AcceptanceTab item-1A extension tests.
//
// Pins the v0 → v0-enhanced behavior:
//   - checkbox pills with status icon + label (not raw [ ]/[x])
//   - 4-filter row (All / Active / Done / Blocked) with default All
//   - clicking a row expands an inline detail panel
//   - filter narrows the visible rows; empty-after-filter has its own
//     message; filter unchanged when items array is empty
//
// Slice Story View v0 baseline behavior preserved (progress bar +
// closure callout + source citation + per-row data-done attribute).

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AcceptanceTab } from "../src/components/slices/tabs/AcceptanceTab.js";
import type { SliceDetail } from "../src/hooks/useSlices.js";

afterEach(() => cleanup());

function makeAcceptance(items: SliceDetail["acceptance"]["items"]): SliceDetail["acceptance"] {
  const done = items.filter((i) => i.done).length;
  return {
    totalItems: items.length,
    doneItems: done,
    percentage: items.length === 0 ? 0 : Math.round((done / items.length) * 100),
    items,
    closureCallout: null,
  };
}

describe("UI Enhancement Pack v0 — AcceptanceTab", () => {
  it("renders checkbox pills with status icons (not raw [ ]/[x])", () => {
    render(<AcceptanceTab acceptance={makeAcceptance([
      { text: "Item 1", done: true, source: { file: "README.md", line: 10 } },
      { text: "Item 2", done: false, source: { file: "README.md", line: 11 } },
    ])} />);
    expect(screen.getByTestId("acceptance-pill-0").textContent).toContain("done");
    expect(screen.getByTestId("acceptance-pill-0").textContent).toContain("✓");
    expect(screen.getByTestId("acceptance-pill-1").textContent).toContain("active");
    expect(screen.getByTestId("acceptance-pill-1").textContent).toContain("◯");
  });

  it("renders the four-filter row with All as default-active", () => {
    render(<AcceptanceTab acceptance={makeAcceptance([
      { text: "x", done: true, source: { file: "x.md", line: 1 } },
    ])} />);
    expect(screen.getByTestId("acceptance-filter-row")).toBeDefined();
    for (const f of ["all", "active", "done", "blocked"]) {
      expect(screen.getByTestId(`acceptance-filter-${f}`)).toBeDefined();
    }
    expect(screen.getByTestId("acceptance-filter-all").getAttribute("data-active")).toBe("true");
  });

  it("filtering to Active narrows the visible rows", () => {
    render(<AcceptanceTab acceptance={makeAcceptance([
      { text: "done item", done: true, source: { file: "x.md", line: 1 } },
      { text: "active item", done: false, source: { file: "x.md", line: 2 } },
    ])} />);
    fireEvent.click(screen.getByTestId("acceptance-filter-active"));
    expect(screen.queryByText("done item")).toBeNull();
    expect(screen.getByText("active item")).toBeDefined();
  });

  it("filtering to a state with no matching items shows the empty-filter message", () => {
    render(<AcceptanceTab acceptance={makeAcceptance([
      { text: "done item", done: true, source: { file: "x.md", line: 1 } },
    ])} />);
    fireEvent.click(screen.getByTestId("acceptance-filter-active"));
    expect(screen.getByTestId("acceptance-filter-empty").textContent).toContain("active");
  });

  it("clicking a row expands the detail panel + clicking again collapses it", () => {
    render(<AcceptanceTab acceptance={makeAcceptance([
      { text: "expandable item", done: false, source: { file: "README.md", line: 42 } },
    ])} />);
    fireEvent.click(screen.getByTestId("acceptance-item-0-toggle"));
    const detail = screen.getByTestId("acceptance-item-0-detail");
    expect(detail).toBeDefined();
    expect(screen.getByTestId("acceptance-item-0-citation").textContent).toBe("README.md:42");
    fireEvent.click(screen.getByTestId("acceptance-item-0-toggle"));
    expect(screen.queryByTestId("acceptance-item-0-detail")).toBeNull();
  });

  it("preserves v0 progress bar + per-row data-done attributes", () => {
    render(<AcceptanceTab acceptance={makeAcceptance([
      { text: "x", done: true, source: { file: "x.md", line: 1 } },
      { text: "y", done: false, source: { file: "x.md", line: 2 } },
    ])} />);
    expect(screen.getByTestId("acceptance-progress-bar")).toBeDefined();
    expect(screen.getByTestId("acceptance-progress-fill").getAttribute("data-percentage")).toBe("50");
    expect(screen.getByTestId("acceptance-item-0").getAttribute("data-done")).toBe("true");
    expect(screen.getByTestId("acceptance-item-1").getAttribute("data-done")).toBe("false");
  });

  it("empty items array still renders the v0 empty state (no filter row)", () => {
    render(<AcceptanceTab acceptance={makeAcceptance([])} />);
    expect(screen.getByTestId("acceptance-empty")).toBeDefined();
    expect(screen.queryByTestId("acceptance-filter-row")).toBeNull();
  });
});
