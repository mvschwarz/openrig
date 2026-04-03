import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AgentSpecValidateFlow } from "../src/components/AgentSpecValidateFlow.js";
import { SpecsWorkspaceProvider, SPECS_WORKSPACE_STORAGE_KEYS } from "../src/components/SpecsWorkspace.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function renderFlow() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/agents/validate", component: AgentSpecValidateFlow },
        { path: "/specs", component: () => <div data-testid="specs-page">specs</div> },
      ],
      initialPath: "/agents/validate",
      rootComponent: ({ children }) => <SpecsWorkspaceProvider>{children}</SpecsWorkspaceProvider>,
    })
  );
}

describe("AgentSpecValidateFlow", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it("renders the validation workspace", async () => {
    renderFlow();

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-validate-flow")).toBeDefined();
    });

    expect(screen.getByText("VALIDATE AGENT")).toBeDefined();
    expect(screen.getByTestId("agent-spec-yaml-input")).toBeDefined();
    expect(screen.getByTestId("agent-spec-validate-btn")).toBeDefined();
  });

  it("hydrates the editor from the current Specs agent draft", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentAgentDraft, JSON.stringify({
      id: "agent-current",
      kind: "agent",
      label: "helper",
      yaml: "name: helper\nruntime: codex\n",
      updatedAt: Date.now(),
    }));

    renderFlow();

    await waitFor(() => {
      expect((screen.getByTestId("agent-spec-yaml-input") as HTMLTextAreaElement).value).toBe("name: helper\nruntime: codex\n");
    });
  });

  it("posts yaml to the agents validate route and shows success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, errors: [] }),
    });

    renderFlow();

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-yaml-input")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("agent-spec-yaml-input"), {
      target: { value: "name: helper\nruntime: codex\n" },
    });
    fireEvent.click(screen.getByTestId("agent-spec-validate-btn"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/agents/validate", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: "name: helper\nruntime: codex\n",
      }));
      expect(screen.getByTestId("agent-spec-valid")).toBeDefined();
    });
  });

  it("shows returned validation errors", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ valid: false, errors: ["missing runtime"] }),
    });

    renderFlow();

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-yaml-input")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("agent-spec-yaml-input"), {
      target: { value: "name: helper\n" },
    });
    fireEvent.click(screen.getByTestId("agent-spec-validate-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-invalid").textContent).toContain("missing runtime");
    });
  });

  it("does not render a page-local Specs back button", async () => {
    renderFlow();

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-validate-flow")).toBeDefined();
    });

    expect(screen.queryByText("← Specs")).toBeNull();
  });
});
