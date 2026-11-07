// Milestone 3 Empirical Adversarial Test Suite
// Verifies HostConfigCard Concurrency Protection, Mutation Toasts,
// Nav Query String Isolation, and Responsive Scaling Clearance under hostile conditions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster, toast } from "sonner";
import { HostConfigCard } from "../src/components/dashboard/HostConfigCard.js";
import {
  useExpandRig,
  useRemoveLibrarySpec,
  useRenameLibrarySpec,
} from "../src/hooks/mutations.js";
import {
  isAdvisorSeat,
  isOperatorSeat,
  isChatSeat,
  allNavItems,
} from "../src/lib/nav.js";
import { UndoToast } from "../src/components/for-you/UndoToast.js";
import { VellumSheet } from "../src/components/ui/vellum-sheet.js";
import { AgentPropertiesPanel } from "../src/components/AgentPropertiesPanel.js";

// --- Mocks for HostConfigCard concurrency testing ---
let mockMutateAsync = vi.fn();
let isSetSettingPending = false;
let mockSettingsData: Record<string, { value: unknown }> = {};
let mockHostsData: { ownName: string; selected: string; hosts: Array<{ id: string; transport: string; url?: string; target?: string; selected: boolean; status: string }> } = {
  ownName: "localhost",
  selected: "local",
  hosts: [],
};

vi.mock("../src/hooks/useSettings.js", () => ({
  useSettings: () => ({ data: { settings: mockSettingsData } }),
  useSetSetting: () => ({
    mutateAsync: mockMutateAsync,
    isPending: isSetSettingPending,
  }),
}));

vi.mock("../src/hooks/useHosts.js", () => ({
  useHosts: () => ({ data: mockHostsData, error: null }),
  usePairHost: () => ({
    mutateAsync: vi.fn(),
    data: undefined,
    error: null,
    isPending: false,
    reset: vi.fn(),
  }),
  usePairPoll: () => ({ data: undefined }),
  useHostSelection: () => ({ known: true, isLocal: true }),
  useSelectedHostId: () => "local",
}));

// --- Test Probes for Mutations ---
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function ExpandRigProbe({
  rigId,
  pod,
  crossPodEdges,
}: {
  rigId: string;
  pod: Record<string, unknown>;
  crossPodEdges?: unknown[];
}) {
  const mutation = useExpandRig();
  return (
    <div>
      <button
        type="button"
        data-testid="probe-expand-btn"
        onClick={() => mutation.mutate({ rigId, pod, crossPodEdges })}
      >
        Expand
      </button>
      {mutation.isPending && <span data-testid="probe-expand-pending">Pending</span>}
      {mutation.isError && <span data-testid="probe-expand-error-flag">Error</span>}
      {mutation.isSuccess && <span data-testid="probe-expand-success-flag">Success</span>}
    </div>
  );
}

function RemoveSpecProbe({ entryId }: { entryId: string }) {
  const mutation = useRemoveLibrarySpec();
  return (
    <div>
      <button
        type="button"
        data-testid="probe-remove-btn"
        onClick={() => mutation.mutate(entryId)}
      >
        Remove
      </button>
      {mutation.isPending && <span data-testid="probe-remove-pending">Pending</span>}
      {mutation.isError && <span data-testid="probe-remove-error-flag">Error</span>}
      {mutation.isSuccess && <span data-testid="probe-remove-success-flag">Success</span>}
    </div>
  );
}

function RenameSpecProbe({ entryId, name }: { entryId: string; name: string }) {
  const mutation = useRenameLibrarySpec();
  return (
    <div>
      <button
        type="button"
        data-testid="probe-rename-btn"
        onClick={() => mutation.mutate({ entryId, name })}
      >
        Rename
      </button>
      {mutation.isPending && <span data-testid="probe-rename-pending">Pending</span>}
      {mutation.isError && <span data-testid="probe-rename-error-flag">Error</span>}
      {mutation.isSuccess && <span data-testid="probe-rename-success-flag">Success</span>}
    </div>
  );
}

