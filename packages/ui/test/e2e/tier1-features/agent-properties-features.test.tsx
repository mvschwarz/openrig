import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt, MOCK_AGENT_DETAIL } from "../helpers/e2e-harness.js";
import { AgentPropertiesPanel } from "../../../src/components/AgentPropertiesPanel.js";
import { createTestRouter } from "../../helpers/test-router.js";
import { render } from "@testing-library/react";

setupE2EEnv();

describe("Tier 1 Feature Coverage: Agent Properties Panel", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderPropertiesPanel() {
    return render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig_alpha" logicalId="dev.builder" />,
        path: "/test-agent",
      }),
    );
  }

  it("renders all inspector metadata fields with formatted values", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_AGENT_DETAIL,
    });

    renderPropertiesPanel();

    await screen.findByTestId("agent-properties-copy-attach");
    const panel = screen.getByLabelText("Properties");
    expect(panel).toBeTruthy();

    expect(panel.textContent).toContain("claude-code"); // Runtime
    expect(panel.textContent).toContain("acme-build"); // Rig name
    expect(panel.textContent).toContain("builder@acme-build"); // Session
    expect(panel.textContent).toContain("64%"); // Context used
    expect(panel.textContent).toContain("1 in progress"); // Current work
  });

  it("renders context usage visual indicator with percentage calculation", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...MOCK_AGENT_DETAIL,
        contextUsage: {
          ...MOCK_AGENT_DETAIL.contextUsage,
          usedPercentage: 85,
        },
      }),
    });

    renderPropertiesPanel();

    await screen.findByTestId("agent-properties-copy-attach");
    const panel = screen.getByLabelText("Properties");
    expect(panel.textContent).toContain("85%");
  });

  it("copies session name to clipboard and renders feedback indicator", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_AGENT_DETAIL,
    });

    renderPropertiesPanel();

    const copySessionBtn = await screen.findByTestId("agent-properties-copy-session");
    fireEvent.click(copySessionBtn);

    await waitFor(() => {
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith("builder@acme-build");
    });
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("copies tmux attach command to clipboard when clicked", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_AGENT_DETAIL,
    });

    renderPropertiesPanel();

    const copyAttachBtn = await screen.findByTestId("agent-properties-copy-attach");
    fireEvent.click(copyAttachBtn);

    await waitFor(() => {
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith("tmux attach -t builder@acme-build");
    });
  });

  it("hides tmux attach command row when a remote host is active", async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/hosts")) {
        return { ok: true, json: async () => ({ selected: "remote_gpu_node", hosts: [] }) };
      }
      return { ok: true, json: async () => MOCK_AGENT_DETAIL };
    });

    renderPropertiesPanel();

    await screen.findByText("claude-code");
    // Remote host must NOT show local tmux attach command
    expect(screen.queryByTestId("agent-properties-copy-attach")).toBeNull();
  });

  it("displays latest error message banner conditionally if error exists", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...MOCK_AGENT_DETAIL,
        latestError: "Rate limit exceeded (tokens per minute)",
      }),
    });

    renderPropertiesPanel();

    expect(await screen.findByText("Rate limit exceeded (tokens per minute)")).toBeTruthy();
  });
});
