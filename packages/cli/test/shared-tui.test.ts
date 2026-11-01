import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { sharedTuiTarget } from "../src/shared-tui.js";
import { tuiCommand } from "../src/commands/tui.js";
import { probeFrontDoor } from "../src/front-door.js";

function client(rigs: unknown, nodes: unknown, status = 200) {
  return { isLocalInstance: vi.fn(async () => true), get: vi.fn(async <T>(path: string) => ({ status, data: (path === "/api/ps" ? rigs : nodes) as T })) };
}
const kernel = [{ rigId: "selected-instance-kernel", rigName: "kernel" }];
const terminal = { podId: "database-pod-id", logicalId: "operator.human", runtime: "terminal", canonicalSessionName: "actual-terminal", tmuxAttachCommand: "tmux attach -t actual-terminal" };

describe("shared kernel TUI", () => {
  it("permits the actual builtin terminal identity without inventing harness diagnostics", async () => {
    const result = await probeFrontDoor({ env: { OPENRIG_NODE_ID: "terminal-id" }, client: {
      get: async () => ({ status: 200, data: { identity: { runtime: "terminal", agentRef: "builtin:terminal" }, permissionDrift: { enforcement: { state: "unknown" } } } }),
    } });
    expect(result).toEqual({ state: "ready" });
  });
  it("uses the selected daemon's binding, without creating a session", async () => {
    const c = client(kernel, [terminal]);
    expect(await sharedTuiTarget(c)).toEqual({ session: "actual-terminal", serverArgs: [] });
    expect(c.get.mock.calls.map(([p]) => p)).toEqual(["/api/ps", "/api/rigs/selected-instance-kernel/nodes"]);
  });
  it("uses structured server metadata even when the caller's tmux server differs", async () => {
    const serverArgs = ["-S", "/private/openrig instance/socket"];
    expect(await sharedTuiTarget(client(kernel, [{ ...terminal, tmuxServerArgs: serverArgs }])))
      .toEqual({ session: "actual-terminal", serverArgs });
    await expect(sharedTuiTarget(client(kernel, [{ ...terminal, tmuxServerArgs: ["kill-server"] }])))
      .rejects.toThrow("invalid tmux server options");
  });
  it("distinguishes no kernel, no terminal, and a failed read", async () => {
    await expect(sharedTuiTarget(client([], []))).rejects.toThrow("No kernel");
    await expect(sharedTuiTarget(client(kernel, [{ ...terminal, runtime: "codex" }]))).rejects.toThrow("no bound shared terminal");
    await expect(sharedTuiTarget(client(kernel, [], 503))).rejects.toThrow("HTTP 503");
    await expect(sharedTuiTarget(client([...kernel, ...kernel], [terminal]))).rejects.toThrow("Multiple kernels");
  });
  it("does not attach a local namesake for a remote daemon", async () => {
    const c = { ...client(kernel, [terminal]), baseUrl: "http://other-machine:7433", isLocalInstance: vi.fn(async () => false) };
    await expect(sharedTuiTarget(c)).rejects.toThrow("local tmux");
    expect(c.get).not.toHaveBeenCalled();
  });
  it("joins the existing terminal instead of launching another TUI", async () => {
    const attachShared = vi.fn(async () => 0);
    const launchTui = vi.fn(async () => 0);
    const exit = vi.fn();
    const target = { session: "actual-terminal", serverArgs: ["-S", "/private/openrig.sock"] };
    const cli = new Command().addCommand(tuiCommand({ stdoutIsTTY: true, stdinIsTTY: true, sharedTarget: async () => target, attachShared, launchTui, exit, err: () => {} }));
    await cli.parseAsync(["node", "rig", "tui", "--shared"]);
    expect(attachShared).toHaveBeenCalledWith(target);
    expect(launchTui).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("a piped shared request never attaches or resolves a target", async () => {
    const sharedTarget = vi.fn();
    const exit = vi.fn();
    const cli = new Command().addCommand(tuiCommand({ stdoutIsTTY: true, stdinIsTTY: false, sharedTarget, exit, err: () => {} }));
    await cli.parseAsync(["node", "rig", "tui", "--shared"]);
    expect(sharedTarget).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
