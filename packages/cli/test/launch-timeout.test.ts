import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { launchCommand } from "../src/commands/launch.js";
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

/** The launch resolves the rig handle with one summary read first; answer it at once with no rigs, so the handle
 *  goes on as an id and only the launch request itself is slow. */
function answerRigLookup(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== "GET" || !req.url?.startsWith("/api/rigs/summary")) return false;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("[]");
  return true;
}

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

describe("local launch request deadlines", () => {
  it("waits for a subset launch response body beyond the default five seconds without retrying", async () => {
    let requests = 0;
    let requestBody = "";
    server = http.createServer(async (req, res) => {
      if (answerRigLookup(req, res)) return;
      for await (const chunk of req) requestBody += chunk.toString();
      requests++;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.write('{"ok":true,');
      const timer = setTimeout(() => res.end('"launched":[{"nodeId":"n1","logicalId":"dev.driver","status":"fresh"}]}'), 6_000);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const client = new DaemonClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await launchCommand(deps(client)).parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver", "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status": "fresh"'));
    expect(requests).toBe(1);
    expect(JSON.parse(requestBody)).toEqual({ seats: ["dev.driver"] });
  });

  it("waits for a single-node launch response beyond the default five seconds without retrying", async () => {
    let requests = 0;
    server = http.createServer(async (req, res) => {
      if (answerRigLookup(req, res)) return;
      for await (const _chunk of req) { /* drain */ }
      requests++;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.write('{"ok":true,');
      const timer = setTimeout(() => res.end('"nodeId":"n1","logicalId":"dev.driver","status":"launched"}'), 6_000);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const client = new DaemonClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await launchCommand(deps(client)).parseAsync(["node", "rig", "rig-1", "dev.driver", "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status": "launched"'));
    expect(requests).toBe(1);
  });

  it.each([
    { args: ["--seats", "dev.driver"], deadline: 120_000 },
    { args: ["--seats", "dev.driver", "--plan"], deadline: 5_000 },
    { args: ["dev.driver", "--plan"], deadline: 5_000 },
    { args: ["dev.driver"], deadline: 120_000 },
  ])("bounds $args at $deadline ms with no automatic retry", async ({ args, deadline }) => {
    vi.useFakeTimers();
    let writes = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method === "GET") return new Response(JSON.stringify({ version: "0.6.10" }));
      writes++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    };
    const client = new DaemonClient("http://127.0.0.1:3000", { fetchImpl });
    let settled = false;
    const result = launchCommand(deps(client)).parseAsync(["node", "rig", "rig-1", ...args])
      .then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(writes).toBe(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(DaemonTimeoutError);
    expect(writes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
