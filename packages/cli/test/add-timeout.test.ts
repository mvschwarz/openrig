import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMemberCommand } from "../src/commands/add.js";
import { DaemonClient, DaemonTimeoutError } from "../src/client.js";
import type { StatusDeps } from "../src/commands/status.js";

/** Pair the real client with an isolated daemon lifecycle fixture for command tests. */
function deps(client: DaemonClient): StatusDeps {
  return {
    lifecycleDeps: {
      spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "test.sqlite", startedAt: new Date().toISOString() })),
      writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => true), mkdirp: vi.fn(),
      openForAppend: vi.fn(() => 1), isProcessAlive: vi.fn(() => true),
    },
    clientFactory: () => client,
  };
}

const fragment = (() => {
  const dir = mkdtempSync(join(tmpdir(), "add-timeout-"));
  const path = join(dir, "member.yaml");
  writeFileSync(path, "member:\n  id: reviewer\n  runtime: claude-code\n  agent_ref: local:agent\n  profile: default\n  cwd: /project\n");
  return path;
})();

const LAUNCHED = '"result":{"podId":"p1","podNamespace":"dev","node":{"logicalId":"dev.reviewer","nodeId":"n1","status":"launched","sessionName":"dev-reviewer@rig-1"}}}';

let server: http.Server | undefined;
beforeEach(() => {
  vi.stubEnv("OPENRIG_HOST_SELECTED", "local");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("rig add request deadline", () => {
  it("waits for the member-add response beyond the default five seconds without retrying", async () => {
    let posts = 0;
    server = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      if (req.method !== "POST") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      posts++;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.write('{"ok":true,');
      const timer = setTimeout(() => res.end(LAUNCHED), 6_000);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const client = new DaemonClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await addMemberCommand(deps(client)).parseAsync(["node", "rig", "rig-1", "dev", fragment]);
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[OK] dev.reviewer"));
    expect(posts).toBe(1);
  });

  it("bounds the member-add request at 120 seconds with no automatic retry", async () => {
    // setImmediate stays real so the command's lazy yaml import can finish before the clock moves.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let writes = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method === "GET") return new Response(JSON.stringify([]));
      writes++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    };
    const client = new DaemonClient("http://127.0.0.1:3000", { fetchImpl });
    let settled = false;
    const result = addMemberCommand(deps(client)).parseAsync(["node", "rig", "rig-1", "dev", fragment])
      .then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    while (writes === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(writes).toBe(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(DaemonTimeoutError);
    expect(writes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
