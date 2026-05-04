import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceHome } from "../src/components/WorkspaceHome.js";

describe("WorkspaceHome", () => {
  it("links to Mission Control from the home page", () => {
    render(<WorkspaceHome />);

    const link = screen.getByTestId("workspace-open-mission-control");
    expect(link.textContent).toContain("Mission Control");
    expect(link.getAttribute("href")).toBe("/mission-control");
  });
});
