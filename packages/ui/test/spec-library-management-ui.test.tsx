import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { SpecsPanel } from "../src/components/SpecsPanel.js";

const fetchMock = vi.fn();

describe("Specs drawer library management", () => {
  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function installFetchState() {
    const state = {
      rigEntries: [
        {
          id: "user-rig-1",
          kind: "rig",
          name: "my-rig",
          version: "0.2",
          sourceType: "user_file",
          sourcePath: "/tmp/my-rig.yaml",
          relativePath: "my-rig.yaml",
          updatedAt: "2026-04-07T00:00:00Z",
        },
        {
          id: "builtin-rig-1",
          kind: "rig",
          name: "starter-rig",
          version: "0.2",
          sourceType: "builtin",
          sourcePath: "/builtin/starter-rig.yaml",
          relativePath: "starter-rig.yaml",
          updatedAt: "2026-04-07T00:00:00Z",
        },
      ],
      agentEntries: [
        {
          id: "user-agent-1",
          kind: "agent",
          name: "my-agent",
          version: "1.0.0",
          sourceType: "user_file",
          sourcePath: "/tmp/my-agent.yaml",
          relativePath: "my-agent.yaml",
          updatedAt: "2026-04-07T00:00:00Z",
        },
      ],
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/specs/library") && !url.includes("/rename") && !url.includes("/user-rig-1") && !init?.method) {
        // Unified all-entries query — return merged list
        if (url.includes("kind=rig")) return { ok: true, json: async () => state.rigEntries };
        if (url.includes("kind=agent")) return { ok: true, json: async () => state.agentEntries };
        return { ok: true, json: async () => [...state.rigEntries, ...state.agentEntries] };
      }
      if (url.includes("/api/specs/library/user-rig-1/rename") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { name: string };
        state.rigEntries = state.rigEntries.map((entry) =>
          entry.id === "user-rig-1"
            ? { ...entry, name: body.name, sourcePath: `/tmp/${body.name}.yaml`, relativePath: `${body.name}.yaml` }
            : entry
        );
        return { ok: true, json: async () => ({ ok: true, entry: state.rigEntries[0] }) };
      }
      if (url.includes("/api/specs/library/user-rig-1") && init?.method === "DELETE") {
        state.rigEntries = state.rigEntries.filter((entry) => entry.id !== "user-rig-1");
        return { ok: true, json: async () => ({ ok: true, id: "user-rig-1", name: "my-rig" }) };
      }
      return { ok: true, json: async () => [] };
    });
  }

  function renderPanel() {
    return render(createTestRouter({ component: () => <SpecsPanel onClose={vi.fn()} />, path: "/test" }));
  }

  it("shows rename and remove actions for user-file entries but not builtins", async () => {
    installFetchState();
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("library-entry-user-rig-1")).toBeDefined();
    });

    expect(screen.getByTestId("library-rename-user-rig-1")).toBeDefined();
    expect(screen.getByTestId("library-remove-user-rig-1")).toBeDefined();
    expect(screen.queryByTestId("library-rename-builtin-rig-1")).toBeNull();
    expect(screen.queryByTestId("library-remove-builtin-rig-1")).toBeNull();
  });

  it("renames a user-file library entry inline", async () => {
    installFetchState();
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("library-rename-user-rig-1")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("library-rename-user-rig-1"));

    await waitFor(() => {
      expect(screen.getByTestId("library-rename-input-user-rig-1")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("library-rename-input-user-rig-1"), {
      target: { value: "renamed-rig" },
    });
    fireEvent.click(screen.getByTestId("library-rename-submit-user-rig-1"));

    await waitFor(() => {
      expect(screen.getByText("renamed-rig")).toBeDefined();
    });
  });

  it("removes a user-file library entry after confirmation", async () => {
    installFetchState();
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("library-remove-user-rig-1")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("library-remove-user-rig-1"));

    await waitFor(() => {
      expect(screen.getByTestId("library-remove-confirm-user-rig-1")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("library-remove-submit-user-rig-1"));

    await waitFor(() => {
      expect(screen.queryByText("my-rig")).toBeNull();
    });
  });
});
