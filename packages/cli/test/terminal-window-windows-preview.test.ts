// Real HTTP routes, composition and TUI/CLI clients; desktop launch and seat liveness are fixtures.
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { DaemonClient as CliClient } from "../src/client.js";
import { DaemonClient as TuiClient } from "../../tui/src/daemon-client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";
import { TerminalService } from "../../daemon/src/domain/terminal/terminal-service.js";
import type { TerminalProvider } from "../../daemon/src/domain/terminal/terminal-provider.js";
import { allowOwnedHttpFixture } from "./helpers/owned-http-fixture.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
});

async function fixture(readOnly = false) {
  const members = ["seat'中文", "seat-two"].map(seat => ({ seat, tmuxSession: `${seat}@fixture`, readOnly }));
  const saved = { id: "fixture", name: "Fixture", members };
  const providerOpens = vi.fn();
  const provider: TerminalProvider = {
    name: "herdr", panesPerPage: 16,
    status: async () => ({ provider: "herdr", available: false, capabilities: { layout: true } }),
    liveness: async () => ({ alive: true }),
    openView: providerOpens,
  };
  const service = new TerminalService({
    localPlatform: "win32", resolveProvider: name => name === "herdr" ? provider : null,
    viewsStore: { get: id => id === "fixture" ? saved : null, list: () => [saved] },
    listRigSeats: () => null, listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [],
    resolveHost: () => null, hasSession: () => true,
    resolveLocalTmux: () => "C:\\Program Files\\psmux\\psmux.exe",
  } as ConstructorParameters<typeof TerminalService>[0]);
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c.set.bind(c) as (key: string, value: unknown) => void)("terminalService", service);
    await next();
  });
  app.route("/api/terminal", terminalRoutes());
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  allowOwnedHttpFixture(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const launch = vi.fn(async (_file: string, _args: string[]) => {});
  const deps: WindowDeps = {
    platform: "win32", env: {}, exists: () => true,
    exec: vi.fn(async file => file.endsWith("\\where.exe") ? "C:\\fixture\\wt.exe\r\n" : "1\r\n"),
    launch, sleep: async () => {}, id: () => "owned",
    herdrConfig: () => { throw new Error("Native view must not prepare Herdr config"); },
  };
  return { saved, baseUrl, launch, deps, providerOpens };
}

it.each([false, true])("carries a real TUI preview plan through native composition to Windows Terminal argv (readOnly=%s)", async readOnly => {
  const f = await fixture(readOnly);
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "tmux", opened: f.saved.members.map(m => m.seat) });
  expect(f.launch).toHaveBeenCalledOnce();
  const [binary, args] = f.launch.mock.calls[0]!;
  expect(binary).toBe("C:\\fixture\\wt.exe");
  const scripts = args.flatMap((arg, i) => arg === "-EncodedCommand" ? [Buffer.from(args[i + 1]!, "base64").toString("utf16le")] : []);
  expect(scripts).toHaveLength(2);
  for (const script of scripts) expect(script).toContain("windows-tile-attach.ps1");
  const payloads = scripts.map(script => JSON.parse(Buffer.from(/\)\)\) '([^']+)'$/.exec(script)![1]!, "base64").toString("utf8")));
  expect(payloads.map(p => p.session)).toEqual(f.saved.members.map(m => m.tmuxSession));
  expect(payloads.every(p => p.tmux === "C:\\Program Files\\psmux\\psmux.exe" && p.readOnly === readOnly)).toBe(true);
  expect(f.providerOpens).not.toHaveBeenCalled();
});

it("refuses a changed real native view after TUI preview before desktop launch", async () => {
  const f = await fixture();
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  f.saved.members = f.saved.members.slice(0, 1);
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result).toMatchObject({ ok: false, windowAttempted: false });
  expect(result.error).toContain("view changed since preview");
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.providerOpens).not.toHaveBeenCalled();
});
