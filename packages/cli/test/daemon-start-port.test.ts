import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon } from "../src/daemon-lifecycle.js";
import { daemonCommand } from "../src/commands/daemon.js";

const preflightRun = vi.hoisted(() => vi.fn(async () => ({ ready: true, checks: [] })));
vi.mock("../src/daemon-lifecycle.js", async (original) => {
  const actual = await original<typeof import("../src/daemon-lifecycle.js")>();
  return { ...actual, getDaemonStatus: vi.fn(async () => ({ state: "stopped" })), startDaemon: vi.fn(async () => { throw new Error("startup options captured"); }) };
});
vi.mock("../src/system-preflight.js", () => ({ SystemPreflight: class { run = preflightRun; }, quietPreflightExec: async () => "" }));
let home: string;
let errors: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "daemon-start-port-"));
  vi.stubEnv("OPENRIG_HOME", home);
  errors = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  vi.mocked(startDaemon).mockClear();
  preflightRun.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); process.exitCode = undefined; });

it.each(["abc", "99999", "-1"])("daemon start --port %s is refused before preflight or startup", async (port) => {
  await daemonCommand({} as never).parseAsync(["start", "--port", port], { from: "user" });
  expect(errors.join("\n")).toContain(`Invalid --port: must be an integer in [0, 65535], got "${port}"`);
  expect(process.exitCode).toBe(1);
  expect(preflightRun).not.toHaveBeenCalled();
  expect(startDaemon).not.toHaveBeenCalled();
});

it("daemon start --port with a bindable port still reaches startup on that port", async () => {
  await daemonCommand({} as never).parseAsync(["start", "--port", "7434"], { from: "user" });
  expect(preflightRun).toHaveBeenCalledTimes(1);
  expect(startDaemon).toHaveBeenCalledTimes(1);
  expect(vi.mocked(startDaemon).mock.calls[0]![0]).toMatchObject({ port: 7434 });
});
