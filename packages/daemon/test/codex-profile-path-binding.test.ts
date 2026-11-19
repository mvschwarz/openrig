import { expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { execRuntimeProbe } from "../src/adapters/runtime-probe-exec.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

vi.mock("../src/adapters/runtime-probe-exec.js", () => ({ execRuntimeProbe: vi.fn(async () => "") }));
it.each(["", "selected-tools"])("binds the default profile load probe to cwd and PATH without an explicit home: %s", async launchPath => {
  vi.mocked(execRuntimeProbe).mockClear();
  const cwd = resolve("/synthetic seat");
  const tmux = { sendShellCommand: vi.fn(async () => ({ ok: true })), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
    hasSession: async () => true, getPaneCommand: async () => "codex", capturePaneContent: async () => "OpenAI Codex\n› Ask Codex", getPanePid: async () => null } as unknown as TmuxAdapter;
  const adapter = new CodexRuntimeAdapter({ tmux, launchPath, sleep: async () => {}, listProcesses: () => [],
    fsOps: { exists: () => false, readFile: () => { throw Error("fixture missing"); }, writeFile: () => {}, mkdirp: () => {} } });
  await adapter.launchHarness({ cwd, tmuxSession: "synthetic", codexConfigProfile: "fixture" } as NodeBinding, { name: "synthetic" });
  const resume = new CodexResumeAdapter(tmux, { launchPath, sleep: async () => {}, maxWaitMs: 0 });
  await resume.resume("synthetic", "codex_id", "synthetic-id", cwd, "fixture");
  const calls = vi.mocked(execRuntimeProbe).mock.calls;
  expect(calls).toHaveLength(2);
  for (const [site, command, options] of calls) {
    expect(site).toMatch(/codex\.(runtime|resume)\.profile_preflight/);
    expect(command).toContain("codex -p fixture mcp list");
    expect(options?.cwd).toBe(cwd);
    expect(options?.env?.PATH).toBe(launchPath);
  }
});
