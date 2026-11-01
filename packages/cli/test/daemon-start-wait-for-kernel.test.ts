import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitForKernelReady, type KernelReadyResult } from "../src/daemon-lifecycle.js";
import { daemonCommand } from "../src/commands/daemon.js";

vi.mock("../src/daemon-lifecycle.js", async (original) => {
  const actual = await original<typeof import("../src/daemon-lifecycle.js")>();
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "stopped" })),
    startDaemon: vi.fn(async () => ({ pid: 4242, port: 7433, host: "127.0.0.1" })),
    waitForKernelReady: vi.fn(),
  };
});
vi.mock("../src/system-preflight.js", () => ({ SystemPreflight: class { run = async () => ({ ready: true, checks: [] }); }, quietPreflightExec: async () => "" }));
let home: string;
let errors: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "daemon-start-wait-for-kernel-"));
  vi.stubEnv("OPENRIG_HOME", home);
  errors = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); process.exitCode = undefined; });

async function startWaiting(result: Partial<KernelReadyResult>) {
  vi.mocked(waitForKernelReady).mockResolvedValue({ ok: false, kernelState: null, variant: null, detail: null, ...result });
  await daemonCommand({} as never).parseAsync(["start", "--wait-for-kernel"], { from: "user" });
  return errors.join("\n");
}

it("a kernel already down before this start: says so and how to bring it back, not a timeout or an auth fix", async () => {
  const out = await startWaiting({ kernelState: "skipped",
    detail: "kernel rig already managed; it was already down before this daemon start, so it was not restored. Bring it back with: rig up kernel --existing" });
  expect(out).toContain("Kernel auto-boot skipped: kernel rig already managed; it was already down before this daemon start");
  expect(out).toContain("rig up kernel --existing");
  expect(out).not.toContain("did not reach ready");
  expect(out).not.toContain("auth status");
  expect(process.exitCode).toBe(1);
});

it("a kernel skipped on purpose: names the opt-out, not a timeout or an auth fix", async () => {
  const out = await startWaiting({ kernelState: "skipped", detail: "OPENRIG_NO_KERNEL=1" });
  expect(out).toContain("Kernel auto-boot skipped (--no-kernel or test mode)");
  expect(out).not.toContain("did not reach ready");
  expect(out).not.toContain("auth status");
  expect(process.exitCode).toBe(1);
});

it("a kernel still booting at the deadline keeps the timeout and its fix", async () => {
  const out = await startWaiting({ kernelState: "booting" });
  expect(out).toContain("Error: kernel did not reach ready / partial_ready within 60000ms.");
  expect(out).toContain("Reason: kernel_state=booting");
  expect(out).toContain("Fix: inspect `rig ps --rig kernel` for stalled agents");
  expect(process.exitCode).toBe(1);
});
