import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspacePage } from "../src/components/WorkspacePage.js";

describe("WorkspacePage", () => {
  it("renders a centered workspace shell that accounts for the explorer offset", () => {
    render(
      <WorkspacePage>
        <div data-testid="workspace-child">content</div>
      </WorkspacePage>
    );

    const page = screen.getByTestId("workspace-page");
    const inner = screen.getByTestId("workspace-page-inner");
    expect(page.className).toContain("w-full");
    expect(page.className).toContain("flex-1");
    expect(page.className).toContain("overflow-y-auto");
    expect(page.className).toContain("lg:pl-[var(--workspace-left-offset,0px)]");
    expect(inner.className).toContain("mx-auto");
    expect(inner.className).toContain("max-w-[960px]");
    expect(screen.getByTestId("workspace-child").textContent).toBe("content");
  });
});
