import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { BootstrapWizard } from "../src/components/BootstrapWizard.js";
import { RequirementsPanel, type RequirementResult } from "../src/components/RequirementsPanel.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWizard() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/bootstrap", component: BootstrapWizard },
        { path: "/rigs/$rigId", component: () => <div data-testid="rig-page">Rig</div> },
      ],
      initialPath: "/bootstrap",
    })
  );
}

const PLAN_RESPONSE = {
  runId: "run-1",
  status: "planned",
  stages: [
    { stage: "resolve_spec", status: "ok", detail: {} },
    { stage: "verify_runtimes", status: "ok", detail: {} },
    { stage: "probe_requirements", status: "ok", detail: {
      probed: 2,
      results: [
        { name: "git", kind: "cli_tool", status: "installed", detectedPath: "/usr/bin/git", version: null },
        { name: "rg", kind: "cli_tool", status: "missing", detectedPath: null, version: null },
      ],
    }},
    { stage: "build_install_plan", status: "ok", detail: {
      autoApprovable: 1, manualOnly: 0, alreadyInstalled: 1,
      actions: [{ key: "external_install:cli_tool:rg", requirementName: "rg", classification: "auto_approvable", commandPreview: "brew install 'rg'", provider: "homebrew" }],
    }},
  ],
  actionKeys: ["external_install:cli_tool:rg"],
  errors: [],
  warnings: [],
};

const APPLY_RESPONSE = {
  runId: "run-2",
  status: "completed",
  rigId: "rig-1",
  stages: [{ stage: "import_rig", status: "ok", detail: {} }],
  errors: [],
  warnings: [],
};

