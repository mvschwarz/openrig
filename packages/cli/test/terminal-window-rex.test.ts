import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { inRex, openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";

const REX = "/opt/rex bin/rex";
const IN_REX = { HOME: "/home/p", TERM_PROGRAM: "rex", REX_SESSION: "session:here", REX_BLOCK: "block:mine", REX_SERVER: "unix:///rex.sock" };
const APP = { client_id: "client:app", connection_state: "connected", info: { kind: "app", label: "laptop" } };
const REMOTE_APP = { client_id: "client:remote", connection_state: "connected", info: { kind: "app", label: "desktop" } };
const CLI = { client_id: "client:cli", info: { kind: "cli", name: "rex" } };
const UNSAID = { client_id: "client:unsaid", connection_state: "connected", info: null };
const notFound = () => Object.assign(new Error("Command failed"), { stderr: "Error: client not found (status=404 code=not_found)\n" });
const SELECTABLE = { actions: [{ name: "session.new" }, { name: "session.select", args: { required: ["session_id"] } }] };

interface Options {
  env?: NodeJS.ProcessEnv;
  callerInstance?: string;
  daemon?: { available: boolean; instanceId?: string; detail?: string };
  clients?: unknown[];
  owner?: string;
  perform?: () => string;
  planId?: string;
  binary?: boolean;
}

/** A rex argv without its global flags: `--autostart=false`, then `-S <server>` when one is set. */
const commandArgs = (args: string[]) => args.slice(args[1] === "-S" ? 3 : 1);

function fixture(o: Options = {}) {
  const pane = { seat: "op@acme", label: "operator", paneCommand: "tmux attach -t 'op@acme'" };
  const get = vi.fn(async (url: string): Promise<{ status: number; data: unknown }> => {
    if (url.startsWith("/api/terminal/status")) {
      const d = o.daemon ?? { available: true, instanceId: "inst-1" };
      return { status: 200, data: { providers: [{ name: "rex", status: { provider: "rex", available: d.available, capabilities: {}, ...(d.instanceId ? { server: { instanceId: d.instanceId } } : {}) }, liveness: { alive: d.available, ...(d.detail ? { detail: d.detail } : {}) } }] } };
    }
    return { status: 200, data: { planId: o.planId ?? "rex-plan", provider: "rex", composed: { id: "rig:acme", opened: [pane], pages: [[pane]], absent: [], degraded: [] } } };
  });
  const post = vi.fn(async (): Promise<{ status: number; data: unknown }> => ({ status: 200, data: {
    provider: "rex", ok: true, opened: ["op@acme"], absent: [], degraded: [], pages: 1, space: { id: "session:new", label: "acme" },
  } }));
  const client = { baseUrl: "http://127.0.0.1:7433", get, post } as unknown as DaemonClient;
  const exec = vi.fn(async (file: string, args: string[]): Promise<string> => {
    if (file === "/bin/sh") {
      if (o.binary === false) throw new Error("not found");
      return `${REX}\n`;
    }
    if (file !== REX) throw new Error(`unexpected ${file}`);
    const rest = commandArgs(args);
    if (rest[0] === "whoami") return JSON.stringify({ instance_id: o.callerInstance ?? "inst-1" });
    const [method, params] = [rest[2], JSON.parse(rest[3] ?? "{}")];
    if (method === "session.list_clients" || method === "client.list") return JSON.stringify({ clients: o.clients ?? [APP, CLI] });
    if (method === "client.inspect") {
      if (params.client_id === CLI.client_id || params.client_id === UNSAID.client_id) throw notFound();
      return JSON.stringify({ client: {}, ...SELECTABLE });
    }
    if (method === "session.list_blocks") return JSON.stringify({ blocks: [{ block_id: "block:mine", owner: o.owner }] });
    if (method === "client.perform") return o.perform ? o.perform() : JSON.stringify({ performed_by: params.client_id });
    throw new Error(`unexpected ${method}`);
  });
  const deps: WindowDeps = { platform: "darwin", env: o.env ?? IN_REX, exists: () => false, exec, launch: vi.fn(), sleep: vi.fn(), id: () => "unused", herdrConfig: vi.fn(() => "/unused"), columns: async () => 132 };
  const rexCalls = () => exec.mock.calls.filter(([file]) => file === REX).map(([, args]) => commandArgs(args)).map((rest) => rest[0] === "whoami" ? "whoami" : `${rest[2]} ${rest[3]}`);
  return { client, deps, get, post, exec, rexCalls };
}

describe("rig terminal open --window from Rex", () => {
  it("opens the view in the caller's own Rex server and switches the app that shows it", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps, "rex-plan");
    expect(result).toMatchObject({ provider: "rex", ok: true, opened: ["op@acme"], space: { id: "session:new", label: "acme" } });
    expect(result.notes).toEqual(['The Rex app "laptop" switched to session "acme".']);
    expect(f.get.mock.calls.map(([url]) => url)).toEqual(["/api/terminal/status?provider=rex", "/api/terminal/preview?view=acme&provider=rex&viewportColumns=132"]);
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "acme", provider: "rex", expectedPlan: "rex-plan", viewportColumns: 132 }, { timeoutMs: 45_000 });
    expect(f.rexCalls()).toEqual([
      "whoami",
      'session.list_clients {"session_id":"session:here"}',
      'client.inspect {"client_id":"client:app"}',
      'client.perform {"client_id":"client:app","action":"session.select","args":{"session_id":"session:new"},"origin":"cli","timeout_ms":10000}',
    ]);
    expect(f.exec.mock.calls.filter(([file]) => file === REX).every(([, args]) => args[0] === "--autostart=false" && args[1] === "-S" && args[2] === "unix:///rex.sock")).toBe(true);
    expect(f.deps.launch).not.toHaveBeenCalled();
  });

  it("asks the caller's own Rex server with -S, since rex ignores REX_SERVER from the environment", async () => {
    const f = fixture({ env: { ...IN_REX, REX_SERVER: " unix:///tmp/rex%20home/server.sock " } });
    await openTerminalWindow(f.client, "acme", undefined, f.deps);
    const whoami = f.exec.mock.calls.find(([file, args]) => file === REX && args.includes("whoami"))![1];
    expect(whoami).toEqual(["--autostart=false", "-S", "unix:///tmp/rex%20home/server.sock", "whoami", "--json"]);
  });

  it("passes no -S without REX_SERVER, leaving rex's own default server", async () => {
    const f = fixture({ env: { HOME: "/home/p", TERM_PROGRAM: "ghostty" } });
    await openTerminalWindow(f.client, "acme", "rex", f.deps);
    const calls = f.exec.mock.calls.filter(([file]) => file === REX).map(([, args]) => args);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((args) => args[0] === "--autostart=false" && !args.includes("-S"))).toBe(true);
  });

  it("skips this command's own rex client and any client that is gone by the time it is inspected", async () => {
    const f = fixture({ clients: [CLI, UNSAID, APP] });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result.notes).toEqual(['The Rex app "laptop" switched to session "acme".']);
    const inspected = f.rexCalls().filter((call) => call.startsWith("client.inspect"));
    expect(inspected).toEqual(['client.inspect {"client_id":"client:unsaid"}', 'client.inspect {"client_id":"client:app"}']);
  });

  it("takes the Rex path from a tmux inside a Rex block", async () => {
    const f = fixture({ env: { ...IN_REX, TERM_PROGRAM: "tmux" } });
    expect(await openTerminalWindow(f.client, "acme", undefined, f.deps)).toMatchObject({ provider: "rex", ok: true });
  });

  it("picks the app that owns the caller's block when several apps view the session", async () => {
    const f = fixture({ clients: [REMOTE_APP, APP], owner: "client:app" });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result.notes).toEqual(['The Rex app "laptop" switched to session "acme".']);
    expect(f.rexCalls().at(-1)).toContain('"client_id":"client:app"');
  });

  it("switches no app when several could be the one in use, and says which session to pick", async () => {
    const f = fixture({ clients: [REMOTE_APP, APP], owner: "client:other" });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, opened: ["op@acme"] });
    expect(result.notes).toEqual(['Several Rex apps are connected ("desktop", "laptop"), so none was switched; select session "acme" in the one you\'re using.']);
    expect(f.rexCalls().some((call) => call.startsWith("client.perform"))).toBe(false);
  });

  it("keeps the open when the app refuses to switch, and says how to allow it", async () => {
    const f = fixture({ perform: () => { throw Object.assign(new Error("Command failed"), { stderr: "Error: remote control is off (status=403 code=refused)\n" }); } });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, opened: ["op@acme"] });
    expect(result.notes).toEqual(['The Rex app "laptop" did not switch to session "acme" (refused); select it in Rex. To let OpenRig switch it, turn on Remote Control in the app\'s Settings, under Rex Server.']);
  });

  it("says when no app can switch sessions", async () => {
    const f = fixture({ clients: [CLI] });
    expect((await openTerminalWindow(f.client, "acme", undefined, f.deps)).notes).toEqual(['No Rex app that can switch sessions is connected; select session "acme" in Rex.']);
  });

  it("refuses a daemon on a different Rex server, opening nothing anywhere", async () => {
    const f = fixture({ callerInstance: "inst-other" });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result).toMatchObject({ provider: "rex", ok: false, code: "terminal_window_failed", windowAttempted: false, opened: [] });
    expect(result.error).toContain("this terminal uses a different Rex server than the daemon");
    expect(result.error).toContain("rig terminal open 'acme' --window --provider herdr");
    expect(f.post).not.toHaveBeenCalled();
    expect(f.get.mock.calls.map(([url]) => url)).toEqual(["/api/terminal/status?provider=rex"]);
  });

  it.each([
    [{ daemon: { available: false, detail: "the Rex server is not reachable" } }, "the daemon can't reach a Rex server (the Rex server is not reachable)"],
    [{ daemon: { available: true } }, "could not confirm that this terminal and the daemon use the same Rex server"],
    [{ binary: false }, "the rex command was not found here"],
  ] as const)("fails honestly before opening anything: %j", async (options, message) => {
    const f = fixture(options);
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result).toMatchObject({ provider: "rex", ok: false, windowAttempted: false });
    expect(result.error).toContain(message);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("refuses a changed plan before opening", async () => {
    const f = fixture({ planId: "newer" });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps, "rex-plan");
    expect(result).toMatchObject({ ok: false, error: "The terminal view changed since preview. Refresh the preview before opening." });
    expect(f.post).not.toHaveBeenCalled();
  });

  it("an unconfirmed open says to inspect Rex before retrying", async () => {
    const f = fixture();
    f.post.mockRejectedValueOnce(new Error("timeout after 45000ms"));
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: true });
    expect(result.error).toBe("The Rex view outcome could not be confirmed. timeout after 45000ms Inspect Rex's sessions before retrying.");
  });

  it("a daemon that refuses the open opened nothing", async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce({ status: 409, data: { error: "View membership, layout or provider session changed." } });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false, error: "View membership, layout or provider session changed." });
  });

  it("keeps the open when the app list can't be read", async () => {
    const f = fixture();
    const exec = f.exec.getMockImplementation()!;
    f.exec.mockImplementation(async (file, args) => {
      if (commandArgs(args)[2] === "session.list_clients") throw Object.assign(new Error("Command failed"), { stderr: "Error: boom (status=500 code=internal)\n" });
      return exec(file, args);
    });
    const result = await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, opened: ["op@acme"] });
    expect(result.notes).toEqual(['Could not ask a Rex app to show session "acme" (internal); select it in Rex.']);
  });

  it("with --provider rex outside Rex, uses the server's one app", async () => {
    const f = fixture({ env: { HOME: "/home/p", TERM_PROGRAM: "ghostty" } });
    const result = await openTerminalWindow(f.client, "acme", "rex", f.deps);
    expect(result.notes).toEqual(['The Rex app "laptop" switched to session "acme".']);
    expect(f.rexCalls()[1]).toBe("client.list {}");
  });

  it("finds rex in $REX_BIN_DIR first", async () => {
    const f = fixture({ env: { ...IN_REX, REX_BIN_DIR: "/opt/rex bin" } });
    f.deps.exists = (file) => file === REX;
    expect(await openTerminalWindow(f.client, "acme", undefined, f.deps)).toMatchObject({ ok: true });
    expect(f.exec.mock.calls.some(([file]) => file === "/bin/sh")).toBe(false);
  });
});

