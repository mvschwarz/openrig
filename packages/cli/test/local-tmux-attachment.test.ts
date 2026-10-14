import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import { readLocalOrigin } from "../src/local-origin.js";
import { sharedTuiTarget } from "../src/shared-tui.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";

vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: vi.fn(() => "local-instance") }));
vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://127.0.0.1:7433"),
}));

beforeEach(() => {
  vi.mocked(readLocalOrigin).mockReturnValue("local-instance");
  vi.stubEnv("OPENRIG_SESSION_NAME", "");
  vi.stubEnv("RIGGED_SESSION_NAME", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined; });

// A port forward serves the remote daemon's identity and bindings on loopback.
// Use the real transport/identity path; only HTTP responses and local launches are inert.
function forwardedClient(serverArgs: string[]) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const route = new URL(String(input)).pathname;
    const routes: Record<string, unknown> = {
      "/healthz": { selfHostId: "remote-instance" },
      "/api/terminal/status": { tmux: { serverArgs } },
      "/api/ps": [{ rigId: "remote-kernel", rigName: "kernel" }],
      "/api/rigs/remote-kernel/nodes": [{ logicalId: "operator.human", runtime: "terminal",
        canonicalSessionName: "namesake", tmuxAttachCommand: "tmux attach -t namesake", tmuxServerArgs: serverArgs }],
      "/api/terminal/preview": { planId: "remote-plan", status: {}, composed: {
        id: "kernel", localTmuxServer: serverArgs, opened: [{ seat: "namesake", label: "namesake", paneCommand: "tmux attach -t namesake" }],
        pages: [[{ seat: "namesake", label: "namesake", paneCommand: "tmux attach -t namesake" }]], absent: [], degraded: [],
      } },
    };
    return new Response(JSON.stringify(routes[route] ?? {}));
  });
  return { client: new DaemonClient("http://127.0.0.1:7433", { fetchImpl: fetchImpl as typeof fetch }), fetchImpl };
}

describe.each([{ serverArgs: [] }, { serverArgs: ["-S", "/private/remote.sock"] }])("forwarded tmux attachment ($serverArgs)", ({ serverArgs }) => {
  it("refuses terminal attach before spawning a local namesake", async () => {
    const { client, fetchImpl } = forwardedClient(serverArgs);
    const attachTmux = vi.fn(async () => 0);
    const deps: TerminalDeps = { lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], clientFactory: () => client, attachTmux };
    await new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", "attach", "namesake"], { from: "user" });
    expect(attachTmux).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("instance identity"));
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(["http://127.0.0.1:7433/healthz"]);
  });

  it("refuses to resolve a shared terminal from the forwarded daemon", async () => {
    const { client, fetchImpl } = forwardedClient(serverArgs);
    await expect(sharedTuiTarget(client)).rejects.toThrow("instance identity");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(["http://127.0.0.1:7433/healthz"]);
  });

  it("refuses a desktop window before inspecting or launching local providers", async () => {
    const { client, fetchImpl } = forwardedClient(serverArgs);
    const deps: WindowDeps = { platform: "linux", env: {}, exists: vi.fn(() => false), exec: vi.fn(async () => ""),
      launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), id: () => "unused", herdrConfig: vi.fn(() => "unused") };
    const result = await openTerminalWindow(client, "saved:kernel", "tmux", deps);
    expect(result).toMatchObject({ ok: false, opened: [], windowAttempted: false });
    expect(result.error).toContain("instance identity");
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(["http://127.0.0.1:7433/healthz"]);
  });
});
