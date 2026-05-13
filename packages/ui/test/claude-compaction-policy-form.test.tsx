// Slice 27 — Claude Compaction Policy form tests.
//
// HG-9: form renders + persists settings.
// Also covers:
//   - opt-in default-off rendering (enabled toggle reflects current value)
//   - threshold validation rejects out-of-range values without persisting
//   - submit issues one POST per key against /api/config/:key
//   - shows "Saved." indicator after successful submit

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { ClaudeCompactionPolicyForm } from "../src/components/system/ClaudeCompactionPolicyForm.js";

const mockFetch = vi.fn();
const DEFAULT_COMPACT_INSTRUCTION =
  "Create a concise continuity summary for this OpenRig session. Preserve the active task, queue item IDs, decisions, changed files, commands/tests run, blockers, caveats, and next concrete step.";
const DEFAULT_RESTORE_INSTRUCTION =
  "Load/read the claude-compaction-restore skill and follow its post-compaction restore protocol.";
const DEFAULT_EXTRA_INSTRUCTION_FILE_PATH =
  "/Users/test/.openrig/compaction/post-compact-extra.md";

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

function makeSettingsResponse(overrides: Partial<{
  enabled: boolean;
  thresholdPercent: number;
  compactInstruction: string;
  messageInline: string;
  messageFilePath: string;
}> = {}) {
  return {
    settings: {
      "policies.claude_compaction.enabled": {
        value: overrides.enabled ?? false,
        source: "default",
        defaultValue: false,
      },
      "policies.claude_compaction.threshold_percent": {
        value: overrides.thresholdPercent ?? 80,
        source: "default",
        defaultValue: 80,
      },
      "policies.claude_compaction.compact_instruction": {
        value: overrides.compactInstruction ?? DEFAULT_COMPACT_INSTRUCTION,
        source: "default",
        defaultValue: DEFAULT_COMPACT_INSTRUCTION,
      },
      "policies.claude_compaction.message_inline": {
        value: overrides.messageInline ?? DEFAULT_RESTORE_INSTRUCTION,
        source: "default",
        defaultValue: DEFAULT_RESTORE_INSTRUCTION,
      },
      "policies.claude_compaction.message_file_path": {
        value: overrides.messageFilePath ?? DEFAULT_EXTRA_INSTRUCTION_FILE_PATH,
        source: "default",
        defaultValue: DEFAULT_EXTRA_INSTRUCTION_FILE_PATH,
      },
    },
  };
}

