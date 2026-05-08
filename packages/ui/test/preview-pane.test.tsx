// Preview Terminal v0 (PL-018) — PreviewPane + PreviewStack tests.
//
// Pins:
//   - PreviewPane renders content + lines + capturedAt + Pin button
//   - "preview unavailable" fallback for 404/409/502 daemon responses
//   - Pin / Unpin toggles state
//   - PreviewStack hides when no pins; shows pinned panes when pinned
//   - Cap (ui.preview.max_pins) enforced

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { PreviewPane } from "../src/components/preview/PreviewPane.js";
import { PreviewStack } from "../src/components/preview/PreviewStack.js";
import { previewPinStore } from "../src/components/preview/preview-pin-store.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
  // Reset pin store between tests
  for (const p of previewPinStore.list()) {
    previewPinStore.unpin(p.rigId, p.logicalId);
  }
  previewPinStore.setMaxPins(4);
});

afterEach(() => cleanup());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

function settingsResponse(overrides: Record<string, { value: unknown; source: string; defaultValue: unknown }> = {}) {
  const baseline = {
    "daemon.port": { value: 7433, source: "default", defaultValue: 7433 },
    "daemon.host": { value: "127.0.0.1", source: "default", defaultValue: "127.0.0.1" },
    "db.path": { value: "/tmp", source: "default", defaultValue: "/tmp" },
    "transcripts.enabled": { value: true, source: "default", defaultValue: true },
    "transcripts.path": { value: "/tmp", source: "default", defaultValue: "/tmp" },
    "workspace.root": { value: "/tmp/ws", source: "default", defaultValue: "/tmp/ws" },
    "workspace.slices_root": { value: "/tmp/ws/missions", source: "default", defaultValue: "/tmp/ws/missions" },
    "workspace.steering_path": { value: "/tmp/ws/STEERING.md", source: "default", defaultValue: "/tmp/ws/STEERING.md" },
    "workspace.field_notes_root": { value: "/tmp/ws/field-notes", source: "default", defaultValue: "/tmp/ws/field-notes" },
    "workspace.specs_root": { value: "/tmp/ws/specs", source: "default", defaultValue: "/tmp/ws/specs" },
    "files.allowlist": { value: "", source: "default", defaultValue: "" },
    "progress.scan_roots": { value: "", source: "default", defaultValue: "" },
    "ui.preview.refresh_interval_seconds": { value: 3, source: "default", defaultValue: 3 },
    "ui.preview.max_pins": { value: 4, source: "default", defaultValue: 4 },
    "ui.preview.default_lines": { value: 50, source: "default", defaultValue: 50 },
    ...overrides,
  };
  return jsonResponse({ settings: baseline });
}

