import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BundleInspector } from "../src/components/BundleInspector.js";
import { eventColor, eventSummary, type ActivityEvent } from "../src/hooks/useActivityFeed.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const INSPECT_RESPONSE = {
  manifest: {
    name: "test-bundle", version: "0.1.0", rigSpec: "rig.yaml",
    packages: [{ name: "review-kit", version: "1.0.0", path: "packages/review-kit" }],
    integrity: { algorithm: "sha256", files: { "rig.yaml": "abc", "packages/review-kit/SKILL.md": "def" } },
  },
  digestValid: true,
  integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
};

describe("BundleInspector", () => {
  // T1: Shows manifest details
  it("shows manifest name, version, and rig_spec", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/test.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("manifest-summary")).toBeTruthy();
      expect(screen.getByTestId("manifest-summary").textContent).toContain("test-bundle");
      expect(screen.getByTestId("manifest-summary").textContent).toContain("v0.1.0");
    });
  });

  // T2: Integrity status (green/red)
  it("shows integrity status as PASS or FAIL", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/test.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("integrity-status").textContent).toContain("PASS");
    });
  });

  // T3: Package list renders
  it("renders package list", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/x.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      const entries = screen.getAllByTestId("package-entry");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.textContent).toContain("review-kit");
    });
  });

  // T4: Install button present
  it("shows install button after inspection", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/x.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("install-btn")).toBeTruthy();
    });
  });

  // T6-AS-T14: v2 manifest renders agents list instead of packages
  it("v2 manifest renders agents list instead of packages", async () => {
    const v2Response = {
      manifest: {
        schemaVersion: 2,
        name: "pod-bundle",
        version: "0.2.0",
        rigSpec: "rig.yaml",
        agents: [
          { name: "impl-agent", version: "1.0.0", path: "agents/impl" },
          { name: "review-agent", version: "1.1.0", path: "agents/review" },
        ],
      },
      digestValid: true,
      integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => v2Response });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/v2.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      // Should show agents, not packages
      expect(screen.getByTestId("agent-list")).toBeTruthy();
      const entries = screen.getAllByTestId("agent-entry");
      expect(entries).toHaveLength(2);
      expect(entries[0]!.textContent).toContain("impl-agent");
      expect(entries[1]!.textContent).toContain("review-agent");
      // Should NOT show package-list
      expect(screen.queryByTestId("package-list")).toBeNull();
      // Schema badge should show v2
      expect(screen.getByTestId("schema-badge").textContent).toContain("v2");
    });
  });

  // Item 5 / slice-05 Checkpoint 6.1 / guard B1 repair: provenance block renders
  // when manifest carries it. Discriminator: false && result.manifest.provenance
  // gate must fail this test.
  it("renders provenance block with all fields when manifest carries provenance", async () => {
    const responseWithProvenance = {
      manifest: {
        name: "with-prov",
        version: "0.1.0",
        rigSpec: "rig.yaml",
        packages: [{ name: "pkg", version: "1.0", path: "packages/pkg" }],
        provenance: {
          createdAt: "2026-05-18T12:00:00Z",
          sourceHost: "test-host.local",
          authorSession: "velocity-driver@openrig-velocity",
          sourceRigId: "01H000000000000000PROV001",
          sourceRigName: "openrig-velocity",
          daemonVersion: "0.3.2",
          cliVersion: "0.3.2",
          notes: "fixture for B1 repair",
        },
      },
      digestValid: true,
      integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => responseWithProvenance });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/with-prov.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("provenance-block")).toBeTruthy();
      expect(screen.getByTestId("provenance-createdAt").textContent).toContain("2026-05-18T12:00:00Z");
      expect(screen.getByTestId("provenance-sourceHost").textContent).toContain("test-host.local");
      expect(screen.getByTestId("provenance-authorSession").textContent).toContain("velocity-driver@openrig-velocity");
      expect(screen.getByTestId("provenance-sourceRigName").textContent).toContain("openrig-velocity");
      expect(screen.getByTestId("provenance-sourceRigName").textContent).toContain("01H000000000000000PROV001");
      expect(screen.getByTestId("provenance-versions").textContent).toContain("daemon 0.3.2");
      expect(screen.getByTestId("provenance-versions").textContent).toContain("cli 0.3.2");
      expect(screen.getByTestId("provenance-notes").textContent).toContain("fixture for B1 repair");
    });
  });

  // Item 5 / slice-05 Checkpoint 6.1 / guard B1 repair: compatibility block renders
  // when manifest carries it. Discriminator: false && result.manifest.compatibility
  // gate must fail this test.
  it("renders compatibility block with all fields when manifest carries compatibility", async () => {
    const responseWithCompat = {
      manifest: {
        name: "with-compat",
        version: "0.1.0",
        rigSpec: "rig.yaml",
        packages: [{ name: "pkg", version: "1.0", path: "packages/pkg" }],
        compatibility: {
          minDaemonVersion: "0.3.2",
          minCliVersion: "0.3.2",
          schemaVersion: 1,
        },
      },
      digestValid: true,
      integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => responseWithCompat });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/with-compat.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("compatibility-block")).toBeTruthy();
      expect(screen.getByTestId("compatibility-minDaemonVersion").textContent).toContain("0.3.2");
      expect(screen.getByTestId("compatibility-minCliVersion").textContent).toContain("0.3.2");
      expect(screen.getByTestId("compatibility-schemaVersion").textContent).toContain("v1");
    });
  });

  // Item 5 / slice-05 Checkpoint 6.1 / guard B1 repair: backward-compat — bundle
  // without provenance or compatibility blocks does NOT render those sections.
  // Pre-Item-1/Item-2 bundles install/inspect unchanged.
  it("does NOT render provenance or compatibility blocks when manifest omits them (backward compat)", async () => {
    // INSPECT_RESPONSE has no provenance + no compatibility — reuse it
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/bc.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      // Manifest summary still renders (regression baseline)
      expect(screen.getByTestId("manifest-summary")).toBeTruthy();
    });
    // New blocks must NOT be present
    expect(screen.queryByTestId("provenance-block")).toBeNull();
    expect(screen.queryByTestId("compatibility-block")).toBeNull();
  });

  // T6: Error state
  it("shows error on inspect failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/bad.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("inspect-error")).toBeTruthy();
    });
  });
});

