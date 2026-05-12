// Slice 26 Checkpoint A — SettingsExplorer (sidebar) tests.

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SettingsExplorer } from "../src/components/system/SettingsExplorer.js";
import { createAppTestRouter } from "./helpers/test-router.js";

afterEach(() => {
  cleanup();
});

function renderAt(initialPath: string) {
  // All 4 Settings sub-routes mount the SettingsExplorer so the Link
  // active-state derivation can be exercised at any of them.
  const explorerComponent = () => <SettingsExplorer />;
  return render(
    createAppTestRouter({
      initialPath,
      routes: [
        { path: "/settings", component: explorerComponent },
        { path: "/settings/policies", component: explorerComponent },
        { path: "/settings/log", component: explorerComponent },
        { path: "/settings/status", component: explorerComponent },
      ],
    }),
  );
}

describe("SettingsExplorer", () => {
  it("renders 4 items: Settings / Policies / Log / Status (HG-2)", async () => {
    renderAt("/settings");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer-item-settings")).toBeTruthy();
    });
    expect(screen.getByTestId("settings-explorer-item-policies")).toBeTruthy();
    expect(screen.getByTestId("settings-explorer-item-log")).toBeTruthy();
    expect(screen.getByTestId("settings-explorer-item-status")).toBeTruthy();
  });

  it("each item is a navigation link with the expected href", async () => {
    renderAt("/settings");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer-item-settings")).toBeTruthy();
    });
    expect(screen.getByTestId("settings-explorer-item-settings").getAttribute("href")).toBe("/settings");
    expect(screen.getByTestId("settings-explorer-item-policies").getAttribute("href")).toBe("/settings/policies");
    expect(screen.getByTestId("settings-explorer-item-log").getAttribute("href")).toBe("/settings/log");
    expect(screen.getByTestId("settings-explorer-item-status").getAttribute("href")).toBe("/settings/status");
  });

  it("on /settings: Settings item is marked active (data-active=true)", async () => {
    renderAt("/settings");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer-item-settings").getAttribute("data-active")).toBe("true");
    });
    expect(screen.getByTestId("settings-explorer-item-policies").getAttribute("data-active")).toBe("false");
  });

  it("on /settings/policies: Policies item is marked active", async () => {
    renderAt("/settings/policies");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer-item-policies").getAttribute("data-active")).toBe("true");
    });
    expect(screen.getByTestId("settings-explorer-item-settings").getAttribute("data-active")).toBe("false");
  });

  it("on /settings/log: Log item is marked active", async () => {
    renderAt("/settings/log");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer-item-log").getAttribute("data-active")).toBe("true");
    });
  });

  it("on /settings/status: Status item is marked active", async () => {
    renderAt("/settings/status");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer-item-status").getAttribute("data-active")).toBe("true");
    });
  });

  it("explorer root has discoverable testid for downstream selectors", async () => {
    renderAt("/settings");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer")).toBeTruthy();
    });
  });

  it("item labels are human-readable + match dispatch (Settings / Policies / Log / Status)", async () => {
    renderAt("/settings");
    await waitFor(() => {
      expect(screen.getByTestId("settings-explorer-item-settings")).toBeTruthy();
    });
    expect(screen.getByTestId("settings-explorer-item-settings").textContent).toMatch(/settings/i);
    expect(screen.getByTestId("settings-explorer-item-policies").textContent).toMatch(/policies/i);
    expect(screen.getByTestId("settings-explorer-item-log").textContent).toMatch(/log/i);
    expect(screen.getByTestId("settings-explorer-item-status").textContent).toMatch(/status/i);
  });
});
