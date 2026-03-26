import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { PackageInstallFlow } from "../src/components/PackageInstallFlow.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VALID_MANIFEST = {
  name: "test-pkg",
  version: "1.0.0",
  summary: "A test package",
  runtimes: ["claude-code", "codex"],
  exportCounts: { skills: 2, guidance: 1, agents: 0, hooks: 1, mcp: 0 },
  roles: [{ name: "dev", description: "Developer role" }],
  requirements: { cliTools: [{ name: "jq" }], systemPackages: [] },
};

const PLAN_ENTRIES = [
  { exportType: "skill", exportName: "tool/SKILL.md", classification: "safe_projection", targetPath: "/repo/.claude/skills/tool/SKILL.md", deferred: false, policyStatus: "approved" },
  { exportType: "guidance", exportName: "standards", classification: "managed_merge", targetPath: "/repo/CLAUDE.md", deferred: false, policyStatus: "rejected", deferReason: undefined, conflict: undefined },
  { exportType: "hook", exportName: "hooks/pre-commit.sh", classification: "config_mutation", targetPath: "", deferred: true, policyStatus: "deferred", deferReason: "Hooks deferred to Phase 5" },
];

function mockValidateSuccess() {
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200,
    json: async () => ({ valid: true, manifest: VALID_MANIFEST }),
  });
}

function mockValidateFailure() {
  fetchMock.mockResolvedValueOnce({
    ok: false, status: 400,
    json: async () => ({ valid: false, errors: ["name is required", "version is required"] }),
  });
}

function mockPlanSuccess(overrides?: { entries?: unknown[]; conflicts?: number; actionable?: number; rejected?: number }) {
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200,
    json: async () => ({
      packageName: "test-pkg",
      packageVersion: "1.0.0",
      entries: overrides?.entries ?? PLAN_ENTRIES,
      actionable: overrides?.actionable ?? 1,
      deferred: 1,
      conflicts: overrides?.conflicts ?? 0,
      noOps: 0,
      rejected: overrides?.rejected ?? 1,
    }),
  });
}

function mockInstallSuccess() {
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 201,
    json: async () => ({
      installId: "inst-123",
      packageId: "pkg-1",
      packageName: "test-pkg",
      applied: [{ exportType: "skill", action: "copy", targetPath: "/repo/.claude/skills/tool/SKILL.md" }],
      deferred: [{ exportType: "hook", exportName: "pre-commit", deferReason: "Deferred to Phase 5" }],
      verification: { passed: true },
    }),
  });
}

function renderFlow() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/packages/install", component: PackageInstallFlow },
        { path: "/packages", component: () => <div data-testid="packages-page">Packages</div> },
        { path: "/packages/$packageId", component: () => <div data-testid="package-detail-page">Detail</div> },
      ],
      initialPath: "/packages/install",
    })
  );
}

async function advanceToStep(target: "validated" | "configure" | "planned" | "done") {
  renderFlow();

  // Enter path
  await waitFor(() => expect(screen.getByTestId("source-path-input")).toBeTruthy());
  act(() => { fireEvent.change(screen.getByTestId("source-path-input"), { target: { value: "/test/pkg" } }); });

  if (target === "validated" || target === "configure" || target === "planned" || target === "done") {
    mockValidateSuccess();
    act(() => { fireEvent.click(screen.getByTestId("validate-btn")); });
    await waitFor(() => expect(screen.getByTestId("manifest-summary")).toBeTruthy());
  }

  if (target === "configure" || target === "planned" || target === "done") {
    act(() => { fireEvent.click(screen.getByTestId("configure-btn")); });
    await waitFor(() => expect(screen.getByTestId("configure-step")).toBeTruthy());
  }

  if (target === "planned" || target === "done") {
    mockPlanSuccess();
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("plan-preview")).toBeTruthy());
  }

  if (target === "done") {
    mockInstallSuccess();
    act(() => { fireEvent.click(screen.getByTestId("apply-btn")); });
    await waitFor(() => expect(screen.getByTestId("install-result")).toBeTruthy());
  }
}

