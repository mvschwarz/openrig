import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mcpCommand } from "../src/commands/mcp.js";
import { DaemonClient } from "../src/client.js";
import * as lifecycle from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn(() => {
    queueMicrotask(() => process.stdin.emit("end"));
    return { close: vi.fn(async () => {}) };
  }),
}));

function deps(): { deps: StatusDeps; clientFactory: ReturnType<typeof vi.fn> } {
  const clientFactory = vi.fn((url: string) => new DaemonClient(url));
  return { deps: { lifecycleDeps: { exists: () => false } as never, clientFactory }, clientFactory };
}

describe("rig mcp serve --port", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it("refuses a non-numeric port before starting the server", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", "--port", "abc"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Invalid port number"));
    expect(clientFactory).not.toHaveBeenCalled();
    expect(serveStdio).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "65536", "99999"])("warns once and starts with port %s unchanged", async (port) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", "--port", port], { from: "user" });
    expect(process.exitCode).toBeUndefined();
    expect(err).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`Warning: daemon port ${port}`));
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith(`http://127.0.0.1:${port}`);
    expect(serveStdio).toHaveBeenCalledOnce();
  });

  it.each(["1", "7433", "65535", "7433suffix"])("keeps the existing parseInt behavior for %s", async (port) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", "--port", port], { from: "user" });
    expect(process.exitCode).toBeUndefined();
    expect(err).not.toHaveBeenCalled();
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith(`http://127.0.0.1:${parseInt(port, 10)}`);
  });

  it.each([{ args: [] }, { args: ["--port", ""] }])("uses the daemon endpoint for empty or omitted port ($args)", async ({ args }) => {
    const status = vi.spyOn(lifecycle, "getDaemonStatus").mockResolvedValue({ state: "running", host: "::1", port: 8123 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", ...args], { from: "user" });
    expect(status).toHaveBeenCalledOnce();
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith("http://[::1]:8123");
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
