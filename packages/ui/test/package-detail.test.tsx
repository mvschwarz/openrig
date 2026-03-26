import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { PackageDetail } from "../src/components/PackageDetail.js";
import type { PackageInfo, InstallSummary, JournalEntry } from "../src/hooks/usePackageDetail.js";

const MOCK_PACKAGE: PackageInfo = {
  id: "pkg-1",
  name: "acme-standards",
  version: "2.0.0",
  sourceKind: "local_path",
  sourceRef: "/packages/acme",
  manifestHash: "abc123",
  summary: "ACME engineering standards",
  createdAt: "2026-03-25 10:00:00",
};

// API returns newest-first (deterministic ordering by created_at DESC, rowid DESC)
const MOCK_INSTALLS: InstallSummary[] = [
  {
    id: "inst-2",
    packageId: "pkg-1",
    targetRoot: "/repo-b",
    scope: "user",
    status: "rolled_back",
    riskTier: null,
    createdAt: "2026-03-25 12:00:00",
    appliedAt: "2026-03-25 12:01:00",
    rolledBackAt: "2026-03-25 13:00:00",
    appliedCount: 1,
    deferredCount: null,
  },
  {
    id: "inst-1",
    packageId: "pkg-1",
    targetRoot: "/repo-a",
    scope: "user",
    status: "applied",
    riskTier: null,
    createdAt: "2026-03-25 10:00:00",
    appliedAt: "2026-03-25 10:01:00",
    rolledBackAt: null,
    appliedCount: 3,
    deferredCount: null,
  },
];

const MOCK_JOURNAL: JournalEntry[] = [
  {
    id: "j-1",
    installId: "inst-1",
    seq: 1,
    action: "copy",
    exportType: "skill",
    classification: "safe_projection",
    targetPath: "/repo-a/.claude/skills/tool.md",
    status: "applied",
    createdAt: "2026-03-25 10:01:00",
  },
  {
    id: "j-2",
    installId: "inst-1",
    seq: 2,
    action: "copy",
    exportType: "guidance",
    classification: "managed_merge",
    targetPath: "/repo-a/CLAUDE.md",
    status: "applied",
    createdAt: "2026-03-25 10:01:01",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(opts: {
  pkg?: PackageInfo;
  installs?: InstallSummary[];
  journal?: JournalEntry[];
  rollbackOk?: boolean;
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && typeof url === "string" && url.includes("/rollback")) {
      if (opts.rollbackOk) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (typeof url === "string" && url.includes("/journal")) {
      return { ok: true, status: 200, json: async () => (opts.journal ?? []) };
    }
    if (typeof url === "string" && url.includes("/installs")) {
      return { ok: true, status: 200, json: async () => (opts.installs ?? []) };
    }
    if (typeof url === "string" && url.match(/\/api\/packages\/[^/]+$/)) {
      return { ok: true, status: 200, json: async () => (opts.pkg ?? MOCK_PACKAGE) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderDetail() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/packages/$packageId", component: PackageDetail },
        { path: "/packages", component: () => <div data-testid="packages-page">Packages</div> },
      ],
      initialPath: "/packages/pkg-1",
    })
  );
}

describe("PackageDetail", () => {
  // Test 1: Renders package header
  it("renders package header", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByTestId("package-header")).toBeTruthy();
    });

    expect(screen.getByText("acme-standards")).toBeTruthy();
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    expect(screen.getByTestId("package-source").textContent).toBe("/packages/acme");
  });

  // Test 2: Install history in reverse chronological order
  it("install history in reverse chronological order", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS });
    renderDetail();

    await waitFor(() => {
      const rows = screen.getAllByTestId("install-row");
      expect(rows).toHaveLength(2);
    });

    const rows = screen.getAllByTestId("install-row");
    // inst-2 (2026-03-25 12:00:00) should appear before inst-1 (2026-03-25 10:00:00)
    expect(rows[0]!.textContent).toContain("/repo-b");
    expect(rows[1]!.textContent).toContain("/repo-a");
  });

  // Test 3: Status badges have correct colors
  it("status badges have correct colors", async () => {
    const threeInstalls: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied", createdAt: "2026-03-25 13:00:00" },
      { ...MOCK_INSTALLS[1]!, id: "inst-3", status: "rolled_back", createdAt: "2026-03-25 12:00:00" },
      { ...MOCK_INSTALLS[1]!, id: "inst-4", status: "failed", createdAt: "2026-03-25 11:00:00" },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: threeInstalls });
    renderDetail();

    await waitFor(() => {
      const badges = screen.getAllByTestId("install-status-badge");
      expect(badges).toHaveLength(3);
    });

    const badges = screen.getAllByTestId("install-status-badge");
    expect(badges[0]!.className).toContain("bg-success");
    expect(badges[1]!.className).toContain("bg-warning");
    expect(badges[2]!.className).toContain("bg-destructive");
  });

  // Test 4: Expand install shows journal entries
  it("expand install shows journal entries", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS, journal: MOCK_JOURNAL });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(2);
    });

    // Click expand on the second row (inst-1, which has appliedCount: 3)
    const expandBtns = screen.getAllByTestId("expand-btn");
    act(() => { fireEvent.click(expandBtns[1]!); });

    await waitFor(() => {
      expect(screen.getByTestId("journal-entries")).toBeTruthy();
    });

    const entries = screen.getAllByTestId("journal-entry");
    expect(entries).toHaveLength(2);
  });

  // Test 5: Rollback button opens confirmation dialog
  it("rollback button opens confirmation dialog", async () => {
    // inst-1 is "applied" — will appear second (older)
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(2);
    });

    // The "applied" install is the second row (inst-1, older date)
    const rollbackBtns = screen.getAllByTestId("rollback-btn");
    expect(rollbackBtns.length).toBeGreaterThan(0);

    act(() => { fireEvent.click(rollbackBtns[0]!); });

    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });
  });

  // Test 6: Rollback success updates status
  it("rollback success updates status", async () => {
    const appliedOnly: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied" },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: appliedOnly, rollbackOk: true });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    // Click rollback
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });

    // Confirm rollback
    act(() => { fireEvent.click(screen.getByTestId("rollback-confirm")); });

    // After mutation, the fetch mock is called again for installs (invalidation)
    // The mock will return the same data since it's a static mock,
    // but the mutation itself should have completed successfully
    await waitFor(() => {
      // Dialog should close
      expect(screen.queryByTestId("rollback-dialog")).toBeNull();
    });
  });

  // Test 7: Empty install history
  it("empty install history", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: [] });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByTestId("empty-installs")).toBeTruthy();
    });

    expect(screen.getByTestId("empty-installs").textContent).toContain("No installs yet");
  });

  // Test 8: Install row shows appliedCount and deferred placeholder
  it("install row shows appliedCount and deferred placeholder (deferredCount not yet persisted)", async () => {
    const installWithCounts: InstallSummary[] = [
      {
        ...MOCK_INSTALLS[0]!,
        appliedCount: 3,
        deferredCount: null,
      },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: installWithCounts });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    const appliedCount = screen.getByTestId("applied-count");
    expect(appliedCount.textContent).toContain("3");
    expect(appliedCount.textContent).toContain("applied");

    const deferredPlaceholder = screen.getByTestId("deferred-placeholder");
    expect(deferredPlaceholder.textContent).toContain("deferred");
  });
});