describe("PackageInstallFlow", () => {
  // Test 1: Step indicator shows correct active step
  it("step indicator shows correct active step", async () => {
    renderFlow();
    await waitFor(() => {
      const step1 = screen.getByTestId("step-1");
      expect(step1.className).toContain("bg-foreground/10");
    });
  });

  // Test 2: Enter step: input + disabled validate button
  it("enter step: input field and disabled validate button when empty", async () => {
    renderFlow();
    await waitFor(() => {
      expect(screen.getByTestId("source-path-input")).toBeTruthy();
      expect(screen.getByTestId("validate-btn")).toHaveProperty("disabled", true);
    });

    act(() => {
      fireEvent.change(screen.getByTestId("source-path-input"), { target: { value: "/some/path" } });
    });

    expect(screen.getByTestId("validate-btn")).toHaveProperty("disabled", false);
  });

  // Test 3: Validate step shows manifest summary
  it("validate step shows manifest summary", async () => {
    await advanceToStep("validated");

    expect(screen.getByText("test-pkg")).toBeTruthy();
    expect(screen.getByText("v1.0.0")).toBeTruthy();
    expect(screen.getByText("A test package")).toBeTruthy();
  });

  // Test 4: Configure step shows runtime picker, target root, allow-merge toggle
  it("configure step shows runtime picker, target root, and allow-merge toggle", async () => {
    await advanceToStep("configure");

    expect(screen.getByTestId("runtime-select")).toBeTruthy();
    expect(screen.getByTestId("target-root-input")).toBeTruthy();
    expect(screen.getByTestId("allow-merge-toggle")).toBeTruthy();
  });

  // Test 5: Plan step shows classified entries with correct policy status
  it("plan step shows entries with policy status colors", async () => {
    await advanceToStep("planned");

    const entries = screen.getAllByTestId("plan-entry");
    expect(entries.length).toBe(3);
    expect(entries[0]!.getAttribute("data-policy-status")).toBe("approved");
    expect(entries[1]!.getAttribute("data-policy-status")).toBe("rejected");
    expect(entries[2]!.getAttribute("data-policy-status")).toBe("deferred");
  });

  // Test 6: Plan step shows deferred items with reasons
  it("plan step shows deferred reasons", async () => {
    await advanceToStep("planned");

    const entries = screen.getAllByTestId("plan-entry");
    const deferredEntry = entries[2]!;
    expect(deferredEntry.textContent).toContain("Hooks deferred to Phase 5");
  });

  // Test 7: Plan step conflicts block Apply button
  it("conflicts block Apply button", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByTestId("source-path-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("source-path-input"), { target: { value: "/test/pkg" } }); });

    mockValidateSuccess();
    act(() => { fireEvent.click(screen.getByTestId("validate-btn")); });
    await waitFor(() => expect(screen.getByTestId("manifest-summary")).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId("configure-btn")); });
    await waitFor(() => expect(screen.getByTestId("configure-step")).toBeTruthy());

    mockPlanSuccess({
      conflicts: 1,
      entries: [{ exportType: "skill", exportName: "tool", classification: "safe_projection", targetPath: "/x", deferred: false, policyStatus: "conflict", conflict: { existingPath: "/x", reason: "exists" } }],
    });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("plan-preview")).toBeTruthy());

    expect(screen.getByTestId("conflict-warning")).toBeTruthy();
    expect(screen.getByTestId("apply-btn")).toHaveProperty("disabled", true);
  });

  // Test 8: Apply success shows installId + counts
  it("apply success shows installId and counts", async () => {
    await advanceToStep("done");

    expect(screen.getByTestId("result-install-id").textContent).toBe("inst-123");
    expect(screen.getByTestId("result-applied").textContent).toBe("1");
    expect(screen.getByTestId("result-deferred").textContent).toBe("1");
    expect(screen.getByTestId("result-verified").textContent).toBe("PASS");
  });

  // Test 9: Error with TRY AGAIN
  it("error at any step shows alert with TRY AGAIN", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByTestId("source-path-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("source-path-input"), { target: { value: "/bad" } }); });

    mockValidateFailure();
    act(() => { fireEvent.click(screen.getByTestId("validate-btn")); });
    await waitFor(() => expect(screen.getByTestId("install-errors")).toBeTruthy());

    expect(screen.getByTestId("try-again-btn")).toBeTruthy();
    act(() => { fireEvent.click(screen.getByTestId("try-again-btn")); });

    await waitFor(() => expect(screen.getByTestId("source-path-input")).toBeTruthy());
  });

  // Test 10: Role dropdown populated + selecting role sends roleName in plan request
  it("role selection sends roleName in plan request", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByTestId("source-path-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("source-path-input"), { target: { value: "/test/pkg" } }); });

    mockValidateSuccess();
    act(() => { fireEvent.click(screen.getByTestId("validate-btn")); });
    await waitFor(() => expect(screen.getByTestId("manifest-summary")).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId("configure-btn")); });
    await waitFor(() => expect(screen.getByTestId("configure-step")).toBeTruthy());

    // Verify role dropdown is populated
    const roleSelect = screen.getByTestId("role-select");
    expect(roleSelect.innerHTML).toContain("dev");
    expect(roleSelect.innerHTML).toContain("Developer role");

    // Select the dev role
    act(() => { fireEvent.change(roleSelect, { target: { value: "dev" } }); });

    // Plan — mock returns filtered entries (only skill from dev role, no other exports)
    mockPlanSuccess({
      entries: [
        { exportType: "skill", exportName: "tool/SKILL.md", classification: "safe_projection", targetPath: "/x", deferred: false, policyStatus: "approved" },
      ],
      actionable: 1,
      rejected: 0,
    });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("plan-preview")).toBeTruthy());

    // Verify plan was called with roleName
    const planCall = fetchMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/api/packages/plan")
    );
    expect(planCall).toBeTruthy();
    const planBody = JSON.parse((planCall![1] as { body: string }).body);
    expect(planBody.roleName).toBe("dev");

    // Verify filtered entries rendered (only 1 entry, not the full 3)
    const entries = screen.getAllByTestId("plan-entry");
    expect(entries.length).toBe(1);
  });

  // Test 11: Allow-merge toggle affects plan classification
  it("allow-merge toggle affects plan policy status", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByTestId("source-path-input")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("source-path-input"), { target: { value: "/test/pkg" } }); });

    mockValidateSuccess();
    act(() => { fireEvent.click(screen.getByTestId("validate-btn")); });
    await waitFor(() => expect(screen.getByTestId("manifest-summary")).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId("configure-btn")); });
    await waitFor(() => expect(screen.getByTestId("configure-step")).toBeTruthy());

    // Enable allow-merge
    act(() => { fireEvent.click(screen.getByTestId("allow-merge-toggle")); });

    // Plan with allow-merge — guidance now approved
    mockPlanSuccess({
      entries: [
        { exportType: "skill", exportName: "tool/SKILL.md", classification: "safe_projection", targetPath: "/x", deferred: false, policyStatus: "approved" },
        { exportType: "guidance", exportName: "standards", classification: "managed_merge", targetPath: "/y", deferred: false, policyStatus: "approved" },
      ],
      actionable: 2,
      rejected: 0,
    });
    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("plan-preview")).toBeTruthy());

    const entries = screen.getAllByTestId("plan-entry");
    expect(entries[1]!.getAttribute("data-policy-status")).toBe("approved");
  });

  // Test 12: Configure shows requirements
  it("configure step shows requirements from validate response", async () => {
    await advanceToStep("configure");

    expect(screen.getByTestId("requirements-section")).toBeTruthy();
    expect(screen.getByTestId("requirements-section").textContent).toContain("jq");
  });

  // Test 13: Done state detail link navigates to package detail
  it("done state: detail link navigates to package detail", async () => {
    await advanceToStep("done");

    const detailLink = screen.getByTestId("detail-link");
    expect(detailLink).toHaveProperty("disabled", false);

    act(() => { fireEvent.click(detailLink); });

    await waitFor(() => {
      expect(screen.getByTestId("package-detail-page")).toBeTruthy();
    });
  });
});