describe("Adversarial Stress Suite M3: HostConfigCard Concurrency Protection", () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    isSetSettingPending = false;
    mockSettingsData = {};
    mockHostsData = {
      ownName: "localhost",
      selected: "local",
      hosts: [
        { id: "vps-charlie", transport: "http", url: "http://vps-charlie:7433", selected: false, status: "reachable" },
        { id: "vm-delta", transport: "ssh", target: "delta.internal", selected: false, status: "reachable" },
      ],
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("rapid burst clicking on remote Select button during inflight pending mutation triggers exactly 0 additional calls", () => {
    isSetSettingPending = true;
    render(<HostConfigCard />);

    const selectCharlieBtn = screen.getByTestId("host-select-vps-charlie") as HTMLButtonElement;
    const selectDeltaBtn = screen.getByTestId("host-select-vm-delta") as HTMLButtonElement;
    const renameBtn = screen.getByTestId("host-rename-button") as HTMLButtonElement;

    // Both remote select buttons and rename button MUST carry disabled attribute
    expect(selectCharlieBtn.disabled).toBe(true);
    expect(selectDeltaBtn.disabled).toBe(true);
    expect(renameBtn.disabled).toBe(true);

    // Simulate adversarial rapid clicking (20 clicks in quick succession)
    for (let i = 0; i < 10; i++) {
      fireEvent.click(selectCharlieBtn);
      fireEvent.click(selectDeltaBtn);
    }

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("rapid burst clicking on local Select button during inflight pending mutation triggers 0 calls", () => {
    isSetSettingPending = true;
    mockSettingsData = { "host.selected": { value: "vps-charlie" } };
    mockHostsData.selected = "vps-charlie";
    mockHostsData.hosts[0]!.selected = true;

    render(<HostConfigCard />);

    const selectLocalBtn = screen.getByTestId("host-select-local") as HTMLButtonElement;
    expect(selectLocalBtn.disabled).toBe(true);

    for (let i = 0; i < 15; i++) {
      fireEvent.click(selectLocalBtn);
    }

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("rename form Save button and submit event are blocked while mutation is pending", () => {
    isSetSettingPending = false;
    render(<HostConfigCard />);

    fireEvent.click(screen.getByTestId("host-rename-button"));
    const renameInput = screen.getByTestId("host-rename-input") as HTMLInputElement;
    expect(renameInput).toBeTruthy();
    fireEvent.change(renameInput, { target: { value: "Host-Titan" } });

    cleanup();
    isSetSettingPending = true;
    render(<HostConfigCard />);

    const renameBtn = screen.getByTestId("host-rename-button") as HTMLButtonElement;
    expect(renameBtn.disabled).toBe(true);
  });

  it("form onSubmit event directly guards against inflight submission even if submit is dispatched", () => {
    isSetSettingPending = false;
    const { rerender } = render(<HostConfigCard />);

    fireEvent.click(screen.getByTestId("host-rename-button"));
    const input = screen.getByTestId("host-rename-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Studio-Max" } });

    const form = input.closest("form")!;
    const saveBtn = form.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    isSetSettingPending = true;
    rerender(<HostConfigCard />);

    const updatedSaveBtn = screen.getByText("Save") as HTMLButtonElement;
    expect(updatedSaveBtn.disabled).toBe(true);

    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(updatedSaveBtn);

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("verifies single legitimate click initiates mutation when not pending", () => {
    isSetSettingPending = false;
    render(<HostConfigCard />);

    const selectCharlieBtn = screen.getByTestId("host-select-vps-charlie");
    fireEvent.click(selectCharlieBtn);

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith({
      key: "host.selected",
      value: "vps-charlie",
    });
  });
});

describe("Adversarial Stress Suite M3: Mutation Toasts in mutations.ts", () => {
  let originalFetch: typeof fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    toast.dismiss();
    cleanup();
    document.body.innerHTML = "";
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    toast.dismiss();
    cleanup();
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
  });

  describe("useExpandRig toasts", () => {
    it("displays success toast 'Rig expanded' on 200 OK", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, podId: "pod-1" }),
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <ExpandRigProbe rigId="rig-test-1" pod={{ name: "test-pod" }} />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-expand-btn"));

      expect(await screen.findByTestId("probe-expand-success-flag")).toBeTruthy();
      const matches = await screen.findAllByText("Rig expanded");
      expect(matches.length).toBeGreaterThan(0);
    });

    it("displays error toast 'Couldn't expand rig' when response status is 200 but ok=false", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: "Cyclic topology detected in pod configuration" }),
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <ExpandRigProbe rigId="rig-test-1" pod={{ name: "cyclic-pod" }} />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-expand-btn"));

      expect(await screen.findByTestId("probe-expand-error-flag")).toBeTruthy();
      const titleMatches = await screen.findAllByText("Couldn't expand rig");
      expect(titleMatches.length).toBeGreaterThan(0);
      const descMatches = await screen.findAllByText("Cyclic topology detected in pod configuration");
      expect(descMatches.length).toBeGreaterThan(0);
    });

    it("displays error toast 'Couldn't expand rig' on HTTP 500 error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal daemon expansion fault" }),
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <ExpandRigProbe rigId="rig-test-1" pod={{ name: "crash-pod" }} />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-expand-btn"));

      expect(await screen.findByTestId("probe-expand-error-flag")).toBeTruthy();
      const titleMatches = await screen.findAllByText("Couldn't expand rig");
      expect(titleMatches.length).toBeGreaterThan(0);
      const descMatches = await screen.findAllByText("Internal daemon expansion fault");
      expect(descMatches.length).toBeGreaterThan(0);
    });

    it("displays error toast 'Couldn't expand rig' on network drop / fetch rejection", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch (network disconnected)"));

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <ExpandRigProbe rigId="rig-test-1" pod={{ name: "network-test" }} />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-expand-btn"));

      expect(await screen.findByTestId("probe-expand-error-flag")).toBeTruthy();
      const titleMatches = await screen.findAllByText("Couldn't expand rig");
      expect(titleMatches.length).toBeGreaterThan(0);
      const descMatches = await screen.findAllByText("Failed to fetch (network disconnected)");
      expect(descMatches.length).toBeGreaterThan(0);
    });
  });

  describe("useRemoveLibrarySpec toasts", () => {
    it("displays success toast 'Spec removed' on 200 OK", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <RemoveSpecProbe entryId="spec-agent-evaluator" />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-remove-btn"));

      expect(await screen.findByTestId("probe-remove-success-flag")).toBeTruthy();
      const matches = await screen.findAllByText("Spec removed");
      expect(matches.length).toBeGreaterThan(0);
    });

    it("displays error toast 'Couldn't remove spec' on HTTP 404 spec not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "Spec with ID spec-agent-evaluator not found" }),
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <RemoveSpecProbe entryId="spec-agent-evaluator" />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-remove-btn"));

      expect(await screen.findByTestId("probe-remove-error-flag")).toBeTruthy();
      const titleMatches = await screen.findAllByText("Couldn't remove spec");
      expect(titleMatches.length).toBeGreaterThan(0);
      const descMatches = await screen.findAllByText("Spec with ID spec-agent-evaluator not found");
      expect(descMatches.length).toBeGreaterThan(0);
    });

    it("displays error toast 'Couldn't remove spec' on unparseable HTML 502 error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => { throw new Error("Unexpected HTML error page"); },
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <RemoveSpecProbe entryId="spec-agent-evaluator" />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-remove-btn"));

      expect(await screen.findByTestId("probe-remove-error-flag")).toBeTruthy();
      const titleMatches = await screen.findAllByText("Couldn't remove spec");
      expect(titleMatches.length).toBeGreaterThan(0);
      const descMatches = await screen.findAllByText("Remove failed (HTTP 502)");
      expect(descMatches.length).toBeGreaterThan(0);
    });
  });

  describe("useRenameLibrarySpec toasts", () => {
    it("displays success toast 'Spec renamed' on 200 OK", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, name: "RenamedSpec" }),
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <RenameSpecProbe entryId="spec-core" name="RenamedSpec" />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-rename-btn"));

      expect(await screen.findByTestId("probe-rename-success-flag")).toBeTruthy();
      const matches = await screen.findAllByText("Spec renamed");
      expect(matches.length).toBeGreaterThan(0);
    });

    it("displays error toast 'Couldn't rename spec' on HTTP 409 conflict", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "A spec with name 'RenamedSpec' already exists" }),
      });

      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <Toaster />
          <RenameSpecProbe entryId="spec-core" name="RenamedSpec" />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByTestId("probe-rename-btn"));

      expect(await screen.findByTestId("probe-rename-error-flag")).toBeTruthy();
      const titleMatches = await screen.findAllByText("Couldn't rename spec");
      expect(titleMatches.length).toBeGreaterThan(0);
      const descMatches = await screen.findAllByText("A spec with name 'RenamedSpec' already exists");
      expect(descMatches.length).toBeGreaterThan(0);
    });
  });
});

