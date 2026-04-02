import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { SpecsPanel } from "../src/components/SpecsPanel.js";

function renderPanel() {
  const onClose = vi.fn();

  const result = render(
    createTestRouter({
      path: "/",
      initialPath: "/",
      component: () => <SpecsPanel onClose={onClose} />,
    })
  );

  return { ...result, onClose };
}

describe("SpecsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the drawer with the expected sections and actions", async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
    });

    expect(screen.getByTestId("specs-panel")).toBeDefined();
    expect(screen.getByText("specs")).toBeDefined();
    expect(screen.getByText("Rig Specs")).toBeDefined();
    expect(screen.getByText("Agent Specs")).toBeDefined();
    expect(screen.getByText("Import RigSpec")).toBeDefined();
    expect(screen.getByText("Bootstrap")).toBeDefined();
    expect(screen.getByText("Validate AgentSpec")).toBeDefined();
  });

  it("closes from the header close control", async () => {
    const { onClose } = renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("specs-close")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("specs-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
