import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCommand } from "../src/commands/start.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

// Keep the real waiter and HTTP path; only shorten the command's 60s test budget.
vi.mock("../src/daemon-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/daemon-lifecycle.js")>();
  return { ...actual, waitForKernelReady: (url: string) => actual.waitForKernelReady(url, 100, 10) };
});
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  vi.restoreAllMocks(); resetFetchAllowlist(); process.exitCode = 0;
});
async function run(kernelState?: string, httpStatus = 200, summaryStatus = 200, kernelExtra: Record<string, unknown> = {}, json = false, kernelDetail = "fixture detail", keptDown = false) {
  const received: string[] = [];
  const server = http.createServer((request, response) => {
    received.push(request.url!);
    const kernel = request.url === "/api/kernel/status";
    response.writeHead(kernel ? httpStatus : request.url === "/api/rigs/summary" ? summaryStatus : 200, { "Content-Type": "application/json" });
    const stopped = { id: "restorable-rig", name: "work", nodeCount: 1, lifecycleState: "recoverable" };
    const payload = kernel ? { kernel_state: kernelState, detail: kernelDetail, ...kernelExtra }
      : request.url === "/api/rigs/summary" ? (summaryStatus === 200 && !keptDown ? [] : [stopped])
      : keptDown && request.url === "/api/rigs/restorable-rig/up" ? { status: "plan", nodes: [] }
      : keptDown && request.url === "/api/rigs/restorable-rig/nodes" ? [{ sessionStatus: "exited", intentionallyStopped: true }]
      : { ok: true };
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); servers.push(server);
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`; allowFetchTarget(url);
  const lifecycleDeps: LifecycleDeps = {
    spawn: () => { throw new Error("must not spawn"); }, fetch: async (target) => fetch(target),
    kill: () => { throw new Error("must not signal"); }, exists: (file) => file === STATE_FILE,
    readFile: (file) => file === STATE_FILE ? JSON.stringify({ pid: process.pid, port, host: "127.0.0.1", db: ":memory:", startedAt: new Date().toISOString() }) : null,
    writeFile: () => { throw new Error("must not write"); }, removeFile: () => { throw new Error("must not remove"); },
    mkdirp: () => { throw new Error("must not mkdir"); }, openForAppend: () => { throw new Error("must not open"); }, isProcessAlive: () => true,
  };
  const errors: string[] = [];
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
  vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
  await startCommand({ lifecycleDeps, clientFactory: (base) => new DaemonClient(base) }).parseAsync([keptDown ? "--last" : "--all", ...(json ? ["--json"] : [])], { from: "user" });
  return { errors: errors.join("\n"), logs: logs.join("\n"), received, exitCode: process.exitCode ?? 0 };
}
describe("rig start kernel wait evidence", () => {
  it.each([undefined, "booting"])("reports deadline evidence without asserting a kernel failure: %s", async (state) => {
    const result = await run(state);
    expect(result.errors).toContain("Kernel did not report ready before the deadline");
    expect(result.errors).toContain(`state=${state ?? "unknown"}`);
    expect(result.errors).not.toContain("Kernel failed to start");
    expect(result.exitCode).toBe(1);
    expect(result.received).not.toContain("/api/rigs/summary");
  });
  it("reports an unsuccessful status read as unknown, without a terminal failure claim", async () => {
    const result = await run(undefined, 503);
    expect(result.errors).toContain("Kernel did not report ready before the deadline");
    expect(result.errors).toContain("state=unknown");
    expect(result.errors).not.toContain("Kernel failed to start");
    expect(result.exitCode).toBe(1); expect(result.received).not.toContain("/api/rigs/summary");
  });
  it.each(["auth_blocked", "spec_missing", "bootstrap_failed", "degraded"])("retains an actually reported terminal failure: %s", async (state) => {
    const result = await run(state);
    expect(result.errors).toContain(`Kernel failed to start: state=${state}, detail=fixture detail`);
    expect(result.exitCode).toBe(1); expect(result.received).not.toContain("/api/rigs/summary");
  });
  it.each(["skipped", "ready", "partial_ready"])("retains restore discovery for %s", async (state) => {
    const result = await run(state);
    expect(result.errors).toBe(""); expect(result.exitCode).toBe(0);
    expect(result.received).toContain("/api/rigs/summary");
  });
  it("says a kernel that was already down before this daemon start stays down, and how to bring it back", async () => {
    const result = await run("skipped", 200, 200, {}, false,
      "kernel rig already managed; it was already down before this daemon start, so it was not restored. Bring it back with: rig up kernel --existing");
    expect(result.logs).toContain("Kernel auto-boot skipped: kernel rig already managed; it was already down before this daemon start");
    expect(result.logs).toContain("rig up kernel --existing");
    expect(result.logs).not.toContain("--no-kernel or test mode");
    expect(result.errors).toBe(""); expect(result.exitCode).toBe(0);
  });
  it("names an already-managed kernel and how to bring it back, instead of blaming --no-kernel", async () => {
    const result = await run("skipped", 200, 200, {}, false, "kernel rig already managed");
    expect(result.logs).not.toContain("--no-kernel or test mode");
    expect(result.logs).toContain("kernel rig already managed");
    expect(result.logs).toContain("rig up kernel --existing");
    expect(result.errors).toBe(""); expect(result.exitCode).toBe(0);
    expect(result.received).toContain("/api/rigs/summary");
  });
  it("keeps the opt-out explanation when the kernel was skipped on purpose", async () => {
    const result = await run("skipped", 200, 200, {}, false, "OPENRIG_NO_KERNEL=1");
    expect(result.logs).toContain("Kernel auto-boot skipped (--no-kernel or test mode)");
    expect(result.logs).not.toContain("rig up kernel --existing");
  });
});

// #1078 — daemon start is restoring an existing kernel a reboot left down. Before that restore the
// kernel read `skipped` and start went on to the other rigs; it still does, and says what it saw.
describe("rig start while daemon start restores an existing kernel", () => {
  it.each(["booting", "degraded"])("still restoring (%s): says so, points to rig status, and continues", async (state) => {
    const result = await run(state, 200, 200, { existing_restore: "in_progress" });
    expect(result.errors).toContain(`Kernel is still restoring and not ready yet (state=${state})`);
    expect(result.errors).toContain("rig status");
    expect(result.errors).not.toContain("rig up kernel --existing");
    expect(result.errors).not.toContain("Cannot proceed");
    expect(result.logs).not.toContain("Kernel ready");
    expect(result.logs).toContain("Daemon is up. No other rigs to restore.");
    expect(result.received).toContain("/api/rigs/summary");
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ["bootstrap_failed", "finished"],
    ["booting", "finished"],
  ])("restore returned without a ready kernel (%s, %s): names rig up kernel --existing and continues", async (state, phase) => {
    const result = await run(state, 200, 200, { existing_restore: phase });
    expect(result.errors).toContain(`Kernel restore did not bring the kernel up: state=${state}`);
    expect(result.errors).toContain("Recover it with: rig up kernel --existing");
    expect(result.errors).not.toContain("Cannot proceed");
    expect(result.received).toContain("/api/rigs/summary");
    expect(result.exitCode).toBe(1);
  });

  it("reports the kernel restore in --json output", async () => {
    const result = await run("booting", 200, 200, { existing_restore: "in_progress" }, true);
    expect(JSON.parse(result.logs.split("\n").at(-1)!)).toMatchObject({
      status: "started", kernelRestore: { state: "restoring", kernelState: "booting" },
    });
    // A command that succeeded leaves stdout to the JSON and writes nothing error-like.
    expect(result.errors).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("a first boot that fails still stops before rig restore", async () => {
    const result = await run("bootstrap_failed");
    expect(result.errors).toContain("Cannot proceed to rig restore without a working kernel.");
    expect(result.received).not.toContain("/api/rigs/summary");
  });
});

it.each([401, 503])("does not report successful empty restore discovery after HTTP %s", async (status) => {
  const result = await run("ready", 200, status);
  expect(result.exitCode).toBe(1);
  expect(result.errors).toContain(`HTTP ${status}`);
  expect(result.received).toContain("/api/rigs/summary");
  expect(result.received).not.toContain("/api/rigs/restorable-rig/up");
  expect(result.received.filter((path) => path.endsWith("/up"))).toEqual([]);
});

it.each([["booting", "in_progress", "restoring", 0], ["bootstrap_failed", "finished", "failed", 1]] as const)("--last JSON keeps kernel restore evidence when every rig stays down: %s", async (state, phase, outcome, exitCode) => {
  const result = await run(state, 200, 200, { existing_restore: phase }, true, "fixture detail", true);
  expect(JSON.parse(result.logs.split("\n").at(-1)!)).toMatchObject({
    status: "started", kernelRestore: { state: outcome, kernelState: state },
    keptDown: [{ rigName: "work", restoreCommand: "rig start --rigs work" }], restoredRigs: [],
  });
  expect(result.exitCode).toBe(exitCode);
  expect(result.received.filter(path => path.endsWith("/up"))).toEqual(["/api/rigs/restorable-rig/up"]); // Plan only.
});