// T5: Activity feed bundle.created event
describe("Bundle activity feed events", () => {
  function makeEvent(overrides: { type: string; payload?: Record<string, unknown> }): ActivityEvent {
    return { seq: 1, type: overrides.type, payload: { type: overrides.type, ...overrides.payload }, createdAt: new Date().toISOString(), receivedAt: Date.now() };
  }

  it("bundle.created uses bg-accent color and correct summary", () => {
    expect(eventColor("bundle.created")).toBe("bg-accent");
    const event = makeEvent({ type: "bundle.created", payload: { bundleName: "my-bundle", bundleVersion: "1.0.0" } });
    expect(eventSummary(event)).toContain("my-bundle");
    expect(eventSummary(event)).toContain("v1.0.0");
    expect(eventSummary(event)).toContain("bundled");
  });
});

// Server diagnostics must stay visible; a FAIL/PASS badge alone cannot explain the login-file policy.
it.each(["errors", "warnings"] as const)("shows login-file %s with the path and both remedies", async field => {
  const message = "Harness login file 'agents/worker/.codex/auth.json': anyone with the bundle could read it. Remove it from the agent folder or carried project and build again, or, only if recipients should have this login (for example, your own internal test bundle) and its owner agrees, recreate with --include-login-files.";
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...INSPECT_RESPONSE,
    integrityResult: { ...INSPECT_RESPONSE.integrityResult, passed: field !== "errors", [field]: [message] },
  }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);
  fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/synthetic.rigbundle" } });
  fireEvent.click(screen.getByTestId("inspect-btn"));
  await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
});
