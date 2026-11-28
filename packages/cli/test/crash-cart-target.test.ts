import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashCartCommand, type CrashCartEmit } from "../src/commands/crash-cart.js";
import { realDeps } from "../src/commands/daemon.js";
import { getDaemonStatus } from "../src/daemon-lifecycle.js";
import { currentBootId } from "../src/daemon-start-lock.js";
import { crashCartRenderOpts } from "../../tui/src/crash-cart/from-emit.js";
import { resolveCrashCartKey } from "../../tui/src/crash-cart/keys.js";
import { renderUnverifiedView } from "../../tui/src/crash-cart/render-crash-cart.js";

const config = vi.hoisted(() => ({ daemon: { host: "127.0.0.1", port: 17433 }, db: { path: "" } }));
vi.mock("../src/config-store.js", () => ({ ConfigStore: class { resolve() { return config; } } }));

let home: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "crash-cart-target-"));
  config.db.path = join(home, "openrig.sqlite");
  vi.stubEnv("OPENRIG_HOME", home);
  vi.stubEnv("OPENRIG_URL", "");
  vi.stubEnv("RIGGED_URL", "");
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function reservation(pid = process.pid, port?: number, host = "127.0.0.1") {
  const text = JSON.stringify({ launcherPid: pid, startedAt: "2026-01-01T00:00:00Z" }) + "\n"
    + JSON.stringify({ childPid: pid, ...(port ? { host, port } : {}) }) + "\n";
  writeFileSync(join(home, "daemon-start.lock"), text);
  return text;
}
function probes(...results: Array<"refused" | "timeout" | "answered" | "not-openrig">) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const result = results[Math.min(i++, results.length - 1)];
    if (result === "answered") return new Response("{}", { status: 200 });
    if (result === "not-openrig") return new Response("", { status: 503 });
    throw Object.assign(new Error(result), { code: result === "refused" ? "ECONNREFUSED" : "ETIMEDOUT" });
  });
}
async function run() {
  const lines: string[] = [];
  await crashCartCommand({ write: (s) => lines.push(s) }).parseAsync(["--json"], { from: "user" });
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as CrashCartEmit;
}
function unverified(emit: CrashCartEmit) {
  expect(emit.state).toBe("unverified");
  expect(emit.discovery).toBeUndefined();
  expect(emit.refusal).toBeUndefined();
  expect(process.exitCode).toBe(1);
  const opts = crashCartRenderOpts(emit as Parameters<typeof crashCartRenderOpts>[0]);
  expect(opts.daemonState).toBe("unverified");
  expect(resolveCrashCartKey("s", opts)).toBeNull();
  expect(resolveCrashCartKey("enter", opts)).toBeNull();
  expect(resolveCrashCartKey("r", opts)).toBe("retry");
  const visible = renderUnverifiedView(opts.daemonEvidence!).map((line) => line.text).join("\n");
  expect(visible).toContain("not confirmed down");
  expect(visible).toContain(emit.evidence!.failedSignal);
}

