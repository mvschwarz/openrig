// `rig up` and `rig start` start a local daemon only when one is confirmed down (stopped or stale), as
// `rig context` already does. A daemon whose state is unverified (alive but too busy to answer its
// health check) is sent the real request instead of a start attempt that reports "already running".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonStatus } from "../src/daemon-lifecycle.js";

const lifecycle = vi.hoisted(() => ({
  status: { state: "unverified", host: "127.0.0.1", port: 7433 } as DaemonStatus,
  startDaemon: vi.fn(async () => ({ pid: 1, port: 7433 })),
}));

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => lifecycle.status),
    startDaemon: lifecycle.startDaemon,
    // rig start waits for the kernel before its first request; report it ready at once.
    waitForKernelReady: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock("../src/daemon-auto-start.js", () => ({
  prepareDaemonAutoStart: vi.fn(async () => ({ options: {}, preflight: { ready: true, checks: [] } })),
}));

const { upCommand } = await import("../src/commands/up.js");
const { startCommand } = await import("../src/commands/start.js");

function client() {
  const requests: string[] = [];
  // Records the first request, then stops the command there: reaching the daemon is the point.
  const factory = () => ({
    get: vi.fn(async (p: string) => { requests.push(`GET ${p}`); throw new Error("stop at the request"); }),
    post: vi.fn(async (p: string) => { requests.push(`POST ${p}`); throw new Error("stop at the request"); }),
  });
  return { requests, factory };
}

describe("auto-start only for a daemon confirmed down", () => {
  beforeEach(() => {
    lifecycle.startDaemon.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  for (const [name, command, argv] of [
    ["rig up", upCommand, ["node", "up", "some-rig", "--json"]],
    ["rig start", startCommand, ["node", "start", "--all", "--json"]],
  ] as const) {
    it(`${name}: an unverified daemon is sent the real request, never a start`, async () => {
      lifecycle.status = { state: "unverified", host: "127.0.0.1", port: 7433 };
      const c = client();
      const cmd = (command as (d: unknown) => import("commander").Command)({ lifecycleDeps: {}, clientFactory: c.factory, preflightExec: async () => "" });
      cmd.exitOverride();
      await cmd.parseAsync(argv as unknown as string[]).catch(() => {});
      expect(lifecycle.startDaemon).not.toHaveBeenCalled();
      expect(c.requests.length).toBeGreaterThan(0);
    });

  }

  it("rig up: a stopped daemon is still started", async () => {
    lifecycle.status = { state: "stopped" };
    const c = client();
    const cmd = upCommand({ lifecycleDeps: {} as never, clientFactory: c.factory as never });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "up", "some-rig", "--json"]).catch(() => {});
    expect(lifecycle.startDaemon).toHaveBeenCalledTimes(1);
  });

  it("rig up: a live sibling home still auto-starts here; an explicit HOME-MOVED and a busy own daemon don't", async () => {
    const cells: Array<[string, DaemonStatus, number]> = [
      // Another home's daemon is alive and this home's own endpoint refused: an independent home, as on main.
      ["live sibling", { state: "unverified", siblingHint: { resolvedHome: "/homes/.openrig", siblingHome: "/homes/.openrig-b" }, probeErrorCode: "ECONNREFUSED" }, 1],
      ["HOME-MOVED", { state: "unverified", siblingHint: { resolvedHome: "/homes/.openrig", siblingHome: "/homes/.openrig-new", moved: true } }, 0],
      ["busy own daemon", { state: "unverified", host: "127.0.0.1", port: 7433 }, 0],
    ];
    const seen: Record<string, number> = {};
    for (const [label, status] of cells) {
      lifecycle.startDaemon.mockClear();
      lifecycle.status = status;
      const c = client();
      const cmd = upCommand({ lifecycleDeps: {} as never, clientFactory: c.factory as never });
      cmd.exitOverride();
      await cmd.parseAsync(["node", "up", "some-rig", "--json"]).catch(() => {});
      seen[label] = lifecycle.startDaemon.mock.calls.length;
    }
    expect(seen).toEqual(Object.fromEntries(cells.map(([label, , n]) => [label, n])));
  });

  it("rig start: an explicit HOME-MOVED is refused with the guard's own message, not \"not healthy\"", async () => {
    lifecycle.status = { state: "unverified", siblingHint: { resolvedHome: "/homes/a", siblingHome: "/homes/b", moved: true } };
    const c = client();
    const cmd = startCommand({ lifecycleDeps: {} as never, clientFactory: c.factory as never, preflightExec: async () => "" });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "start", "--all", "--json"]).catch(() => {});
    const out = vi.mocked(console.error).mock.calls.map((a) => a.join(" ")).join("\n");
    expect(lifecycle.startDaemon).not.toHaveBeenCalled();
    expect(out).toContain("live sibling /homes/b");
    expect(out).not.toContain("Daemon is not healthy");
    expect(c.requests).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("rig start: a /healthz that never answers doesn't hold the start past the request bound", async () => {
    const held: http.ServerResponse[] = [];
    const server = http.createServer((req, res) => { held.push(res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      lifecycle.status = { state: "unverified", host: "127.0.0.1", port: (server.address() as AddressInfo).port };
      const c = client();
      const cmd = startCommand({ lifecycleDeps: {} as never, clientFactory: c.factory as never, preflightExec: async () => "" });
      cmd.exitOverride();
      const started = Date.now();
      await cmd.parseAsync(["node", "start", "--all", "--json"]).catch(() => {});
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(c.requests).toEqual(["GET /api/rigs/summary"]);
    } finally {
      for (const res of held) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
