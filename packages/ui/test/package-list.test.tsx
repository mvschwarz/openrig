import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { PackageList } from "../src/components/PackageList.js";
import { Sidebar } from "../src/components/Sidebar.js";
import type { PackageSummary } from "../src/hooks/usePackages.js";

const MOCK_PACKAGES: PackageSummary[] = [
  {
    id: "pkg-1",
    name: "acme-standards",
    version: "2.0.0",
    sourceKind: "local_path",
    sourceRef: "/packages/acme",
    manifestHash: "abc",
    summary: "ACME engineering standards",
    createdAt: "2026-03-25 10:00:00",
    installCount: 3,
    latestInstallStatus: "applied",
  },
  {
    id: "pkg-2",
    name: "test-tools",
    version: "1.0.0",
    sourceKind: "local_path",
    sourceRef: "/packages/tools",
    manifestHash: "def",
    summary: null,
    createdAt: "2026-03-25 11:00:00",
    installCount: 1,
    latestInstallStatus: "rolled_back",
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

function mockFetchPackages(data: PackageSummary[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

function mockFetchError() {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({}),
  });
}

function renderPackageList() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/packages", component: PackageList },
        { path: "/packages/install", component: () => <div data-testid="install-flow-page">Install Flow</div> },
      ],
      initialPath: "/packages",
    })
  );
}

describe("PackageList", () => {
  // Test 1: Renders package cards with name, version, source
  it("renders package cards with name, version, and source", async () => {
    mockFetchPackages(MOCK_PACKAGES);
    renderPackageList();

    await waitFor(() => {
      const cards = screen.getAllByTestId("package-card");
      expect(cards).toHaveLength(2);
    });

    expect(screen.getByText("acme-standards")).toBeTruthy();
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    expect(screen.getByText("/packages/acme")).toBeTruthy();
    expect(screen.getByText("test-tools")).toBeTruthy();
    expect(screen.getByText("v1.0.0")).toBeTruthy();
  });

  // Test 2: Card shows install count and latest install status
  it("card shows install count and latest install status", async () => {
    mockFetchPackages(MOCK_PACKAGES);
    renderPackageList();

    await waitFor(() => {
      const counts = screen.getAllByTestId("install-count");
      expect(counts).toHaveLength(2);
      expect(counts[0]!.textContent).toBe("3");
      expect(counts[1]!.textContent).toBe("1");
    });

    const statuses = screen.getAllByTestId("install-status");
    expect(statuses[0]!.textContent).toBe("APPLIED");
    expect(statuses[1]!.textContent).toBe("ROLLED BACK");
  });

  // Test 3: Empty state CTA navigates to /packages/install
  it("empty state CTA navigates to install flow", async () => {
    mockFetchPackages([]);
    renderPackageList();

    await waitFor(() => {
      expect(screen.getByTestId("packages-empty")).toBeTruthy();
    });

    const btn = screen.getByTestId("empty-install-btn");
    expect(btn.textContent).toContain("INSTALL YOUR FIRST PACKAGE");
    expect(btn).toHaveProperty("disabled", false);

    act(() => { fireEvent.click(btn); });

    await waitFor(() => {
      expect(screen.getByTestId("install-flow-page")).toBeTruthy();
    });
  });

  // Test 4: Loading skeleton
  it("shows loading skeleton while fetching", async () => {
    // Never resolve fetch
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderPackageList();

    await waitFor(() => {
      expect(screen.getByTestId("packages-loading")).toBeTruthy();
    });
  });

  // Test 5: Error state
  it("shows error state on fetch failure", async () => {
    mockFetchError();
    renderPackageList();

    await waitFor(() => {
      expect(screen.getByTestId("packages-error")).toBeTruthy();
    });
  });

  // Test 6: Sidebar nav PACKAGES with active state
  it("sidebar shows PACKAGES nav with active state", async () => {
    mockFetchPackages([]);

    function SidebarHarness() {
      return <Sidebar open={true} onClose={() => {}} />;
    }

    render(
      createAppTestRouter({
        routes: [
          { path: "/packages", component: () => <><SidebarHarness /><PackageList /></> },
        ],
        initialPath: "/packages",
      })
    );

    await waitFor(() => {
      const navItem = screen.getByTestId("nav-packages");
      expect(navItem).toBeTruthy();
      expect(navItem.getAttribute("aria-current")).toBe("page");
    });
  });

  // Test 7: Header install button navigates to /packages/install
  it("header install button navigates to install flow", async () => {
    mockFetchPackages(MOCK_PACKAGES);
    renderPackageList();

    await waitFor(() => {
      const btn = screen.getByTestId("header-install-btn");
      expect(btn).toHaveProperty("disabled", false);
    });

    act(() => { fireEvent.click(screen.getByTestId("header-install-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("install-flow-page")).toBeTruthy();
    });
  });

  // Test 8: Card click navigates to package detail
  it("card click navigates to package detail page", async () => {
    mockFetchPackages(MOCK_PACKAGES);

    render(
      createAppTestRouter({
        routes: [
          { path: "/packages", component: PackageList },
          { path: "/packages/install", component: () => <div data-testid="install-flow-page">Install Flow</div> },
          { path: "/packages/$packageId", component: () => <div data-testid="package-detail-page">Detail</div> },
        ],
        initialPath: "/packages",
      })
    );

    await waitFor(() => {
      const cards = screen.getAllByTestId("package-card");
      expect(cards).toHaveLength(2);
    });

    const card = screen.getAllByTestId("package-card")[0]!;
    expect(card.getAttribute("role")).toBe("link");
    expect(card.className).toContain("cursor-pointer");

    act(() => {
      fireEvent.click(card);
    });

    await waitFor(() => {
      expect(screen.getByTestId("package-detail-page")).toBeTruthy();
    });
  });
});
