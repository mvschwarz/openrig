import { describe, it, expect } from "vitest";
import { screen, fireEvent, within, waitFor } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt } from "../helpers/e2e-harness.js";

const SEARCH_PLACEHOLDER = "Search pages, rigs, actions…";

setupE2EEnv();

async function openPalette() {
  const result = await renderE2EAppAt("/");
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
  return { ...result, input: input as HTMLInputElement };
}

describe("Tier 1 Feature Coverage: Command Palette (⌘K) & Shortcuts", () => {
  it("opens palette upon Cmd+K / Ctrl+K with styled container and search input", async () => {
    await openPalette();
    const palette = screen.getByTestId("command-palette");
    expect(palette).toBeTruthy();
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeTruthy();
  });

  it("filters routes dynamically and displays matches under Go to group", async () => {
    const { input } = await openPalette();
    fireEvent.change(input, { target: { value: "Inbox" } });
    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByText("Go to")).toBeTruthy();
    expect(within(palette).getByText("Inbox")).toBeTruthy();
  });

  it("navigates to target route on item selection and closes palette", async () => {
    const { input } = await openPalette();
    fireEvent.change(input, { target: { value: "topology" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
    });
    expect(screen.getByTestId("page-topology")).toBeTruthy();
  });

  it("closes palette cleanly when Escape key is pressed", async () => {
    await openPalette();
    expect(screen.getByTestId("command-palette")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
    });
  });

  it("executes rapid sequential g-then-key shortcuts (g d to Dashboard, g i to Inbox)", async () => {
    await renderE2EAppAt("/topology");
    expect(screen.getByTestId("page-topology")).toBeTruthy();

    // Type g then i
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "i" });

    await waitFor(() => {
      expect(screen.getByTestId("page-inbox")).toBeTruthy();
    });

    // Type g then d
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "d" });

    await waitFor(() => {
      expect(screen.getByTestId("page-dashboard")).toBeTruthy();
    });
  });

  it("suppresses g-then-key navigation when focus is inside a form input", async () => {
    await renderE2EAppAt("/", {
      extraRoutes: [
        {
          path: "/test-form",
          component: () => (
            <div>
              <input data-testid="test-text-input" defaultValue="" />
            </div>
          ),
        },
      ],
    });

    // Mount input
    const input = document.createElement("input");
    input.setAttribute("data-testid", "floating-input");
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: "g" });
    fireEvent.keyDown(input, { key: "i" });

    // Should NOT navigate away
    expect(screen.getByTestId("page-dashboard")).toBeTruthy();
    expect(screen.queryByTestId("page-inbox")).toBeNull();

    document.body.removeChild(input);
  });
});
