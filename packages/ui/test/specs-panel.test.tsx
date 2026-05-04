import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppTestRouter } from "./helpers/test-router.js";
import { SpecsPanel } from "../src/components/SpecsPanel.js";
import { SpecsWorkspaceProvider, SPECS_WORKSPACE_STORAGE_KEYS } from "../src/components/SpecsWorkspace.js";

const mockFetch = vi.fn();

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

describe("SpecsPanel filter chips and richer rows", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockImplementation(async (url: string) => {
      // Only the all-entries path (no ?kind=) returns data.
      // kind-specific queries return empty to prove the unified list
      // uses a single useSpecLibrary() call, not separate kind queries.
      if (typeof url === "string" && url.includes("/api/specs/library")) {
        if (url.includes("kind=")) {
          return { ok: true, json: async () => [] };
        }
        return {
          ok: true,
          json: async () => [
            {
              id: "app-1",
              kind: "rig",
              name: "secrets-manager",
              version: "0.2",
              sourceType: "builtin",
              sourcePath: "/specs/rigs/launch/secrets-manager/rig.yaml",
              relativePath: "rigs/launch/secrets-manager/rig.yaml",
              updatedAt: "2026-04-09T00:00:00Z",
              summary: "HashiCorp Vault in dev mode with a dedicated Vault specialist agent",
              hasServices: true,
            },
            {
              id: "rig-1",
              kind: "rig",
              name: "demo",
              version: "0.2",
              sourceType: "builtin",
              sourcePath: "/specs/rigs/launch/demo/rig.yaml",
              relativePath: "rigs/launch/demo/rig.yaml",
              updatedAt: "2026-04-09T00:00:00Z",
              summary: "Stable full-team starter",
            },
            {
              id: "agent-1",
              kind: "agent",
              name: "implementer",
              version: "1.0",
              sourceType: "builtin",
              sourcePath: "/specs/agents/development/implementer/agent.yaml",
              relativePath: "agents/development/implementer/agent.yaml",
              updatedAt: "2026-04-09T00:00:00Z",
              summary: "Implementation agent",
            },
          ],
        };
      }
      return { ok: true, json: async () => [] };
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    window.localStorage.clear();
    cleanup();
  });

  function renderFilterPanel() {
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={qc}>
        {createAppTestRouter({
          initialPath: "/",
          routes: [
            { path: "/", component: () => <div>home</div> },
            { path: "/specs/library/$entryId", component: () => <div data-testid="library-review">review</div> },
          ],
          rootComponent: ({ children }) => (
            <SpecsWorkspaceProvider>
              <SpecsPanel onClose={onClose} />
              {children}
            </SpecsWorkspaceProvider>
          ),
        })}
      </QueryClientProvider>
    );
  }

  it("shows all entries in merged list under default All filter with type and stability badges", async () => {
    renderFilterPanel();

    // Wait for library data to load
    await waitFor(() => {
      expect(screen.getByText("secrets-manager")).toBeDefined();
    });

    // All three entries visible under All filter
    expect(screen.getByText("secrets-manager")).toBeDefined();
    expect(screen.getByText("demo")).toBeDefined();
    expect(screen.getByText("implementer")).toBeDefined();

    // Filter chips exist
    expect(screen.getByTestId("filter-all")).toBeDefined();
    expect(screen.getByTestId("filter-apps")).toBeDefined();
    expect(screen.getByTestId("filter-rigs")).toBeDefined();
    expect(screen.getByTestId("filter-agents")).toBeDefined();

    // Service-backed rig shows APP badge and summary mentioning specialist
    const appRow = screen.getByTestId("library-entry-app-1");
    expect(appRow.textContent).toContain("APP");
    expect(appRow.textContent).toContain("specialist");

    // Builtin launch-path rig shows Stable badge
    const rigRow = screen.getByTestId("library-entry-rig-1");
    expect(rigRow.textContent).toContain("Stable");
  });

  it("clicking Apps filter shows only service-backed rigs", async () => {
    renderFilterPanel();

    await waitFor(() => {
      expect(screen.getByText("secrets-manager")).toBeDefined();
    });

    // Click Apps filter
    fireEvent.click(screen.getByTestId("filter-apps"));

    // Only the app entry should be visible
    await waitFor(() => {
      expect(screen.getByText("secrets-manager")).toBeDefined();
      expect(screen.queryByText("demo")).toBeNull();
      expect(screen.queryByText("implementer")).toBeNull();
    });
  });
});