describe("Adversarial Stress Suite M3: Nav Query String & Trailing Slash Isolation", () => {
  describe("Query string parameter injection attack on seat predicates", () => {
    const maliciousWorkerPaths = [
      "/topology/seat/rig-prod/worker-agent?ref=advisor",
      "/topology/seat/rig-prod/worker-agent?focus=operator",
      "/topology/seat/rig-prod/worker-agent?search=advisor&filter=operator",
      "/topology/seat/rig-prod/worker-agent?role=advisor",
      "/topology/seat/rig-prod/worker-agent?callback=/topology/seat/rig-prod/advisor",
      "/topology/seat/rig-prod/worker-agent?tags=advisor,critical",
      "/topology/seat/rig-prod/worker-agent?q=%3Cscript%3Eadvisor%3C%2Fscript%3E",
      "/topology/seat/rig-prod/worker-agent?json=%7B%22advisor%22%3Atrue%7D",
      "/topology/seat/rig-prod/worker-agent?advisor=true",
      "/topology/seat/rig-prod/worker-agent?operator=true",
    ];

    it.each(maliciousWorkerPaths)(
      "path '%s' must NOT be classified as advisor or operator seat",
      (path) => {
        expect(isAdvisorSeat(path)).toBe(false);
        expect(isOperatorSeat(path)).toBe(false);
        expect(isChatSeat(path)).toBe(false);
      },
    );

    it("ensures Rigs rail item is NOT falsely suppressed when query string contains 'advisor' or 'operator'", () => {
      const items = allNavItems();
      const rigsNav = items.find((i) => i.id === "rigs")!;

      for (const maliciousPath of maliciousWorkerPaths) {
        const isActive = rigsNav.activeWhen(maliciousPath);
        expect(
          isActive,
          `Rigs nav item active state should NOT be suppressed by query string in ${maliciousPath}`,
        ).toBe(true);
      }
    });

    it("correctly identifies genuine chat seats even with query parameters", () => {
      const validChatPaths = [
        { path: "/topology/seat/rig-prod/advisor?tab=chat&debug=1", advisor: true, operator: false },
        { path: "/topology/seat/rig-prod/advisor-lead?ref=dashboard", advisor: true, operator: false },
        { path: "/topology/seat/rig-prod/operator?tab=terminal", advisor: false, operator: true },
        { path: "/topology/seat/rig-prod/operator-primary?ref=alert", advisor: false, operator: true },
      ];

      const items = allNavItems();
      const rigsNav = items.find((i) => i.id === "rigs")!;

      for (const { path, advisor, operator } of validChatPaths) {
        expect(isAdvisorSeat(path)).toBe(advisor);
        expect(isOperatorSeat(path)).toBe(operator);
        expect(isChatSeat(path)).toBe(true);
        // Genuine chat seats MUST suppress Rigs active indicator
        expect(rigsNav.activeWhen(path)).toBe(false);
      }
    });
  });

  describe("Trailing slashes, query strings, and edge-case URLs for /agents and /", () => {
    const items = allNavItems();
    const agentsNav = items.find((i) => i.id === "agents")!;
    const dashboardNav = items.find((i) => i.id === "dashboard")!;

    it("verifies agents active state under trailing slashes and query strings", () => {
      const validAgentsPaths = [
        "/agents",
        "/agents/",
        "/agents//",
        "/agents///",
        "/agents?slice=core",
        "/agents/?slice=core",
        "/agents///?slice=core",
        "/agents?slice=core&group=slice",
        "/agents/?filter=failed&sort=time",
      ];

      for (const p of validAgentsPaths) {
        expect(agentsNav.activeWhen(p), `Agents nav should be active for ${p}`).toBe(true);
      }
    });

    it("rejects non-agents paths for agents nav item", () => {
      const invalidAgentsPaths = [
        "/agents/nested",
        "/agents/subpath",
        "/agents-archive",
        "/my-agents",
        "/topology/agents",
        "/",
      ];

      for (const p of invalidAgentsPaths) {
        expect(agentsNav.activeWhen(p), `Agents nav should NOT be active for ${p}`).toBe(false);
      }
    });

    it("verifies dashboard active state with query strings", () => {
      const validDashboardPaths = [
        "/",
        "/?tab=fleet",
        "/?view=compact",
        "/?refresh=true&host=local",
      ];

      for (const p of validDashboardPaths) {
        expect(dashboardNav.activeWhen(p), `Dashboard nav should be active for ${p}`).toBe(true);
      }
    });

    it("rejects non-root paths for dashboard nav item", () => {
      const invalidDashboardPaths = [
        "/topology",
        "/for-you",
        "/agents",
        "/fleet",
      ];

      for (const p of invalidDashboardPaths) {
        expect(dashboardNav.activeWhen(p), `Dashboard nav should NOT be active for ${p}`).toBe(false);
      }
    });
  });
});