describe("BootstrapWizard", () => {
  // T1: enter step with input
  it("renders enter step with spec input", async () => {
    renderWizard();
    await waitFor(() => {
      expect(screen.getByTestId("step-enter")).toBeTruthy();
      expect(screen.getByTestId("spec-input")).toBeTruthy();
      expect(screen.getByTestId("plan-btn")).toBeTruthy();
    });
  });

  // T2: plan shows stages
  it("plan shows stages with status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => PLAN_RESPONSE });
    renderWizard();

    await waitFor(() => expect(screen.getByTestId("spec-input")).toBeTruthy());

    act(() => { fireEvent.change(screen.getByTestId("spec-input"), { target: { value: "/tmp/rig.yaml" } }); });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("step-planned")).toBeTruthy();
      expect(screen.getByTestId("stage-list")).toBeTruthy();
    });

    const rows = screen.getAllByTestId("stage-row");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Step indicator should show REVIEW (step 3), not PLAN (step 2)
    const indicator = screen.getByTestId("step-indicator");
    expect(indicator.textContent).toContain("3 REVIEW");
  });

  // T3: requirements panel shows all 4 statuses with correct colors
  it("requirements panel renders installed/missing/unsupported/unknown with correct dot colors", () => {
    const results: RequirementResult[] = [
      { name: "git", kind: "cli_tool", status: "installed", version: null, detectedPath: "/usr/bin/git" },
      { name: "rg", kind: "cli_tool", status: "missing", version: null, detectedPath: null },
      { name: "libssl", kind: "system_package", status: "unsupported", version: null, detectedPath: null },
      { name: "slow", kind: "cli_tool", status: "unknown", version: null, detectedPath: null },
    ];
    render(<RequirementsPanel results={results} />);

    const dots = screen.getAllByTestId("requirement-dot");
    expect(dots).toHaveLength(4);
    expect(dots[0]!.className).toContain("bg-success");
    expect(dots[1]!.className).toContain("bg-destructive");
    expect(dots[2]!.className).toContain("bg-warning");
    expect(dots[3]!.className).toContain("bg-warning");

    const statuses = screen.getAllByTestId("requirement-status");
    expect(statuses[0]!.textContent).toContain("OK");
    expect(statuses[1]!.textContent).toContain("MISSING");
    expect(statuses[2]!.textContent).toContain("MANUAL");
    expect(statuses[3]!.textContent).toContain("UNKNOWN");
  });

  // T4: apply sends approvedActionKeys in POST body
  it("apply sends approvedActionKeys matching selected actions", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => PLAN_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => APPLY_RESPONSE });

    renderWizard();

    await waitFor(() => expect(screen.getByTestId("spec-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("spec-input"), { target: { value: "/tmp/rig.yaml" } }); });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });

    await waitFor(() => expect(screen.getByTestId("apply-btn")).toBeTruthy());
    act(() => { fireEvent.click(screen.getByTestId("apply-btn")); });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const applyCall = fetchMock.mock.calls[1]!;
    const body = JSON.parse(applyCall[1].body);
    expect(body.approvedActionKeys).toEqual(["external_install:cli_tool:rg"]);
  });

  // T5: done state with rigId + link
  it("done state shows rigId and view rig button", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => PLAN_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => APPLY_RESPONSE });

    renderWizard();
    await waitFor(() => expect(screen.getByTestId("spec-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("spec-input"), { target: { value: "/tmp/rig.yaml" } }); });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("apply-btn")).toBeTruthy());
    act(() => { fireEvent.click(screen.getByTestId("apply-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("step-done")).toBeTruthy();
      expect(screen.getByTestId("result-rig-id").textContent).toContain("rig-1");
      expect(screen.getByTestId("view-rig-btn")).toBeTruthy();
    });
  });

  // T6: error state + try again
  it("error state shows error and try again button", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    renderWizard();
    await waitFor(() => expect(screen.getByTestId("spec-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("spec-input"), { target: { value: "/tmp/rig.yaml" } }); });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("step-error")).toBeTruthy();
    });

    expect(screen.getByTestId("try-again-btn")).toBeTruthy();
    act(() => { fireEvent.click(screen.getByTestId("try-again-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("step-enter")).toBeTruthy();
    });
  });

  // T8b: applying step shows stage checklist from plan
  it("applying step renders stage checklist from plan", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => PLAN_RESPONSE })
      .mockImplementationOnce(() => new Promise(() => {})); // Never resolves — stays in applying

    renderWizard();
    await waitFor(() => expect(screen.getByTestId("spec-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("spec-input"), { target: { value: "/tmp/rig.yaml" } }); });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("apply-btn")).toBeTruthy());
    act(() => { fireEvent.click(screen.getByTestId("apply-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("step-applying")).toBeTruthy();
      expect(screen.getByTestId("applying-checklist")).toBeTruthy();
    });

    // Should show stages from the plan + apply-only stages
    const checklist = screen.getByTestId("applying-checklist");
    expect(checklist.textContent).toContain("resolve_spec");
    expect(checklist.textContent).toContain("import_rig");
  });

  // T9: apply button disabled when plan is blocked
  it("apply button disabled when plan has blocked status", async () => {
    const blockedPlan = {
      ...PLAN_RESPONSE,
      stages: [
        ...PLAN_RESPONSE.stages.slice(0, 3),
        { stage: "build_install_plan", status: "blocked", detail: {
          autoApprovable: 0, manualOnly: 1, alreadyInstalled: 0,
          actions: [{ key: "external_install:system_package:libssl", requirementName: "libssl", classification: "manual_only", commandPreview: null, provider: null }],
        }},
      ],
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => blockedPlan });

    renderWizard();
    await waitFor(() => expect(screen.getByTestId("spec-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("spec-input"), { target: { value: "/tmp/rig.yaml" } }); });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });

    await waitFor(() => {
      const btn = screen.getByTestId("apply-btn");
      expect(btn.hasAttribute("disabled")).toBe(true);
    });
    expect(screen.getByTestId("blocked-warning")).toBeTruthy();
  });

  // T10: apply button disabled when actionable installs exist but none selected
  it("apply button disabled when no actions selected", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => PLAN_RESPONSE });

    renderWizard();
    await waitFor(() => expect(screen.getByTestId("spec-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("spec-input"), { target: { value: "/tmp/rig.yaml" } }); });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });

    await waitFor(() => expect(screen.getByTestId("apply-btn")).toBeTruthy());

    // Uncheck the auto-selected action
    const checkboxes = screen.getAllByRole("checkbox");
    const actionCheckbox = checkboxes.find((cb) => !(cb as HTMLInputElement).disabled && (cb as HTMLInputElement).checked);
    if (actionCheckbox) {
      act(() => { fireEvent.click(actionCheckbox); });
    }

    await waitFor(() => {
      const btn = screen.getByTestId("apply-btn");
      expect(btn.hasAttribute("disabled")).toBe(true);
    });
  });
});
