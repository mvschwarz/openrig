import { describe, it, expect, vi } from "vitest";
import { createCmuxCliTransport } from "../src/adapters/cmux-transport.js";
import type { ExecFn } from "../src/adapters/tmux.js";

describe("cmux CLI transport", () => {
  it("request('capabilities') -> exact: cmux capabilities --json", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue('{"capabilities":["workspace.list"]}');
    const factory = createCmuxCliTransport(exec);
    const transport = await factory();

    await transport.request("capabilities");

    expect(exec).toHaveBeenCalledWith("cmux capabilities --json");
  });

  it("request('workspace.list') -> exact: cmux list-workspaces --json", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue('{"workspaces":[]}');
    const factory = createCmuxCliTransport(exec);
    const transport = await factory();

    await transport.request("workspace.list");

    expect(exec).toHaveBeenCalledWith("cmux list-workspaces --json");
  });

  it("request('surface.list') -> exact: cmux list-surfaces --json", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue('{"surfaces":[]}');
    const factory = createCmuxCliTransport(exec);
    const transport = await factory();

    await transport.request("surface.list");

    expect(exec).toHaveBeenCalledWith("cmux list-surfaces --json");
  });

  it("request('surface.focus') -> exact: cmux focus-surface 's-1'", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const factory = createCmuxCliTransport(exec);
    const transport = await factory();

    await transport.request("surface.focus", { surfaceId: "s-1" });

    expect(exec).toHaveBeenCalledWith("cmux focus-surface 's-1'");
  });

  it("request('surface.sendText') -> exact: cmux send-surface 's-1' 'hello'", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const factory = createCmuxCliTransport(exec);
    const transport = await factory();

    await transport.request("surface.sendText", { surfaceId: "s-1", text: "hello" });

    expect(exec).toHaveBeenCalledWith("cmux send-surface 's-1' 'hello'");
  });

  it("cmux not found (exec throws) -> factory throws", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found: cmux"), { code: "ENOENT" })
    );
    const factory = createCmuxCliTransport(exec);

    // Factory calls exec to verify cmux exists
    await expect(factory()).rejects.toThrow();
  });

  it("cmux returns invalid JSON for --json command -> request rejects", async () => {
    const exec = vi.fn<ExecFn>().mockImplementation(async (cmd: string) => {
      if (cmd.includes("capabilities")) return '{"capabilities":["workspace.list"]}';
      return "this is not json {{{";
    });
    const factory = createCmuxCliTransport(exec);
    const transport = await factory();

    await expect(transport.request("workspace.list")).rejects.toThrow(/JSON/i);
  });

  it("workspace.agentPIDs maps to 'cmux agent-pids --json'", async () => {
    const exec: ExecFn = vi.fn(async (cmd: string) => {
      if (cmd.includes("capabilities")) return '{"capabilities":[]}';
      if (cmd === "cmux agent-pids --json") return '{"agents":[{"pid":1234,"runtime":"claude_code"}]}';
      throw new Error(`unexpected: ${cmd}`);
    }) as unknown as ExecFn;
    const factory = createCmuxCliTransport(exec);
    const transport = await factory();

    const result = await transport.request("workspace.agentPIDs");
    expect(result).toEqual({ agents: [{ pid: 1234, runtime: "claude_code" }] });
    expect(exec).toHaveBeenCalledWith("cmux agent-pids --json");
  });
});
