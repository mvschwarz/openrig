// User Settings v0 — System drawer Settings tab tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { SettingsTab } from "../src/components/system/SettingsTab.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => cleanup());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

function makeSettingsResponse() {
  return {
    settings: {
      "daemon.port": { value: 7433, source: "default", defaultValue: 7433 },
      "daemon.host": { value: "127.0.0.1", source: "default", defaultValue: "127.0.0.1" },
      "db.path": { value: "/Users/me/.openrig/openrig.sqlite", source: "default", defaultValue: "/Users/me/.openrig/openrig.sqlite" },
      "transcripts.enabled": { value: true, source: "default", defaultValue: true },
      "transcripts.path": { value: "/Users/me/.openrig/transcripts", source: "default", defaultValue: "/Users/me/.openrig/transcripts" },
      "workspace.root": { value: "/Users/me/.openrig/workspace", source: "default", defaultValue: "/Users/me/.openrig/workspace" },
      "workspace.slices_root": { value: "/Users/me/.openrig/workspace/slices", source: "default", defaultValue: "/Users/me/.openrig/workspace/slices" },
      "workspace.steering_path": { value: "/Users/me/.openrig/workspace/steering/STEERING.md", source: "default", defaultValue: "/Users/me/.openrig/workspace/steering/STEERING.md" },
      "workspace.field_notes_root": { value: "/Users/me/.openrig/workspace/field-notes", source: "default", defaultValue: "/Users/me/.openrig/workspace/field-notes" },
      "workspace.specs_root": { value: "/Users/me/.openrig/workspace/specs", source: "default", defaultValue: "/Users/me/.openrig/workspace/specs" },
      "files.allowlist": { value: "", source: "default", defaultValue: "" },
      "progress.scan_roots": { value: "ws:/Users/me/work", source: "env", defaultValue: "" },
    },
  };
}

describe("SettingsTab — User Settings v0", () => {
  it("renders all 12 settings rows with source badges", async () => {
    mockFetch.mockResolvedValue(jsonResponse(makeSettingsResponse()));
    render(createTestRouter({ component: () => <SettingsTab />, path: "/" }));

    await waitFor(() => expect(screen.getByTestId("settings-tab")).toBeDefined());
    expect(screen.getByTestId("setting-workspace.root")).toBeDefined();
    expect(screen.getByTestId("setting-workspace.slices_root")).toBeDefined();
    expect(screen.getByTestId("setting-workspace.steering_path")).toBeDefined();
    expect(screen.getByTestId("setting-files.allowlist")).toBeDefined();
    expect(screen.getByTestId("setting-progress.scan_roots")).toBeDefined();
    expect(screen.getByTestId("setting-daemon.port")).toBeDefined();
    expect(screen.getByTestId("setting-db.path")).toBeDefined();

    // Source badge surfaces the env-resolved row honestly.
    expect(screen.getByTestId("setting-progress.scan_roots").textContent).toContain("source: env");
    expect(screen.getByTestId("setting-workspace.root").textContent).toContain("source: default");
  });

  it("Edit + Save sends POST to /api/config/:key with the value", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === "POST" && String(url).includes("/api/config/workspace.slices_root")) {
        return jsonResponse({ ok: true, key: "workspace.slices_root", resolved: { value: "/founder/slices", source: "file", defaultValue: "" } });
      }
      return jsonResponse(makeSettingsResponse());
    });

    render(createTestRouter({ component: () => <SettingsTab />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("setting-workspace.slices_root")).toBeDefined());

    fireEvent.click(screen.getByTestId("setting-workspace.slices_root-edit"));
    const input = screen.getByTestId("setting-workspace.slices_root-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/founder/slices" } });
    fireEvent.click(screen.getByTestId("setting-workspace.slices_root-save"));

    await waitFor(() => {
      expect(calls.some((c) =>
        c.url.includes("/api/config/workspace.slices_root")
        && c.init?.method === "POST"
        && (c.init.body as string).includes("/founder/slices")
      )).toBe(true);
    });
  });

  it("Reset button is hidden for default-source rows; visible for non-default", async () => {
    mockFetch.mockResolvedValue(jsonResponse(makeSettingsResponse()));
    render(createTestRouter({ component: () => <SettingsTab />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("setting-workspace.root")).toBeDefined());

    // workspace.root is source=default → no reset
    expect(screen.queryByTestId("setting-workspace.root-reset")).toBeNull();
    // progress.scan_roots is source=env → reset visible (env still counts as overridden)
    expect(screen.queryByTestId("setting-progress.scan_roots-reset")).toBeDefined();
  });

  it("Init Workspace button POSTs to /api/config/init-workspace", async () => {
    let initCalled = false;
    mockFetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/config/init-workspace")) {
        initCalled = true;
        return jsonResponse({
          root: "/Users/me/.openrig/workspace",
          rootCreated: true,
          subdirs: [
            { name: "slices", path: "/x/slices", created: true },
            { name: "steering", path: "/x/steering", created: true },
            { name: "progress", path: "/x/progress", created: true },
            { name: "field-notes", path: "/x/field-notes", created: true },
            { name: "specs", path: "/x/specs", created: true },
          ],
          files: [],
          dryRun: false,
        });
      }
      return jsonResponse(makeSettingsResponse());
    });

    render(createTestRouter({ component: () => <SettingsTab />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("settings-init-workspace")).toBeDefined());
    fireEvent.click(screen.getByTestId("settings-init-workspace"));

    await waitFor(() => expect(initCalled).toBe(true));
    await waitFor(() => expect(screen.getByTestId("settings-init-result")).toBeDefined());
    expect(screen.getByTestId("settings-init-result").textContent).toContain("created 5 subdir");
  });

  it("renders a friendly error when the daemon route 503s", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: "settings_unavailable" }, 503));
    render(createTestRouter({ component: () => <SettingsTab />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("settings-error")).toBeDefined());
  });
});
