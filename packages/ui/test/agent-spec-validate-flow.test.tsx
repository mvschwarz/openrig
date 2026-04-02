import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AgentSpecValidateFlow } from "../src/components/AgentSpecValidateFlow.js";

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
    })
  );
}

describe("AgentSpecValidateFlow", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
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

  it("back button returns to the specs surface", async () => {
    renderFlow();

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-validate-flow")).toBeDefined();
    });

    fireEvent.click(screen.getByText("← Specs"));

    await waitFor(() => {
      expect(screen.getByTestId("specs-page")).toBeDefined();
    });
  });
});