describe("real crash-cart wiring: selected endpoint, reservation and discovery recheck", () => {
  it("keeps a live local startup pending, without changing its reservation", async () => {
    const before = reservation();
    const probe = probes("refused");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.pidState).toContain("start pending");
    expect(probe.mock.calls.every(([url]) => url === "http://127.0.0.1:17433/healthz")).toBe(true);
    expect(readFileSync(join(home, "daemon-start.lock"), "utf8")).toBe(before);
    expect(readdirSync(home)).toEqual(["daemon-start.lock"]);
  });
  it("keeps an indeterminate reservation unverified", async () => {
    reservation();
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("uninspectable"), { code: "EPERM" }); });
    probes("refused");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.pidState).toContain("unknown");
  });
  it("a reservation being written is indeterminate, not absent", async () => {
    writeFileSync(join(home, "daemon-start.lock"), "{");
    probes("refused");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.pidState).toContain("unknown");
  });
  it.each(["", '{"childPid":'])("a dead launcher with a missing/incomplete child record (%s) is still indeterminate", async (child) => {
    const before = '{"launcherPid":2147483647}\n' + child;
    writeFileSync(join(home, "daemon-start.lock"), before);
    probes("refused");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.pidState).toContain("unknown");
    expect(readFileSync(join(home, "daemon-start.lock"), "utf8")).toBe(before);
  });
  it("a reservation appearing between the first probe and discovery is re-read", async () => {
    const probe = probes("refused");
    probe.mockImplementationOnce(async () => {
      reservation();
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    unverified(await run());
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("a positively dead reservation leaves genuine refusal down at the configured endpoint", async () => {
    const before = reservation();
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const probe = probes("refused");
    const emit = await run();
    expect(emit.state).toBe("down");
    expect(emit.discovery).toBeDefined();
    expect(probe.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("http://127.0.0.1:17433/healthz"));
    expect(readFileSync(join(home, "daemon-start.lock"), "utf8")).toBe(before);
  });
  it.skipIf(!currentBootId())("a reservation from an earlier boot leaves genuine refusal down, as a start archives it", async () => {
    // After a reboot the recorded PIDs can name unrelated live processes (here, this test's own).
    const before = JSON.stringify({ launcherPid: process.pid, startedAt: "2026-01-01T00:00:00Z", bootId: "an-earlier-boot" }) + "\n"
      + JSON.stringify({ childPid: process.pid, host: "127.0.0.1", port: 17433 }) + "\n";
    writeFileSync(join(home, "daemon-start.lock"), before);
    probes("refused");
    const emit = await run();
    expect(emit.state).toBe("down");
    expect(emit.discovery).toBeDefined();
    expect(resolveCrashCartKey("s", crashCartRenderOpts(emit as Parameters<typeof crashCartRenderOpts>[0]))).toBe("start-daemon");
    expect(readFileSync(join(home, "daemon-start.lock"), "utf8")).toBe(before);
  });
  it.skipIf(!currentBootId())("status and crash-cart agree on the same earlier-boot and current-boot reservations", async () => {
    probes("refused");
    for (const bootId of ["an-earlier-boot", currentBootId()!]) {
      const before = JSON.stringify({ launcherPid: process.pid, startedAt: "2026-01-01T00:00:00Z", bootId }) + "\n"
        + JSON.stringify({ childPid: process.pid, host: "127.0.0.1", port: 17433 }) + "\n";
      writeFileSync(join(home, "daemon-start.lock"), before);
      const status = await getDaemonStatus({ ...realDeps(), homeDir: home, listDir: () => [] });
      const emit = await run();
      if (bootId === "an-earlier-boot") {
        expect(status.state).toBe("stopped");
        expect(status.startPending).toBeUndefined();
        expect(emit.state).toBe("down");
      } else {
        expect(status.state).toBe("unverified");
        expect(status.startPending?.pid).toBe(process.pid);
        unverified(emit);
        expect(emit.evidence!.pidState).toContain("start pending");
      }
      expect(readFileSync(join(home, "daemon-start.lock"), "utf8")).toBe(before);
      expect(readdirSync(home)).toEqual(["daemon-start.lock"]);
    }
  });
  it.skipIf(!currentBootId())("an earlier boot's reservation with an unreadable line stays unverified, as a start keeps it", async () => {
    writeFileSync(join(home, "daemon-start.lock"),
      JSON.stringify({ launcherPid: process.pid, startedAt: "2026-01-01T00:00:00Z", bootId: "an-earlier-boot" }) + "\n" + '{"childPid": 12');
    probes("refused");
    unverified(await run());
  });
  it("uses the active reservation's nondefault endpoint for verdict and evidence", async () => {
    reservation(process.pid, 18433);
    const probe = probes("refused");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.failedSignal).toContain("http://127.0.0.1:18433/healthz");
    expect(probe.mock.calls.every(([url]) => url === "http://127.0.0.1:18433/healthz")).toBe(true);
  });
  it("a matching explicit loopback target sees its pending reservation", async () => {
    reservation(process.pid, 18433);
    vi.stubEnv("OPENRIG_URL", "http://localhost:18433");
    probes("refused");
    unverified(await run());
  });
  it.each(["pending", "recorded"] as const)("a dual-stack wildcard's %s owner matches IPv4 loopback", async (source) => {
    const file = join(home, source === "pending" ? "daemon-start.lock" : "daemon.json");
    if (source === "pending") reservation(process.pid, 18433, "::");
    else writeFileSync(file, JSON.stringify({ pid: process.pid, host: "::", port: 18433, db: config.db.path }));
    const before = readFileSync(file, "utf8");
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:18433");
    const probe = probes("refused");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.pidState).toContain(String(process.pid));
    expect(probe.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("http://127.0.0.1:18433/healthz"));
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(home)).toEqual([source === "pending" ? "daemon-start.lock" : "daemon.json"]);
  });
  it.each(["http://remote.example:18433", "http://127.0.0.1:19433"])("a dual-stack wildcard reservation does not describe %s", async (url) => {
    reservation(process.pid, 18433, "::");
    vi.stubEnv("OPENRIG_URL", url);
    const probe = probes("refused");
    expect((await run()).state).toBe("down");
    expect(probe.mock.calls.map(([target]) => target)).toEqual(Array(2).fill(`${url}/healthz`));
  });
  it("an unrelated explicit remote target does not borrow a local reservation", async () => {
    reservation(process.pid, 18433);
    vi.stubEnv("OPENRIG_URL", "http://remote.example:19433");
    const probe = probes("refused");
    const emit = await run();
    expect(emit.state).toBe("down");
    expect(probe.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("http://remote.example:19433/healthz"));
  });
  it("another explicit local port does not borrow a reservation either", async () => {
    reservation(process.pid, 18433);
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:19433");
    const probe = probes("refused");
    expect((await run()).state).toBe("down");
    expect(probe.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("http://127.0.0.1:19433/healthz"));
  });
  it("a distinct loopback address at the same port does not borrow the reservation", async () => {
    reservation(process.pid, 18433);
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.2:18433");
    probes("refused");
    expect((await run()).state).toBe("down");
  });
  it("remote evidence does not borrow a live local daemon PID", async () => {
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 17433, db: config.db.path }));
    vi.stubEnv("OPENRIG_URL", "http://remote.example:19433");
    probes("timeout");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.pidState).not.toContain(String(process.pid));
    expect(emit.evidence!.pidState).toContain("explicit target");
  });
  it("steady delayed health stays unverified and does not make a fourth evidence probe", async () => {
    const probe = probes("timeout");
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.probeResult).toBe("timeout");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(readdirSync(home)).toEqual([]);
  });
  it.each(["timeout", "not-openrig"] as const)("a %s at the discovery recheck replaces DOWN with unverified", async (result) => {
    const probe = probes("refused", result);
    const emit = await run();
    unverified(emit);
    expect(emit.evidence!.probeResult).toBe(result);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(readdirSync(home)).toEqual([]);
  });
  it("an answering discovery recheck replaces DOWN with UP", async () => {
    probes("refused", "answered");
    expect(await run()).toEqual({ state: "up" });
    expect(process.exitCode).toBe(0);
  });
  it("genuine refusal at a nondefault configured target still offers the existing down view", async () => {
    const probe = probes("refused");
    const emit = await run();
    expect(emit.state).toBe("down");
    const opts = crashCartRenderOpts(emit as Parameters<typeof crashCartRenderOpts>[0]);
    expect(resolveCrashCartKey("s", opts)).toBe("start-daemon");
    expect(probe.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("http://127.0.0.1:17433/healthz"));
  });
});
