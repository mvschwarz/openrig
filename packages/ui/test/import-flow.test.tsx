import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { ImportFlow } from "../src/components/ImportFlow.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createTestRouter, createAppTestRouter } from "./helpers/test-router.js";
import { Dashboard } from "../src/components/Dashboard.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

const VALID_YAML = "schema_version: 1\nname: test-rig\nnodes: []\n";

async function renderImportFlow() {
  const result = render(createTestRouter({
    component: () => <ImportFlow onBack={() => {}} />,
    path: "/import",
    initialPath: "/import",
  }));
  // Wait for router to resolve and component to render
  await waitFor(() => expect(screen.getByTestId("import-flow")).toBeDefined());
  return result;
}

describe("ImportFlow", () => {
  it("validate button calls POST /api/rigs/import/validate", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ valid: true, errors: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find((c: unknown[]) => c[0] === "/api/rigs/import/validate");
      expect(call).toBeDefined();
    });
  });

  it("invalid spec shows errors and blocks proceed", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false, errors: ["missing name", "no nodes"] }),
    });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: "bad yaml" } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      const errEl = screen.getByTestId("import-errors");
      expect(errEl.textContent).toContain("missing name");
      expect(errEl.textContent).toContain("no nodes");
    });
    expect(screen.queryByTestId("preflight-btn")).toBeNull();
  });

  it("valid spec advances to preflight step", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ valid: true, errors: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("valid-message")).toBeDefined();
      expect(screen.getByTestId("preflight-btn")).toBeDefined();
    });
  });

  it("preflight errors block instantiate", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: false, errors: ["rig name exists"], warnings: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("import-errors").textContent).toContain("rig name exists");
    });
    expect(screen.queryByTestId("instantiate-btn")).toBeNull();
  });

  it("preflight warnings allow instantiate", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: ["cmux unavailable"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => expect(screen.getByTestId("instantiate-btn")).toBeDefined());
  });

  it("successful instantiate shows per-node status", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: [] }) })
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ rigId: "rig-1", specName: "imported-rig", specVersion: "0.1.0", nodes: [{ logicalId: "orchestrator", status: "launched" }, { logicalId: "worker", status: "launched" }] }),
      });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));
    await waitFor(() => expect(screen.getByTestId("instantiate-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("instantiate-btn"));

    await waitFor(() => {
      const result = screen.getByTestId("import-result");
      expect(result.textContent).toContain("imported-rig");
      expect(result.textContent).toContain("orchestrator");
      expect(result.textContent).toContain("worker");
    });
  });

  it("instantiate failure shows error", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ ok: false, code: "preflight_failed", errors: ["rig name collision"], warnings: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));
    await waitFor(() => expect(screen.getByTestId("instantiate-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("instantiate-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("import-errors").textContent).toContain("rig name collision");
    });
    expect(screen.queryByTestId("import-result")).toBeNull();
  });

  it("import view renders ImportFlow via router", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/import", component: () => <ImportFlow /> },
      ],
      initialPath: "/import",
    }));

    await waitFor(() => {
      expect(screen.getByTestId("import-flow")).toBeDefined();
      expect(screen.getByTestId("yaml-input")).toBeDefined();
    });
  });

  it("back button navigates to dashboard", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/import", component: ImportFlow },
      ],
      initialPath: "/import",
    }));

    await waitFor(() => expect(screen.getByTestId("import-flow")).toBeDefined());
    fireEvent.click(screen.getByText("Back to Dashboard"));

    await waitFor(() => {
      expect(screen.queryByTestId("import-flow")).toBeNull();
    });
  });

  it("validate sends raw YAML body with text/yaml Content-Type", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ valid: true, errors: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find((c: unknown[]) => c[0] === "/api/rigs/import/validate");
      expect(call).toBeDefined();
      const [, opts] = call as [string, RequestInit];
      expect(opts.headers).toMatchObject({ "Content-Type": "text/yaml" });
      expect(opts.body).toBe(VALID_YAML);
    });
  });

  it("preflight warnings are displayed to user", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: ["cmux unavailable", "cwd not found"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      const warningsEl = screen.getByTestId("preflight-warnings");
      expect(warningsEl.textContent).toContain("cmux unavailable");
      expect(warningsEl.textContent).toContain("cwd not found");
    });
  });
});
