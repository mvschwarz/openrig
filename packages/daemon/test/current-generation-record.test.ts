// D-a — the current-generation join: the live pane process IS the occupant; stored records
// (sidecar, registry token) proved capable of going stale TOGETHER on the live specimen.

import { describe, it, expect } from "vitest";
import {
  resolveLiveClaudeSessionId,
  resolveLiveCodexThreadId,
  type ProcessRow,
} from "../src/domain/model-divergence/current-generation-record.js";

const TABLE: ProcessRow[] = [
  { pid: 10, ppid: 1, command: "-zsh" },
  { pid: 20, ppid: 10, command: "claude --permission-mode acceptEdits --session-id daaeb7b4-841b-45cb-8a33-b062e0ce8296 --name dev-planner@r" },
  { pid: 30, ppid: 10, command: "/usr/local/bin/codex --yolo resume 019f6343-aaaa-bbbb-cccc-ddddeeeeffff" },
  { pid: 40, ppid: 20, command: "node some-child" },
];

const deps = {
  getPanePid: async () => 10,
  listProcesses: async () => TABLE,
  readThreadIdByPid: (pid: number) => (pid === 30 ? "thread-live-123" : undefined),
};

describe("resolveLiveClaudeSessionId", () => {
  it("reads the LIVE occupant's session uuid from its own launch arguments (the specimen shape)", async () => {
    const out = await resolveLiveClaudeSessionId("dev-planner@r", deps);
    expect(out).toEqual({ ok: true, id: "daaeb7b4-841b-45cb-8a33-b062e0ce8296" });
  });

  it("no pane pid / no claude process / no id argument each yield a NAMED reason, never a silent null", async () => {
    const none = await resolveLiveClaudeSessionId("s", { ...deps, getPanePid: async () => null });
    expect(!none.ok && none.reason).toContain("no live pane pid");
    const noClaude = await resolveLiveClaudeSessionId("s", { ...deps, listProcesses: async () => [{ pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noClaude.ok && noClaude.reason).toContain("no claude process");
    const noArg = await resolveLiveClaudeSessionId("s", { ...deps, listProcesses: async () => [{ pid: 20, ppid: 10, command: "claude --name x" }, { pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noArg.ok && noArg.reason).toContain("no --session-id/--resume argument");
  });
});

describe("resolveLiveCodexThreadId", () => {
  it("joins through the live codex pid's logs, bypassing any stored token", async () => {
    const out = await resolveLiveCodexThreadId("s", deps);
    expect(out).toEqual({ ok: true, id: "thread-live-123" });
  });

  it("a codex process whose logs yield nothing is a NAMED reason", async () => {
    const out = await resolveLiveCodexThreadId("s", { ...deps, readThreadIdByPid: () => undefined });
    expect(!out.ok && out.reason).toContain("yielded no thread id");
  });
});