describe("ClaudeCompactionPolicyForm — slice 27", () => {
  it("HG-9: renders form with current settings populated (opt-in default-off shows disabled toggle, 80% threshold)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(makeSettingsResponse()));
    render(createTestRouter({ component: () => <ClaudeCompactionPolicyForm />, path: "/" }));

    // Form body waits for data; assert on input presence to confirm data
    // has loaded before reading values.
    await waitFor(() => expect(screen.getByTestId("claude-compaction-enabled")).toBeDefined());

    const enabled = screen.getByTestId("claude-compaction-enabled") as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    const threshold = screen.getByTestId("claude-compaction-threshold") as HTMLInputElement;
    expect(threshold.value).toBe("80");
    const compactInstruction = screen.getByTestId("claude-compaction-compact-instruction") as HTMLTextAreaElement;
    expect(compactInstruction.value).toBe(DEFAULT_COMPACT_INSTRUCTION);
    const inline = screen.getByTestId("claude-compaction-message-inline") as HTMLTextAreaElement;
    expect(inline.value).toBe(DEFAULT_RESTORE_INSTRUCTION);
    const filePath = screen.getByTestId("claude-compaction-message-file-path") as HTMLInputElement;
    expect(filePath.value).toBe(DEFAULT_EXTRA_INSTRUCTION_FILE_PATH);
  });

  it("HG-9: loads existing non-default values from /api/config when present", async () => {
    mockFetch.mockResolvedValue(jsonResponse(makeSettingsResponse({
      enabled: true,
      thresholdPercent: 65,
      compactInstruction: "Keep decisions and active queue ids.",
      messageInline: "stay calm",
      messageFilePath: "/tmp/m.txt",
    })));
    render(createTestRouter({ component: () => <ClaudeCompactionPolicyForm />, path: "/" }));

    await waitFor(() => {
      expect((screen.getByTestId("claude-compaction-enabled") as HTMLInputElement).checked).toBe(true);
    });
    expect((screen.getByTestId("claude-compaction-threshold") as HTMLInputElement).value).toBe("65");
    expect((screen.getByTestId("claude-compaction-compact-instruction") as HTMLTextAreaElement).value).toBe("Keep decisions and active queue ids.");
    expect((screen.getByTestId("claude-compaction-message-inline") as HTMLTextAreaElement).value).toBe("stay calm");
    expect((screen.getByTestId("claude-compaction-message-file-path") as HTMLInputElement).value).toBe("/tmp/m.txt");
  });

  it("HG-9: submit POSTs each key to /api/config/:key with the user's value", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse(makeSettingsResponse());
    });

    render(createTestRouter({ component: () => <ClaudeCompactionPolicyForm />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("claude-compaction-enabled")).toBeDefined());

    fireEvent.click(screen.getByTestId("claude-compaction-enabled"));
    fireEvent.change(screen.getByTestId("claude-compaction-threshold"), { target: { value: "70" } });
    fireEvent.change(screen.getByTestId("claude-compaction-compact-instruction"), {
      target: { value: "Summarize decisions first." },
    });
    fireEvent.change(screen.getByTestId("claude-compaction-message-inline"), {
      target: { value: "Reload the slice doc before resuming." },
    });

    expect((screen.getByTestId("claude-compaction-enabled") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("claude-compaction-threshold") as HTMLInputElement).value).toBe("70");

    fireEvent.click(screen.getByTestId("claude-compaction-policy-submit"));

    await waitFor(() => {
      expect(calls.filter((c) => c.init?.method === "POST").length).toBeGreaterThanOrEqual(5);
    });

    const postCalls = calls.filter((c) => c.init?.method === "POST");
    const findKey = (key: string) => postCalls.find((c) => c.url.includes(encodeURIComponent(key)));
    expect(findKey("policies.claude_compaction.enabled")?.init?.body as string).toContain("true");
    expect(findKey("policies.claude_compaction.threshold_percent")?.init?.body as string).toContain("70");
    expect(findKey("policies.claude_compaction.compact_instruction")?.init?.body as string).toContain("Summarize decisions first.");
    expect(findKey("policies.claude_compaction.message_inline")?.init?.body as string).toContain("Reload the slice doc before resuming.");
    // message_file_path posted with its default canonical skill file path.
    expect(findKey("policies.claude_compaction.message_file_path")?.init?.body as string).toContain(
      DEFAULT_EXTRA_INSTRUCTION_FILE_PATH,
    );

    await waitFor(() => expect(screen.getByTestId("claude-compaction-policy-saved")).toBeDefined());
  });

  it("HG-9: threshold field is directly editable while typing", async () => {
    mockFetch.mockResolvedValue(jsonResponse(makeSettingsResponse()));
    render(createTestRouter({ component: () => <ClaudeCompactionPolicyForm />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("claude-compaction-enabled")).toBeDefined());

    const threshold = screen.getByTestId("claude-compaction-threshold") as HTMLInputElement;
    fireEvent.change(threshold, { target: { value: "" } });
    expect(threshold.value).toBe("");
    fireEvent.change(threshold, { target: { value: "5" } });
    expect(threshold.value).toBe("5");
  });

  it("HG-9: threshold validation rejects out-of-range values without issuing POSTs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(makeSettingsResponse());
    });

    render(createTestRouter({ component: () => <ClaudeCompactionPolicyForm />, path: "/" }));
    await waitFor(() => expect(screen.getByTestId("claude-compaction-enabled")).toBeDefined());

    fireEvent.change(screen.getByTestId("claude-compaction-threshold"), { target: { value: "101" } });
    fireEvent.click(screen.getByTestId("claude-compaction-policy-submit"));

    await waitFor(() => expect(screen.getByTestId("claude-compaction-threshold-error")).toBeDefined());
    expect(calls.filter((c) => c.init?.method === "POST")).toEqual([]);
  });
});
