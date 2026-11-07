import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "../../../src/components/ui/button.js";
import { Badge } from "../../../src/components/ui/badge.js";
import { EmptyState } from "../../../src/components/ui/empty-state.js";
import { MetricTile } from "../../../src/components/ui/metric-tile.js";
import { Kbd } from "../../../src/components/ui/kbd.js";
import { Separator } from "../../../src/components/ui/separator.js";
import { PageHeader } from "../../../src/components/ui/page-header.js";

describe("Tier 1 Feature Coverage: Page Restyling & UI Primitives", () => {
  it("Button renders multiple semantic variants with clean theme tokens", () => {
    const { rerender } = render(<Button variant="default">Default Button</Button>);
    expect(screen.getByRole("button").className).toContain("bg-primary");

    rerender(<Button variant="tactical">Tactical Button</Button>);
    expect(screen.getByRole("button").className).toContain("font-medium");

    rerender(<Button variant="outline">Outline Button</Button>);
    expect(screen.getByRole("button").className).toContain("border");

    rerender(<Button variant="ghost">Ghost Button</Button>);
    expect(screen.getByRole("button").className).toContain("hover:bg-surface-low");
  });

  it("Badge supports default, destructive, and outline variants", () => {
    const { container, rerender } = render(<Badge variant="default">Active</Badge>);
    expect(container.firstChild).toBeTruthy();

    rerender(<Badge variant="destructive">Failed</Badge>);
    const badgeEl = container.firstElementChild as HTMLElement;
    expect(badgeEl.className).toContain("bg-destructive");

    rerender(<Badge variant="outline">Draft</Badge>);
    expect((container.firstElementChild as HTMLElement).className).toContain("border");
  });

  it("EmptyState renders title, description, and primary action affordance", () => {
    render(
      <EmptyState
        title="No items found"
        description="Try adjusting your filter parameters or create a new entry."
        action={{ label: "Create item", href: "/create" }}
        testId="empty-state"
      />,
    );

    expect(screen.getByText("No items found")).toBeTruthy();
    expect(screen.getByText("Try adjusting your filter parameters or create a new entry.")).toBeTruthy();
    const action = screen.getByTestId("empty-state-action");
    expect(action.textContent).toBe("Create item");
    expect(action.getAttribute("href")).toBe("/create");
  });

  it("MetricTile displays quantitative metrics with label, value, and sublabel", () => {
    render(
      <MetricTile
        label="Running Rigs"
        value={12}
        sublabel="3 in standby"
        testId="metric-rigs"
      />,
    );

    const tile = screen.getByTestId("metric-rigs");
    expect(tile.textContent).toContain("Running Rigs");
    expect(tile.textContent).toContain("12");
    expect(tile.textContent).toContain("3 in standby");
  });

  it("Kbd renders keyboard shortcuts with monospace font class", () => {
    const { container } = render(<Kbd>Ctrl+Shift+P</Kbd>);
    const kbd = container.querySelector("kbd");
    expect(kbd?.textContent).toBe("Ctrl+Shift+P");
    expect(kbd?.className).toContain("font-mono");
  });

  it("Separator supports horizontal and vertical orientations", () => {
    const { container, rerender } = render(<Separator orientation="horizontal" />);
    expect(container.querySelector("[data-orientation='horizontal']")).toBeTruthy();

    rerender(<Separator orientation="vertical" />);
    expect(container.querySelector("[data-orientation='vertical']")).toBeTruthy();
  });

  it("PageHeader generates semantic header layout with title, meta, and actions", () => {
    render(
      <PageHeader
        title="Fleet Management"
        description="Monitor distributed rig instances across clusters"
        meta={<span data-testid="fleet-count">5 online</span>}
        actions={<Button>Add Host</Button>}
      />,
    );

    expect(screen.getByText("Fleet Management").tagName).toBe("H1");
    expect(screen.getByText("Monitor distributed rig instances across clusters")).toBeTruthy();
    expect(screen.getByTestId("fleet-count").textContent).toBe("5 online");
    expect(screen.getByRole("button", { name: "Add Host" })).toBeTruthy();
  });
});
