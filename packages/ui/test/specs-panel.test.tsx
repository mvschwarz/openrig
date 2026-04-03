import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { SpecsPanel } from "../src/components/SpecsPanel.js";
import { SpecsWorkspaceProvider, SPECS_WORKSPACE_STORAGE_KEYS } from "../src/components/SpecsWorkspace.js";

function renderPanel(initialPath = "/") {
  const onClose = vi.fn();

  const result = render(
    createAppTestRouter({
      initialPath,
      routes: [
        { path: "/", component: () => <div data-testid="specs-home">home</div> },
        { path: "/import", component: () => <div data-testid="import-route">import</div> },
        { path: "/specs/rig", component: () => <div data-testid="rig-review-route">review</div> },
        { path: "/specs/agent", component: () => <div data-testid="agent-review-route">agent-review</div> },
        { path: "/bootstrap", component: () => <div data-testid="bootstrap-route">bootstrap</div> },
        { path: "/agents/validate", component: () => <div data-testid="agent-validate-route">validate</div> },
      ],
      rootComponent: ({ children }) => (
        <SpecsWorkspaceProvider>
          <SpecsPanel onClose={onClose} />
          {children}
        </SpecsWorkspaceProvider>
      ),
    })
  );

  return { ...result, onClose };
}

function seedSpecsStorage(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

describe("SpecsPanel", () => {
  afterEach(() => {
    window.localStorage.clear();
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

  it("shows the active Specs task summary when a workspace flow is open", async () => {
    seedSpecsStorage(SPECS_WORKSPACE_STORAGE_KEYS.currentRigDraft, {
      id: "rig-1",
      kind: "rig",
      label: "captured-dev-pod",
      yaml: "name: captured-dev-pod\n",
      updatedAt: Date.now(),
    });

    renderPanel("/import");

    await waitFor(() => {
      expect(screen.getByText("Current Task")).toBeDefined();
    });

    expect(screen.getByText("Import RigSpec")).toBeDefined();
    expect(screen.getAllByText("captured-dev-pod").length).toBeGreaterThan(0);
  });

  it("does not show Current Task when a flow is open but no resumable state exists yet", async () => {
    renderPanel("/bootstrap");

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
    });

    expect(screen.queryByText("Current Task")).toBeNull();
  });

  it("lists recent rig drafts and opens the rig review workspace from the drawer", async () => {
    seedSpecsStorage(SPECS_WORKSPACE_STORAGE_KEYS.recentRigDrafts, [
      {
        id: "rig-recent",
        kind: "rig",
        label: "research-pod",
        yaml: "name: research-pod\n",
        updatedAt: Date.now(),
      },
    ]);

    renderPanel("/");

    await waitFor(() => {
      expect(screen.getByText("research-pod")).toBeDefined();
    });

    fireEvent.click(screen.getByText("research-pod"));

    await waitFor(() => {
      expect(screen.getByTestId("rig-review-route")).toBeDefined();
    });
  });

  it("closes from the header close control", async () => {
    const { onClose } = renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("specs-close")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("specs-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists recent agent drafts and opens the agent review workspace from the drawer", async () => {
    seedSpecsStorage(SPECS_WORKSPACE_STORAGE_KEYS.recentAgentDrafts, [
      {
        id: "agent-recent",
        kind: "agent",
        label: "qa",
        yaml: 'name: qa\nversion: "1.0.0"\nprofiles:\n  default:\n',
        updatedAt: Date.now(),
      },
    ]);

    renderPanel("/");

    await waitFor(() => {
      expect(screen.getByText("qa")).toBeDefined();
    });

    fireEvent.click(screen.getByText("qa"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-review-route")).toBeDefined();
    });
  });
});
