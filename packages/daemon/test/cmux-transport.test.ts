import { describe, it, expect, vi } from "vitest";
import { createCmuxCliTransport } from "../src/adapters/cmux-transport.js";
import type { ExecFn } from "../src/adapters/tmux.js";

/**
 * Synthesize a fragment of `cmux --help` output for adapter probing.
 * cmux ≥0.63 exposes `list-panels` / `list-panes` / `list-pane-surfaces` and
 * has removed the older `list-surfaces` and `agent-pids` commands.
 * cmux <0.63 exposed `list-surfaces` and `agent-pids` instead.
 */
function helpText(opts: { modern?: boolean; legacy?: boolean }): string {
  const lines = [
    "cmux - control cmux via Unix socket",
    "",
    "Commands:",
    "  version",
    "  capabilities",
    "  list-workspaces",
    "  current-workspace",
    "  new-surface [--type <terminal|browser>] [--workspace <id|ref>]",
    "  focus-panel --panel <id|ref> [--workspace <id|ref>]",
    "  send [--workspace <id|ref>] [--surface <id|ref>] <text>",
  ];
  if (opts.modern) {
    lines.push(
      "  list-panes [--workspace <id|ref>]",
      "  list-pane-surfaces [--workspace <id|ref>] [--pane <id|ref>]",
      "  list-panels [--workspace <id|ref>]"
    );
  }
  if (opts.legacy) {
    lines.push("  list-surfaces", "  agent-pids");
  }
  return lines.join("\n") + "\n";
}

/**
 * Mock exec that answers `cmux --help` with a synthesized surface and
 * delegates any other command to `overrides`. Unmatched commands resolve
 * to empty string.
 */
function mockExec(opts: {
  modern?: boolean;
  legacy?: boolean;
  overrides?: Record<string, string | ((cmd: string) => string)>;
} = {}): ExecFn {
  const impl = async (cmd: string): Promise<string> => {
    if (cmd === "cmux --help") return helpText(opts);
    if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
    if (opts.overrides && cmd in opts.overrides) {
      const v = opts.overrides[cmd];
      return typeof v === "function" ? v(cmd) : v;
    }
    return "";
  };
  return vi.fn(impl) as unknown as ExecFn;
}

describe("cmux CLI transport — factory / surface detection", () => {
  it("factory probes `cmux --help` at connect time", async () => {
    const exec = mockExec({ modern: true });
    const factory = createCmuxCliTransport(exec);

    await factory();

    expect(exec).toHaveBeenCalledWith("cmux --help");
  });

  it("factory throws when `cmux --help` errors (e.g., cmux not installed)", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("command not found: cmux"), { code: "ENOENT" });
    }) as unknown as ExecFn;
    const factory = createCmuxCliTransport(exec);

    await expect(factory()).rejects.toThrow();
  });
});

describe("cmux CLI transport — stable commands (unchanged across versions)", () => {
  it("request('capabilities') -> exact: cmux capabilities --json", async () => {
    const exec = mockExec({ modern: true, overrides: { "cmux capabilities --json": '{"capabilities":["workspace.list"]}' } });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("capabilities");

    expect(exec).toHaveBeenCalledWith("cmux capabilities --json");
  });

  it("request('workspace.list') -> exact: cmux list-workspaces --json", async () => {
    const exec = mockExec({ modern: true, overrides: { "cmux list-workspaces --json": '{"workspaces":[]}' } });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("workspace.list");

    expect(exec).toHaveBeenCalledWith("cmux list-workspaces --json");
  });

  it("request('workspace.current') -> exact: cmux current-workspace --json", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux current-workspace --json": '{"workspace_id":"workspace:1"}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.current");
    expect(exec).toHaveBeenCalledWith("cmux current-workspace --json");
    expect(result).toEqual({ workspace_id: "workspace:1" });
  });

  it("request('workspace.current') falls back to bare legacy handle output", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux current-workspace --json": "3FD8CF06-F6FD-451D-AC6B-1DF15BD0BECA\n" },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.current");
    expect(result).toEqual({ workspace_id: "3FD8CF06-F6FD-451D-AC6B-1DF15BD0BECA" });
  });

  it("request('surface.focus') -> exact: cmux focus-panel --panel 's-1'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.focus", { surfaceId: "s-1" });

    expect(exec).toHaveBeenCalledWith("cmux focus-panel --panel 's-1'");
  });

  it("request('surface.focus') includes --workspace when provided", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.focus", { surfaceId: "surface:7", workspaceId: "workspace:2" });

    expect(exec).toHaveBeenCalledWith("cmux focus-panel --panel 'surface:7' --workspace 'workspace:2'");
  });

  it("request('surface.sendText') -> exact: cmux send --surface 's-1' 'hello'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.sendText", { surfaceId: "s-1", text: "hello" });

    expect(exec).toHaveBeenCalledWith("cmux send --surface 's-1' 'hello'");
  });

  it("request('surface.sendText') includes --workspace when provided", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.sendText", {
      surfaceId: "surface:7",
      workspaceId: "workspace:2",
      text: "hello",
    });

    expect(exec).toHaveBeenCalledWith("cmux send --surface 'surface:7' --workspace 'workspace:2' 'hello'");
  });

  it("request('surface.create') -> exact: cmux new-surface --type terminal --workspace 'workspace:2' --json", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux new-surface --type 'terminal' --workspace 'workspace:2' --json":
          '{"created_surface_ref":"surface:9","workspace_id":"workspace:2","pane_id":"pane:3"}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("surface.create", { workspaceId: "workspace:2", type: "terminal" });
    expect(exec).toHaveBeenCalledWith(
      "cmux new-surface --type 'terminal' --workspace 'workspace:2' --json"
    );
    expect(result).toEqual({
      created_surface_ref: "surface:9",
      workspace_id: "workspace:2",
      pane_id: "pane:3",
    });
  });

  it("request('surface.create') falls back to bare legacy handle output", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux new-surface --type 'terminal' --workspace 'workspace:2' --json": "surface:9\n" },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("surface.create", { workspaceId: "workspace:2", type: "terminal" });
    expect(result).toEqual({ created_surface_ref: "surface:9" });
  });

  it("request('surface.create') extracts the surface ref from legacy OK summary output", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: {
        "cmux new-surface --type 'terminal' --workspace 'workspace:1' --json":
          "OK surface:78 pane:2 workspace:1\n",
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("surface.create", { workspaceId: "workspace:1", type: "terminal" });
    expect(result).toEqual({ created_surface_ref: "surface:78" });
  });

  it("surface.focus uses modern 'cmux focus-panel --panel' not old 'cmux focus-surface'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.focus", { surfaceId: "surface:7" });

    const focusCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("focus") && (c[0] as string) !== "cmux --help"
    );
    expect(focusCall).toBeDefined();
    expect(focusCall![0]).toBe("cmux focus-panel --panel 'surface:7'");
    expect(focusCall![0]).not.toContain("focus-surface");
  });

  it("surface.sendText uses modern 'cmux send --surface' not old 'cmux send-surface'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.sendText", { surfaceId: "surface:7", text: "hello" });

    const sendCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).startsWith("cmux send ")
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![0]).toBe("cmux send --surface 'surface:7' 'hello'");
    expect(sendCall![0]).not.toContain("send-surface");
  });
});

