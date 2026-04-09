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

    // Draft label shows immediately (before daemon review loads)
    expect(screen.getByText("demo-rig")).toBeDefined();
    // Tabs should be present
    expect(screen.getByTestId("tab-topology")).toBeDefined();
    expect(screen.getByTestId("tab-configuration")).toBeDefined();
    expect(screen.getByTestId("tab-yaml")).toBeDefined();
    // YAML tab shows raw content
    fireEvent.click(screen.getByTestId("tab-yaml"));
    await waitFor(() => {
      expect(screen.getByTestId("rig-spec-yaml").textContent).toContain('agent_ref: "local:agents/lead"');
    });
  });

  it("draft review of a service-backed rig does not show environment tab", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentRigDraft, JSON.stringify({
      id: "rig-svc",
      kind: "rig",
      label: "svc-rig",
      yaml: [
        'version: "0.2"',
        "name: svc-rig",
        "services:",
        "  kind: compose",
        "  compose_file: svc.compose.yaml",
        "  wait_for:",
        '    - url: http://127.0.0.1:8200/health',
        "pods:",
        "  - id: dev",
        "    members:",
        '      - id: impl',
        '        agent_ref: "local:agents/impl"',
        "    edges: []",
      ].join("\n"),
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("rig-spec-review")).toBeDefined();
    });

    // Standard tabs present
    expect(screen.getByTestId("tab-topology")).toBeDefined();
    expect(screen.getByTestId("tab-configuration")).toBeDefined();
    expect(screen.getByTestId("tab-yaml")).toBeDefined();
    // Environment tab must NOT appear in draft/open-file review
    expect(screen.queryByTestId("tab-environment")).toBeNull();
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
