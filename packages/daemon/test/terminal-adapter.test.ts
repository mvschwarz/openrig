import { describe, it, expect } from "vitest";
import { TerminalAdapter } from "../src/adapters/terminal-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const MOCK_BINDING: NodeBinding = {
  id: "bind-1",
  nodeId: "node-1",
  tmuxSession: "infra.server@test-rig",
  tmuxWindow: null,
  tmuxPane: null,
  cmuxWorkspace: null,
  cmuxSurface: null,
  updatedAt: "",
  cwd: "/project",
};

describe("TerminalAdapter", () => {
  const adapter = new TerminalAdapter();

  // Test 1
  it("project returns empty success", async () => {
    const result = await adapter.project(
      { entries: [], diagnostics: [], conflicts: [], noOps: [], runtime: "terminal", cwd: "/project" } as any,
      MOCK_BINDING,
    );
    expect(result).toEqual({ projected: [], skipped: [], failed: [] });
  });

  // Test 2
  it("deliverStartup returns empty success", async () => {
    const result = await adapter.deliverStartup([], MOCK_BINDING);
    expect(result).toEqual({ delivered: 0, failed: [] });
  });

  // Test 3
  it("checkReady returns { ready: true } immediately", async () => {
    const result = await adapter.checkReady(MOCK_BINDING);
    expect(result).toEqual({ ready: true });
  });

  it("runtime is 'terminal'", () => {
    expect(adapter.runtime).toBe("terminal");
  });

  it("listInstalled returns empty array", async () => {
    const result = await adapter.listInstalled(MOCK_BINDING);
    expect(result).toEqual([]);
  });

  // NS-T04
  it("launchHarness is no-op returning ok", async () => {
    const result = await adapter.launchHarness(MOCK_BINDING, { name: "infra.server@test-rig" });
    expect(result).toEqual({ ok: true });
  });
});