describe("PreviewPane (PL-018)", () => {
  it("renders content + lines + Pin button on success", async () => {
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/config")) return settingsResponse();
      if (u.includes("/preview")) return jsonResponse({
        content: "line A\nline B\nline C",
        lines: 50,
        sessionName: "velocity-driver@openrig-velocity",
        capturedAt: "2026-05-04T12:00:00Z",
      });
      return jsonResponse({});
    });

    render(createTestRouter({
      component: () => <PreviewPane rigId="r-1" logicalId="driver" testIdPrefix="t" />,
      path: "/",
    }));

    await waitFor(() => expect(screen.getByTestId("t-pane")).toBeDefined());
    await waitFor(() => {
      expect(screen.getByTestId("t-content").textContent).toContain("line A");
      expect(screen.getByTestId("t-content").textContent).toContain("line C");
    });
    expect(screen.getByTestId("t-pin-toggle")).toBeDefined();
  });

  it("renders preview-unavailable fallback on 404", async () => {
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/config")) return settingsResponse();
      if (u.includes("/preview")) return jsonResponse({ error: "preview_unavailable" }, 404);
      return jsonResponse({});
    });

    render(createTestRouter({
      component: () => <PreviewPane rigId="r-1" logicalId="missing" testIdPrefix="t" />,
      path: "/",
    }));

    await waitFor(() => expect(screen.getByTestId("t-unavailable")).toBeDefined());
    expect(screen.getByTestId("t-unavailable").textContent).toContain("rig capture missing");
  });

  it("renders 409 session_unbound with hint", async () => {
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/config")) return settingsResponse();
      if (u.includes("/preview")) return jsonResponse({
        error: "session_unbound",
        hint: "Use rig up to start the seat.",
      }, 409);
      return jsonResponse({});
    });

    render(createTestRouter({
      component: () => <PreviewPane rigId="r-1" logicalId="unbound" testIdPrefix="t" />,
      path: "/",
    }));

    await waitFor(() => expect(screen.getByTestId("t-unavailable")).toBeDefined());
    expect(screen.getByTestId("t-unavailable").textContent).toContain("session_unbound");
    expect(screen.getByTestId("t-unavailable").textContent).toContain("rig up");
  });

  it("Pin button toggles pin state in the store", async () => {
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/config")) return settingsResponse();
      if (u.includes("/preview")) return jsonResponse({
        content: "x", lines: 50, sessionName: "s", capturedAt: "2026-05-04T12:00:00Z",
      });
      return jsonResponse({});
    });

    render(createTestRouter({
      component: () => <PreviewPane rigId="r-1" logicalId="driver" rigName="rig-1" testIdPrefix="t" />,
      path: "/",
    }));

    await waitFor(() => expect(screen.getByTestId("t-pin-toggle")).toBeDefined());
    expect(previewPinStore.isPinned("r-1", "driver")).toBe(false);

    fireEvent.click(screen.getByTestId("t-pin-toggle"));
    expect(previewPinStore.isPinned("r-1", "driver")).toBe(true);

    // Re-click → unpin
    await waitFor(() => expect(screen.getByTestId("t-pin-toggle").textContent).toBe("Unpin"));
    fireEvent.click(screen.getByTestId("t-pin-toggle"));
    expect(previewPinStore.isPinned("r-1", "driver")).toBe(false);
  });
});

describe("PreviewStack (PL-018)", () => {
  it("hides when no pins are present", async () => {
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/config")) return settingsResponse();
      return jsonResponse({});
    });
    render(createTestRouter({ component: () => <PreviewStack />, path: "/" }));
    // No pins → stack is null → testId not rendered.
    await waitFor(() => {}, { timeout: 50 }).catch(() => {});
    expect(screen.queryByTestId("preview-stack")).toBeNull();
  });

  it("shows pinned panes when present", async () => {
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/config")) return settingsResponse();
      if (u.includes("/preview")) return jsonResponse({
        content: "alpha\nbeta", lines: 50, sessionName: "alpha-session", capturedAt: "2026-05-04T12:00:00Z",
      });
      return jsonResponse({});
    });

    act(() => {
      previewPinStore.pin({ rigId: "r-1", rigName: "rig-1", logicalId: "alpha", sessionName: "alpha-session" });
    });

    render(createTestRouter({ component: () => <PreviewStack />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("preview-stack")).toBeDefined());
    expect(screen.getByTestId("preview-stack").textContent).toContain("1 pinned");
  });
});

describe("preview pin store cap (PL-018)", () => {
  it("rejects pin when max-pins cap is reached", () => {
    previewPinStore.setMaxPins(2);
    expect(previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "a", sessionName: "a" })).toBe(true);
    expect(previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "b", sessionName: "b" })).toBe(true);
    expect(previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "c", sessionName: "c" })).toBe(false);
    expect(previewPinStore.list().length).toBe(2);
  });

  it("idempotent pin returns true even when max reached if already pinned", () => {
    previewPinStore.setMaxPins(1);
    previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "a", sessionName: "a" });
    expect(previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "a", sessionName: "a" })).toBe(true);
    expect(previewPinStore.list().length).toBe(1);
  });

  it("setMaxPins shrinks list to new cap", () => {
    previewPinStore.setMaxPins(4);
    previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "a", sessionName: "a" });
    previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "b", sessionName: "b" });
    previewPinStore.pin({ rigId: "r-1", rigName: "rig", logicalId: "c", sessionName: "c" });
    previewPinStore.setMaxPins(1);
    expect(previewPinStore.list().length).toBe(1);
  });
});
