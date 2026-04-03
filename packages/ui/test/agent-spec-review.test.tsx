import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AgentSpecReview } from "../src/components/AgentSpecReview.js";
import { SpecsWorkspaceProvider, SPECS_WORKSPACE_STORAGE_KEYS } from "../src/components/SpecsWorkspace.js";

function renderReview() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/specs/agent", component: AgentSpecReview },
        { path: "/agents/validate", component: () => <div data-testid="agent-validate-route">validate</div> },
      ],
      initialPath: "/specs/agent",
      rootComponent: ({ children }) => <SpecsWorkspaceProvider>{children}</SpecsWorkspaceProvider>,
    }),
  );
}

describe("AgentSpecReview", () => {
  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it("renders an empty review state when no agent draft exists", async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-review-empty")).toBeDefined();
    });

    expect(screen.getByText("No AgentSpec Selected")).toBeDefined();
  });

  it("renders a read-only summary and yaml preview for the current agent draft", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentAgentDraft, JSON.stringify({
      id: "agent-demo",
      kind: "agent",
      label: "qa",
      yaml: [
        "name: qa",
        'version: "1.0.0"',
        "resources:",
        "  skills: []",
        "profiles:",
        "  default:",
        "    uses:",
        "      skills: []",
        "  review:",
        "    uses:",
        "      skills: []",
      ].join("\n"),
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-review")).toBeDefined();
    });

    expect(screen.getByText("qa")).toBeDefined();
    expect(screen.getByText("AgentSpec")).toBeDefined();
    expect(screen.getByTestId("agent-spec-summary-version").textContent).toContain("1.0.0");
    expect(screen.getByTestId("agent-spec-summary-profiles").textContent).toContain("2");
    expect(screen.getByTestId("agent-spec-summary-skills").textContent).toContain("0");
    expect(screen.getByTestId("agent-spec-yaml").textContent).toContain('version: "1.0.0"');
  });

  it("links the review surface into the validation flow", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentAgentDraft, JSON.stringify({
      id: "agent-demo",
      kind: "agent",
      label: "qa",
      yaml: "name: qa\nprofiles:\n  default:\n",
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByText("Open In Validate")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Open In Validate"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-validate-route")).toBeDefined();
    });
  });
});
