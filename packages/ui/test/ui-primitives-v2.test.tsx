// C03: Restyle primitives + new primitives.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PageHeader } from "../src/components/ui/page-header";
import { MetricTile } from "../src/components/ui/metric-tile";
import { Kbd } from "../src/components/ui/kbd";
import { Skeleton } from "../src/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../src/components/ui/dropdown-menu";
import { createAppTestRouter } from "./helpers/test-router";

describe("ui primitives v2 (C03)", () => {
  it("PageHeader renders title, description and actions", () => {
    render(
      <PageHeader
        title="Rigs"
        description="All your rigs"
        actions={<button data-testid="ph-act">New rig</button>}
        meta={<span data-testid="ph-meta">3 rigs</span>}
      />,
    );
    expect(screen.getByText("Rigs").tagName).toBe("H1");
    expect(screen.getByText("All your rigs")).toBeTruthy();
    expect(screen.getByTestId("ph-act")).toBeTruthy();
    expect(screen.getByTestId("ph-meta")).toBeTruthy();
    expect(screen.getByTestId("page-header").tagName).toBe("HEADER");
  });

  it("PageHeader uses a custom testId when given", () => {
    render(<PageHeader title="Inbox" testId="inbox-header" />);
    expect(screen.getByTestId("inbox-header")).toBeTruthy();
  });

  it("MetricTile renders label, value and sublabel", () => {
    render(
      <MetricTile label="Active" value={7} sublabel="across 3 rigs" testId="mt" />,
    );
    expect(screen.getByTestId("mt").textContent).toContain("Active");
    expect(screen.getByTestId("mt").textContent).toContain("7");
    expect(screen.getByTestId("mt").textContent).toContain("across 3 rigs");
  });

  it("MetricTile with `to` renders a link to that path", async () => {
    render(
      createAppTestRouter({
        initialPath: "/",
        routes: [
          {
            path: "/",
            component: () => (
              <MetricTile label="Rigs" value={3} to="/topology" testId="mt-link" />
            ),
          },
        ],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("mt-link")).toBeTruthy();
    });
    const el = screen.getByTestId("mt-link") as HTMLAnchorElement;
    expect(el.tagName).toBe("A");
    expect(el.getAttribute("href")).toBe("/topology");
  });

  it("DropdownMenu opens via keyDown Enter and renders items", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Stop rig</DropdownMenuItem>
          <DropdownMenuItem destructive>Delete rig</DropdownMenuItem>
          <DropdownMenuSeparator />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.keyDown(screen.getByText("Open"), { key: "Enter" });
    expect(screen.queryByText("Stop rig")).toBeTruthy();
  });

  it("DropdownMenu destructive item carries text-destructive", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem destructive>Delete rig</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.keyDown(screen.getByText("Open"), { key: "Enter" });
    const item = screen.getByText("Delete rig");
    expect(item.className).toContain("text-destructive");
  });

  it("Kbd renders children with mono styling", () => {
    const { container } = render(<Kbd>⌘K</Kbd>);
    const el = container.querySelector("kbd");
    expect(el?.textContent).toBe("⌘K");
    expect(el?.className).toContain("font-mono");
  });

  it("Skeleton renders an animated pulse block", () => {
    const { container } = render(<Skeleton className="h-6" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("bg-surface-mid");
  });
});
