import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { RigSpecReview } from "../src/components/RigSpecReview.js";
import { SpecsWorkspaceProvider, SPECS_WORKSPACE_STORAGE_KEYS } from "../src/components/SpecsWorkspace.js";

function renderReview() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/specs/rig", component: RigSpecReview },
        { path: "/import", component: () => <div data-testid="import-route">import</div> },
        { path: "/bootstrap", component: () => <div data-testid="bootstrap-route">bootstrap</div> },
      ],
      initialPath: "/specs/rig",
      rootComponent: ({ children }) => <SpecsWorkspaceProvider>{children}</SpecsWorkspaceProvider>,
    }),
  );
}

describe("RigSpecReview", () => {
  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it("renders an empty review state when no rig draft exists", async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("rig-spec-review-empty")).toBeDefined();
    });

    expect(screen.getByText("No RigSpec Selected")).toBeDefined();
  });

  it("renders a read-only summary and yaml preview for the current rig draft", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentRigDraft, JSON.stringify({
      id: "rig-demo",
      kind: "rig",
      label: "demo-rig",
      yaml: [
        'version: "0.2"',
        "name: demo-rig",
        "pods:",
        "  - id: orch",
        "    members:",
        '      - id: lead',
        '        agent_ref: "local:agents/lead"',
        "    edges: []",
        "  - id: dev",
        "    members:",
        '      - id: impl',
        '        agent_ref: "local:agents/impl"',
        "edges:",
        "  - kind: delegates_to",
      ].join("\n"),
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("rig-spec-review")).toBeDefined();
    });

    expect(screen.getByText("demo-rig")).toBeDefined();
    expect(screen.getByText("Pod-Aware RigSpec")).toBeDefined();
    expect(screen.getByTestId("rig-spec-summary-pods").textContent).toContain("2");
    expect(screen.getByTestId("rig-spec-summary-members").textContent).toContain("2");
    expect(screen.getByTestId("rig-spec-summary-edges").textContent).toContain("1");
    expect(screen.getByTestId("rig-spec-yaml").textContent).toContain('agent_ref: "local:agents/lead"');
  });

  it("links the review surface back into import and bootstrap flows", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentRigDraft, JSON.stringify({
      id: "rig-demo",
      kind: "rig",
      label: "demo-rig",
      yaml: "name: demo-rig\npods: []\n",
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByText("Open In Import")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Open In Import"));

    await waitFor(() => {
      expect(screen.getByTestId("import-route")).toBeDefined();
    });
  });
});