describe("Rex detection keeps the other paths unchanged", () => {
  it.each([
    [{ TERM_PROGRAM: "rex" }, true],
    [{ TERM_PROGRAM: "tmux", REX_SESSION: "s", REX_BLOCK: "b", REX_SERVER: "x" }, true],
    [{ TERM_PROGRAM: "tmux", REX_SESSION: "s", REX_BLOCK: "b" }, false],
    [{ ...IN_REX, TERM_PROGRAM: "herdr" }, false],
    [{ ...IN_REX, TERM_PROGRAM: "tmux", HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/h.sock" }, false],
    [{ ...IN_REX, HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/h.sock" }, false],
    [{ TERM_PROGRAM: "ghostty" }, false],
  ])("inRex(%j) is %s", (env, expected) => {
    expect(inRex(env)).toBe(expected);
  });

  it("a Herdr pane inside Rex still opens in Herdr", async () => {
    const f = fixture({ env: { ...IN_REX, TERM_PROGRAM: "herdr" } });
    await openTerminalWindow(f.client, "acme", undefined, f.deps);
    expect(f.get.mock.calls[0]![0]).toContain("provider=herdr");
    expect(f.rexCalls()).toEqual([]);
  });

  it("--session stays a Herdr choice, and the recovery doesn't repeat the refused provider", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "acme", "rex", f.deps, undefined, "work");
    expect(result.error).toContain("--session selects a Herdr session; use --provider herdr.");
    expect(result.error).toContain("run: rig terminal open 'acme' --window --session 'work'");
    expect(result.error).not.toContain("--provider 'rex'");
    expect(f.rexCalls()).toEqual([]);
  });
});
