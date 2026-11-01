import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import { readLocalOrigin } from "../src/local-origin.js";
import { sharedTuiTarget } from "../src/shared-tui.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { shellQuote } from "../src/cross-host-executor.js";

vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: vi.fn(() => "local-instance") }));
vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://127.0.0.1:7433"),
}));

beforeEach(() => {
  vi.mocked(readLocalOrigin).mockClear().mockReturnValue("local-instance");
  vi.stubEnv("OPENRIG_SESSION_NAME", "");
  vi.stubEnv("RIGGED_SESSION_NAME", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined; });

// A port forward serves the remote daemon's identity and bindings on loopback.
// Use the real transport/identity path; only HTTP responses and local launches are inert.
function forwardedClient(serverArgs: string[], mode: "inherit" | "isolated" | undefined, targetIdentity = "remote-instance") {
  // A pending request must never override the effective mode of surviving seats.
  const tmux = { serverArgs, ...(mode ? { mode, requestedMode: mode === "inherit" ? "isolated" : "inherit", migrationPending: true } : {}) };
  const pane = { seat: "namesake", label: "namesake", paneCommand: ["tmux", ...serverArgs, "attach", "-t", "namesake"].map(shellQuote).join(" ") };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const route = new URL(String(input)).pathname;
    const routes: Record<string, unknown> = {
      "/healthz": { selfHostId: targetIdentity },
      "/api/terminal/status": { tmux },
      "/api/ps": [{ rigId: "remote-kernel", rigName: "kernel" }],
      "/api/rigs/remote-kernel/nodes": [{ logicalId: "operator.human", runtime: "terminal",
        canonicalSessionName: "namesake", tmuxAttachCommand: pane.paneCommand, tmuxServerArgs: serverArgs, tmuxServerMode: mode }],
      "/api/terminal/preview": { planId: "remote-plan", status: {}, tmux, composed: {
        id: "kernel", localTmuxServer: serverArgs, opened: [pane],
        pages: [[pane]], absent: [], degraded: [],
      } },
    };
    return new Response(JSON.stringify(routes[route] ?? {}));
  });
  return { client: new DaemonClient("http://127.0.0.1:7433", { fetchImpl: fetchImpl as typeof fetch }), fetchImpl };
}

describe.each([{ serverArgs: [] }, { serverArgs: ["-S", "/private/remote.sock"] }])("forwarded isolated tmux attachment ($serverArgs)", ({ serverArgs }) => {
  it("refuses terminal attach before spawning a local namesake", async () => {
    const { client, fetchImpl } = forwardedClient(serverArgs, "isolated");
    const attachTmux = vi.fn(async () => 0);
    const deps: TerminalDeps = { lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], clientFactory: () => client, attachTmux };
    await new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", "attach", "namesake"], { from: "user" });
    expect(attachTmux).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("instance identity"));
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/terminal/status", "/healthz"]);
  });

  it("refuses to resolve a shared terminal from the forwarded daemon", async () => {
    const { client, fetchImpl } = forwardedClient(serverArgs, "isolated");
    await expect(sharedTuiTarget(client)).rejects.toThrow("instance identity");
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/ps", "/api/rigs/remote-kernel/nodes", "/healthz"]);
  });

  it("refuses a desktop window before launching or creating a local viewer", async () => {
    const { client, fetchImpl } = forwardedClient(serverArgs, "isolated");
    const deps: WindowDeps = { platform: "linux", env: {}, exists: vi.fn(() => false), exec: vi.fn(async () => ""),
      launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), id: () => "unused", herdrConfig: vi.fn(() => "unused") };
    const result = await openTerminalWindow(client, "saved:kernel", "tmux", deps);
    expect(result).toMatchObject({ ok: false, opened: [], windowAttempted: false });
    expect(result.error).toContain("instance identity");
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/terminal/preview", "/healthz"]);
  });
});

async function openLocalAttachments(client: DaemonClient, serverArgs: string[]) {
  const attachTmux = vi.fn(async () => 0);
  const deps: TerminalDeps = { lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], clientFactory: () => client, attachTmux };
  await new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", "attach", "namesake"], { from: "user" });
  expect(attachTmux).toHaveBeenCalledExactlyOnceWith({ session: "namesake", serverArgs, readOnly: false });
  expect(process.exitCode).toBe(0);
  await expect(sharedTuiTarget(client)).resolves.toEqual({ session: "namesake", serverArgs });

  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/bin/sh") return "/fixture/tmux";
    if (file === "/usr/bin/osascript") return "window";
    if (args.at(-1) === "default-size") return "120x40";
    if (args.at(-1) === "window-size") return "latest";
    if (args.includes("#{pane_id}")) return "%1";
    return "";
  });
  const windowDeps: WindowDeps = { platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, exists: () => false,
    exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), id: () => "inherit-check", herdrConfig: vi.fn(() => "unused") };
  const result = await openTerminalWindow(client, "saved:kernel", "tmux", windowDeps);
  expect(result).toMatchObject({ ok: true, opened: ["namesake"], window: { app: "Terminal" } });
  expect(exec).toHaveBeenCalledWith("/fixture/tmux", [...serverArgs, "new-session", "-d", "-s", "openrig-view-inherit-check", "-n", "view-1", "-P", "-F", "#{pane_id}", expect.any(String)]);
}

describe.each([
  { mode: undefined, serverArgs: [] },
  { mode: "inherit" as const, serverArgs: [] },
  { mode: "inherit" as const, serverArgs: ["-L", "named"] },
  { mode: "inherit" as const, serverArgs: ["-S", "/private/inherited socket"] },
])("legacy and effective inherit attachments ($mode, $serverArgs)", ({ mode, serverArgs }) => {
  it.each(["different-local-instance", null])("keeps all three local paths working with local identity %j", async origin => {
    vi.mocked(readLocalOrigin).mockReturnValue(origin);
    const { client, fetchImpl } = forwardedClient(serverArgs, mode);
    await openLocalAttachments(client, serverArgs);
    expect(readLocalOrigin).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([url]) => new URL(String(url)).pathname === "/healthz")).toBe(false);
  });
});

it("opens all three isolated attachments when the instance identity matches", async () => {
  const serverArgs = ["-S", "/private/local-instance.sock"];
  const { client, fetchImpl } = forwardedClient(serverArgs, "isolated", "local-instance");
  await openLocalAttachments(client, serverArgs);
  expect(fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/healthz")).toHaveLength(3);
});
