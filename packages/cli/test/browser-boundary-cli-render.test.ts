// The real `rig ps` / `rig send` code paths, real DaemonClient and real HTTP, rendering the exact
// refusal body produced by the daemon's browser boundary. (A real CLI request cannot present an
// unlisted target name without DNS: Node fetch sends the URL's host, not an explicit Host header.)
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { Hono } from "hono";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import { psCommand } from "../src/commands/ps.js";
import { sendCommand } from "../src/commands/send.js";
import { browserBoundary } from "../../daemon/src/middleware/browser-boundary.js";

let refusalBody = "";
let server: http.Server;
let port = 0;

beforeAll(async () => {
  const daemon = new Hono();
  daemon.use("/api/*", browserBoundary({ webUiEnabled: false, bearerTokens: [], warn: () => {} }));
  daemon.all("/api/*", (c) => c.json({ ok: true }));
  const res = await daemon.request("/api/ps", { headers: { Host: "unlisted.example:7433" } });
  refusalBody = await res.text();
  server = http.createServer((_req, res2) => { res2.writeHead(403, { "content-type": "application/json" }); res2.end(refusalBody); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => { process.exitCode = undefined; });

function deps() {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE
      ? JSON.stringify({ pid: process.pid, port, db: "test.sqlite", startedAt: "2026-10-01T00:00:00Z" } as DaemonState)
      : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
  return { lifecycleDeps, clientFactory: (url: string) => new DaemonClient(url) };
}

async function stderrOf(cmd: Command, argv: string[]): Promise<string> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await cmd.parseAsync(["node", "rig", ...argv]); } catch { /* exitOverride */ } finally { console.error = orig; }
  return lines.join("\n");
}

describe("CLI shows the boundary's remedy sentence", () => {
  it("the fixture body is the real boundary refusal", () => {
    expect(JSON.parse(refusalBody)).toMatchObject({ code: "untrusted_host" });
  });

  it("rig ps prints the daemon's sentence before its generic line", async () => {
    const prog = new Command().exitOverride();
    prog.addCommand(psCommand(deps() as never));
    const err = await stderrOf(prog, ["ps"]);
    expect(err).toContain("OPENRIG_ALLOWED_HOSTS");
    expect(err).toContain("Failed to fetch rig list from daemon (HTTP 403)");
    expect(process.exitCode).toBe(2);
  });

  it("rig send already prints the daemon's error sentence (no change needed)", async () => {
    const prog = new Command().exitOverride();
    prog.addCommand(sendCommand(deps() as never));
    const err = await stderrOf(prog, ["send", "dev-impl@rig", "fixture"]);
    expect(err).toContain("OPENRIG_ALLOWED_HOSTS");
  });
});
