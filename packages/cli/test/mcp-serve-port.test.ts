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

// An app starts its stdio server when it starts, often before the daemon (a plugin installed, then reloaded, then
// rig up): the server stays up and reaches the daemon once it answers.
describe("rig mcp serve before the daemon is running", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("serves over stdio anyway, with the guard's words, aimed at the configured endpoint", async () => {
    vi.stubEnv("OPENRIG_PORT", "8124");
    vi.spyOn(lifecycle, "getDaemonStatus").mockResolvedValue({ state: "stopped" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", "--front-door"], { from: "user" });
    expect(process.exitCode).toBeUndefined();
    expect(serveStdio).toHaveBeenCalledOnce();
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:8124");
    expect(err.mock.calls.map(([line]) => line)).toEqual([
      "Error: Daemon not running.",
      "  This command needs a running daemon.",
      "  Run 'rig up' (it auto-starts the daemon), or 'rig daemon start'.",
      "rig mcp serve: serving anyway. Tool calls go to the daemon at http://127.0.0.1:8124 and fail until it answers there.",
    ]);
  });

  it("keeps the endpoint the status names, such as a launch in progress", async () => {
    vi.spyOn(lifecycle, "getDaemonStatus").mockResolvedValue({ state: "unverified", host: "::1", port: 8125, startPending: { pid: 4242 }, probeErrorCode: "ECONNREFUSED" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve"], { from: "user" });
    expect(process.exitCode).toBeUndefined();
    expect(serveStdio).toHaveBeenCalledOnce();
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith("http://[::1]:8125");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Error: Daemon is starting (launch reserved by pid 4242)"));
    expect(err).toHaveBeenCalledWith("rig mcp serve: serving anyway. Tool calls go to the daemon at http://[::1]:8125 and fail until it answers there.");
  });

  it("checks its flags before the daemon, so a refused invocation never says it's serving", async () => {
    const status = vi.spyOn(lifecycle, "getDaemonStatus").mockResolvedValue({ state: "stopped" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", "--grant-service", "https://grants.example"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(status).not.toHaveBeenCalled();
    expect(err.mock.calls.map(([line]) => line)).toEqual(["--grant-service and --grant-service-header-file need --http"]);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(serveStdio).not.toHaveBeenCalled();
  });

  it.each([
    { name: "--http", args: ["--http"], env: {} },
    { name: "OPENRIG_URL", args: [], env: { OPENRIG_URL: "http://127.0.0.1:8126" } },
  ])("still stops with $name when the daemon isn't running", async ({ args, env }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.spyOn(lifecycle, "getDaemonStatus").mockResolvedValue({ state: "stopped" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", ...args], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(serveStdio).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("Error: Daemon not running.");
    expect(err).not.toHaveBeenCalledWith(expect.stringContaining("serving anyway"));
  });
});
