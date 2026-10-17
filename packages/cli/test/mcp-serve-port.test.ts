import { describe, it, expect, vi, afterEach } from "vitest";
import { mcpCommand } from "../src/commands/mcp.js";
import { DaemonClient } from "../src/client.js";
import type { StatusDeps } from "../src/commands/status.js";

function deps(): { deps: StatusDeps; clientFactory: ReturnType<typeof vi.fn> } {
  const clientFactory = vi.fn((url: string) => new DaemonClient(url));
  return { deps: { lifecycleDeps: {} as never, clientFactory }, clientFactory };
}

describe("rig mcp serve --port", () => {
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it.each(["abc", "0", "-1", "65536", "99999"])("refuses %s before starting the server", async (port) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, clientFactory } = deps();
    await mcpCommand(d).parseAsync(["serve", "--port", port], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Invalid port number"));
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