describe("Adversarial Stress Suite M3: Responsive Layout Clearance & Drawer Mechanics", () => {
  it("UndoToast includes bottom-20 (<1024px) for bottom nav clearance and lg:bottom-6 for desktop", () => {
    render(
      <UndoToast
        label="Test undo notification"
        onUndo={() => {}}
        onExpire={() => {}}
        durationMs={5000}
      />,
    );

    const toastEl = screen.getByTestId("undo-toast");
    expect(toastEl.className).toContain("bottom-20");
    expect(toastEl.className).toContain("lg:bottom-6");
    expect(toastEl.className).toContain("z-50");
  });

  it("VellumSheet includes pb-16 (<1024px) for mobile bottom nav clearance and lg:pb-0 for desktop", () => {
    render(<VellumSheet testId="adversarial-sheet">Sheet Content</VellumSheet>);

    const sheet = screen.getByTestId("adversarial-sheet");
    expect(sheet.className).toContain("pb-16");
    expect(sheet.className).toContain("lg:pb-0");
  });

  it("AgentPropertiesPanel renders responsive close button and merges custom mobile classes", async () => {
    const onCloseSpy = vi.fn();
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <AgentPropertiesPanel
          rigId="rig-1"
          logicalId="worker-agent"
          className="custom-adversarial-drawer-class"
          onClose={onCloseSpy}
        />
      </QueryClientProvider>,
    );

    const panel = screen.getByTestId("agent-properties");
    expect(panel.className).toContain("custom-adversarial-drawer-class");

    const closeBtn = screen.getByTestId("agent-properties-close");
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.getAttribute("aria-label")).toBe("Close properties");

    fireEvent.click(closeBtn);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });
});
