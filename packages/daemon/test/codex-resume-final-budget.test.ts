import { describe, expect, it, vi } from "vitest";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const refusal = "Your access token could not be refreshed. Please sign in again.";
const incompatible = "This model requires a newer version of Codex.";
const inconclusive = "fixture output remains inconclusive";
const cases = [
  { name: "access-token refusal", output: refusal,
    expected: { ok: false, code: "attention_required", evidence: expect.stringContaining(refusal) } },
  { name: "incompatible client", output: incompatible,
    expected: { ok: false, code: "attention_required", evidence: expect.stringContaining(incompatible) } },
  { name: "missing session", output: "Error: No saved session found for that token.",
    expected: { ok: false, code: "retry_fresh", message: "Codex resume failed: no saved session found for the requested token" } },
  { name: "ready prompt", output: "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything", expected: { ok: true } },
  { name: "occupied shell", output: inconclusive,
    expected: { ok: false, code: "attention_required",
      message: "Codex resume could not be verified; launch retained: the pane shows a shell that isn't a proven idle shell, so a launch script may still be starting Codex.",
      evidence: expect.stringContaining(inconclusive) } },
];

// Keep the production default boundary here; the native suite proves terminal delivery and
// OS process observation with two loop reads plus the final read, using the same adapter.
describe.each([
  { name: "default budget", options: {}, loopReads: 26, pollMs: 200 },
  { name: "native fixture budget", options: { maxWaitMs: 200, pollMs: 200 }, loopReads: 2, pollMs: 200 },
  { name: "minimum budget", options: { maxWaitMs: 0, pollMs: 200 }, loopReads: 1, pollMs: 200 },
])("Codex final observation: $name", ({ options, loopReads, pollMs }) => {
  it.each(cases)("classifies $name only after exhausting the loop", async ({ output, expected }) => {
    const sleep = vi.fn(async () => {});
    const capture = vi.fn(async (): Promise<string> => {
      if (capture.mock.calls.length <= loopReads) return "fixture waiting for final observation";
      expect(sleep).toHaveBeenCalledTimes(loopReads - 1);
      return output;
    });
    const tmux = {
      sendShellCommand: vi.fn(async () => ({ ok: true })),
      getPaneCommand: vi.fn(async () => "sh"),
      capturePaneContent: capture,
      getPanePid: vi.fn(async () => 100),
    } as unknown as TmuxAdapter;
    const adapter = new CodexResumeAdapter(tmux, {
      ...options, sleep,
      // The pane shell has a foreground child: it must never be classified as idle.
      listProcesses: () => [
        { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "bash", startedAt: "Fri Oct 17 06:00:00 2026" },
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "sh fixture", startedAt: "Fri Oct 17 06:00:01 2026" },
      ],
    });
    expect(await adapter.resume("fixture", "codex_id", "fixture-id", "/repo")).toMatchObject(expected);
    expect(capture).toHaveBeenCalledTimes(loopReads + 1);
    expect(sleep).toHaveBeenCalledTimes(loopReads - 1);
    for (const call of sleep.mock.calls) expect(call).toEqual([pollMs]);
  });
});
