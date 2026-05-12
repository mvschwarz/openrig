// Slice 24.D BLOCKING-CONCERN repair (secondary): the trailing slot
// (e.g., "Launch in CMUX" button) must be a SIBLING of the tablist,
// not a child. Tablist children should only be tabs; per ARIA, mixing
// non-tab interactive children confuses keyboard navigation +
// screen-readers. Test pins the structural contract.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TopologyViewModeTabs } from "../src/components/topology/TopologyViewModeTabs.js";

afterEach(() => {
  cleanup();
});

describe("TopologyViewModeTabs trailing slot — a11y structure", () => {
  const tabs = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];

  it("without trailing: renders just the tablist (no outer wrapper)", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t1"
      />,
    );
    expect(screen.getByTestId("t1-tabs")).toBeTruthy();
    expect(screen.queryByTestId("t1-tab-bar")).toBeNull();
    expect(screen.queryByTestId("t1-trailing")).toBeNull();
  });

  it("with trailing: tablist is INSIDE the outer tab-bar but trailing slot is OUTSIDE the tablist", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t2"
        trailing={<button data-testid="my-action">Action</button>}
      />,
    );
    const tabBar = screen.getByTestId("t2-tab-bar");
    const tablist = screen.getByTestId("t2-tabs");
    const trailing = screen.getByTestId("t2-trailing");
    const action = screen.getByTestId("my-action");

    // Tablist nested under outer tab-bar
    expect(tabBar.contains(tablist)).toBe(true);
    // Trailing slot nested under outer tab-bar
    expect(tabBar.contains(trailing)).toBe(true);
    // CRITICAL a11y assertion: trailing is NOT a descendant of tablist.
    // Tablist should only contain tabs; the trailing action should be
    // a sibling of the tablist within the outer tab-bar wrapper.
    expect(tablist.contains(trailing)).toBe(false);
    // The action button rendered inside trailing slot
    expect(trailing.contains(action)).toBe(true);
  });

  it("trailing slot has ml-auto class (placement: tab-bar far right per README §Button placement Option C)", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t3"
        trailing={<span data-testid="placement-marker">x</span>}
      />,
    );
    const trailing = screen.getByTestId("t3-trailing");
    expect(trailing.className).toMatch(/\bml-auto\b/);
  });

  it("tablist contains ONLY the tab buttons (no non-tab role=tab children)", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t4"
        trailing={<button data-testid="trailing-button">Trailing</button>}
      />,
    );
    const tablist = screen.getByTestId("t4-tabs");
    // Tablist children are the 2 tab buttons; trailing button is NOT
    // among them.
    const tabButtons = tablist.querySelectorAll('[role="tab"]');
    expect(tabButtons).toHaveLength(2);
    // Trailing button has no role=tab and isn't inside tablist.
    const trailingButton = screen.getByTestId("trailing-button");
    expect(trailingButton.getAttribute("role")).not.toBe("tab");
    expect(tablist.contains(trailingButton)).toBe(false);
  });
});
