// `rig up` and `rig start` start a local daemon only when one is confirmed down (stopped or stale), as
// `rig context` already does. A daemon whose state is unverified (alive but too busy to answer its
// health check) is sent the real request instead of a start attempt that reports "already running".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