describe("cmux CLI transport — version-adaptive surface listing", () => {
  it("surface.list on modern cmux uses `list-panels --json` (legacy `list-surfaces` removed)", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux list-panels --json": '{"panels":[{"id":"surface:1","title":"term","type":"terminal"}]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.list");

    const listCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("list-")
        && (c[0] as string) !== "cmux --help"
    );
    expect(listCall![0]).toBe("cmux list-panels --json");
    expect(listCall![0]).not.toContain("list-surfaces");
  });

  it("surface.list on modern cmux normalizes `panels` payload to `surfaces`", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-panels --json":
          '{"panels":[{"id":"surface:1","title":"term","type":"terminal"}]}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = (await transport.request("surface.list")) as { surfaces: unknown };
    expect(result).toEqual({ surfaces: [{ id: "surface:1", title: "term", type: "terminal" }] });
  });

  it("surface.list on modern cmux honors workspaceId via --workspace", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux list-panels --workspace 'workspace:2' --json": '{"panels":[]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.list", { workspaceId: "workspace:2" });

    expect(exec).toHaveBeenCalledWith("cmux list-panels --workspace 'workspace:2' --json");
  });

  it("surface.list on legacy cmux falls back to `list-surfaces --json`", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux list-surfaces --json": '{"surfaces":[]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.list");

    expect(exec).toHaveBeenCalledWith("cmux list-surfaces --json");
  });

  it("surface.list throws a structured `unavailable` error when neither command is present", async () => {
    // Help has neither list-panels nor list-surfaces — adapter cannot satisfy the method.
    const exec = mockExec({});
    const transport = await createCmuxCliTransport(exec)();

    await expect(transport.request("surface.list")).rejects.toMatchObject({
      code: "unavailable",
      method: "surface.list",
    });
  });
});

describe("cmux CLI transport — agent-pids surface (legacy-only)", () => {
  it("workspace.agentPIDs on legacy cmux maps to `cmux agent-pids --json`", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux agent-pids --json": '{"agents":[{"pid":1234,"runtime":"claude_code"}]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.agentPIDs");

    expect(result).toEqual({ agents: [{ pid: 1234, runtime: "claude_code" }] });
    expect(exec).toHaveBeenCalledWith("cmux agent-pids --json");
  });

  it("workspace.agentPIDs on modern cmux throws structured `unavailable` (command removed)", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await expect(transport.request("workspace.agentPIDs")).rejects.toMatchObject({
      code: "unavailable",
      method: "workspace.agentPIDs",
    });
  });

  it("workspace.agentPIDs never calls the removed command when cmux is modern", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("workspace.agentPIDs").catch(() => undefined);

    expect(exec).not.toHaveBeenCalledWith("cmux agent-pids --json");
  });
});

describe("cmux CLI transport — JSON parse honesty", () => {
  it("cmux returns invalid JSON for --json command -> request rejects", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux list-workspaces --json": "this is not json {{{" },
    });
    const transport = await createCmuxCliTransport(exec)();

    await expect(transport.request("workspace.list")).rejects.toThrow(/JSON/i);
  });
});