describe("SpecsPanel Workflows filter chip (Workflows in Spec Library v0)", () => {
  const origFetch = globalThis.fetch;
  const mockFetch2 = vi.fn();

  beforeEach(() => {
    globalThis.fetch = mockFetch2 as unknown as typeof fetch;
    mockFetch2.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/specs/library") && !url.includes("kind=")) {
        return {
          ok: true,
          json: async () => [
            {
              id: "rig-1",
              kind: "rig",
              name: "demo",
              version: "0.2",
              sourceType: "builtin",
              sourcePath: "/specs/rigs/launch/demo/rig.yaml",
              relativePath: "rigs/launch/demo/rig.yaml",
              updatedAt: "2026-04-09T00:00:00Z",
            },
            {
              id: "agent-1",
              kind: "agent",
              name: "implementer",
              version: "1.0",
              sourceType: "builtin",
              sourcePath: "/specs/agents/development/implementer/agent.yaml",
              relativePath: "agents/development/implementer/agent.yaml",
              updatedAt: "2026-04-09T00:00:00Z",
            },
            {
              id: "workflow:rsi-v2-hot-potato:1",
              kind: "workflow",
              name: "rsi-v2-hot-potato",
              version: "1",
              sourceType: "builtin",
              sourcePath: "/builtins/workflow-specs/rsi-v2-hot-potato.yaml",
              relativePath: "rsi-v2-hot-potato.yaml",
              updatedAt: "2026-05-04T00:00:00Z",
              isBuiltIn: true,
              rolesCount: 3,
              stepsCount: 4,
              terminalTurnRule: "hot_potato",
              targetRig: null,
            },
          ],
        };
      }
      if (typeof url === "string" && url.includes("/api/specs/library") && url.includes("kind=")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    window.localStorage.clear();
    cleanup();
  });

  function renderFilterPanel() {
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={qc}>
        {createAppTestRouter({
          initialPath: "/",
          routes: [
            { path: "/", component: () => <div>home</div> },
            { path: "/specs/library/$entryId", component: () => <div data-testid="library-review">review</div> },
          ],
          rootComponent: ({ children }) => (
            <SpecsWorkspaceProvider>
              <SpecsPanel onClose={onClose} />
              {children}
            </SpecsWorkspaceProvider>
          ),
        })}
      </QueryClientProvider>
    );
  }

  it("renders the Workflows filter chip and a workflow row with WORKFLOW badge", async () => {
    renderFilterPanel();
    await waitFor(() => expect(screen.getByText("rsi-v2-hot-potato")).toBeDefined());
    expect(screen.getByTestId("filter-workflows")).toBeDefined();
    const wfRow = screen.getByTestId("library-entry-workflow:rsi-v2-hot-potato:1");
    expect(wfRow.textContent).toContain("WORKFLOW");
  });

  it("clicking Workflows filter shows only workflow entries", async () => {
    renderFilterPanel();
    await waitFor(() => expect(screen.getByText("rsi-v2-hot-potato")).toBeDefined());
    fireEvent.click(screen.getByTestId("filter-workflows"));
    await waitFor(() => {
      expect(screen.getByText("rsi-v2-hot-potato")).toBeDefined();
      expect(screen.queryByText("demo")).toBeNull();
      expect(screen.queryByText("implementer")).toBeNull();
    });
  });
});
