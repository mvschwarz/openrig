import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WatchdogDeps } from "../src/commands/watchdog.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({
      state: "running",
      healthy: true,
      pid: 1234,
      port: 7433,
    })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface StubResponse {
  status: number;
  data: unknown;
}

function makeDeps(opts?: {
  routes?: Record<string, StubResponse>;
}): {
  deps: WatchdogDeps;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as WatchdogDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: vi.fn(async (path: string) => {
            calls.push({ method: "GET", path });
            return routes[`GET ${path}`] ?? { status: 200, data: {} };
          }),
          getText: vi.fn(async (path: string) => {
            calls.push({ method: "GET", path });
            return { status: 200, data: "" };
          }),
          post: vi.fn(async (path: string, body: unknown) => {
            calls.push({ method: "POST", path, body });
            return routes[`POST ${path}`] ?? { status: 201, data: {} };
          }),
          delete: vi.fn(async (path: string) => {
            calls.push({ method: "DELETE", path });
            return { status: 204, data: null };
          }),
          postText: vi.fn(async (path: string) => {
            calls.push({ method: "POST", path });
            return { status: 200, data: "" };
          }),
          postExpectText: vi.fn(async (path: string) => {
            calls.push({ method: "POST", path });
            return { status: 200, data: "" };
          }),
        }) as unknown as ReturnType<WatchdogDeps["clientFactory"]>,
    },
  };
}

describe("rig watchdog CLI (PL-004 Phase C)", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
  });

  it("watchdog is registered with all v1 subcommands", () => {
    const { deps } = makeDeps();
    const program = createProgram({ watchdogDeps: deps });
    const cmd = program.commands.find((c) => c.name() === "watchdog");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name()).sort();
    expect(subs).toContain("register");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
    expect(subs).toContain("status");
    expect(subs).toContain("stop");
  });

  it("register POSTs /api/watchdog/register with spec file contents + structured fields", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/watchdog/register": {
          status: 201,
          data: { jobId: "01J..." },
        },
      },
    });
    const tmp = mkdtempSync(join(tmpdir(), "wd-cli-"));
    const spec = join(tmp, "spec.yaml");
    const yaml =
      "policy: periodic-reminder\ntarget: alice@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: alice@rig\n  message: ping\n";
    writeFileSync(spec, yaml);
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node",
      "rig",
      "watchdog",
      "register",
      "--spec",
      spec,
      "--policy",
      "periodic-reminder",
      "--target-session",
      "alice@rig",
      "--interval-seconds",
      "60",
      "--registered-by",
      "ops@kernel",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/watchdog/register");
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    expect(body.policy).toBe("periodic-reminder");
    expect(body.specYaml).toBe(yaml);
    expect(body.targetSession).toBe("alice@rig");
    expect(body.intervalSeconds).toBe(60);
    expect(body.registeredBySession).toBe("ops@kernel");
  });

  // PL-004 Phase D: registration-rejection assertion REPLACED with
  // positive registration-accept. workflow-keepalive is now an
  // accepted policy.
  it("register accepts workflow-keepalive (Phase D enum extension surfaces 201 + job_id)", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/watchdog/register": {
          status: 201,
          data: { jobId: "01J...", policy: "workflow-keepalive", state: "active" },
        },
      },
    });
    const tmp = mkdtempSync(join(tmpdir(), "wd-cli-"));
    const spec = join(tmp, "spec.yaml");
    writeFileSync(
      spec,
      "policy: workflow-keepalive\ntarget:\n  session: alice@rig\ninterval_seconds: 1800\ncontext:\n  workflow_instance_id: 01ABC\n",
    );
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node",
      "rig",
      "watchdog",
      "register",
      "--spec",
      spec,
      "--policy",
      "workflow-keepalive",
      "--target-session",
      "alice@rig",
      "--interval-seconds",
      "1800",
      "--registered-by",
      "ops@kernel",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/watchdog/register");
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    expect(body.policy).toBe("workflow-keepalive");
    // exit code unchanged since 201 is success.
    expect(process.exitCode).toBeUndefined();
  });

  it("register help lists workflow-keepalive as an accepted policy", () => {
    const { deps } = makeDeps();
    const program = createProgram({ watchdogDeps: deps });
    const watchdog = program.commands.find((c) => c.name() === "watchdog");
    const register = watchdog?.commands.find((c) => c.name() === "register");
    expect(register).toBeDefined();
    expect(register!.helpInformation()).toContain("workflow-keepalive");
  });

  it("list GETs /api/watchdog/list", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/watchdog/list": { status: 200, data: [] } },
    });
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "watchdog", "list", "--json"]);
    expect(calls.find((c) => c.path === "/api/watchdog/list")).toBeDefined();
  });

  it("show GETs /api/watchdog/:jobId", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/watchdog/job-1": { status: 200, data: { jobId: "job-1" } } },
    });
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "watchdog", "show", "job-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/watchdog/job-1")).toBeDefined();
  });

  it("status GETs /api/watchdog/:jobId/status", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "GET /api/watchdog/job-1/status": {
          status: 200,
          data: { job: { jobId: "job-1" }, recentHistory: [] },
        },
      },
    });
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "watchdog", "status", "job-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/watchdog/job-1/status")).toBeDefined();
  });

  it("stop POSTs /api/watchdog/:jobId/stop with reason", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/watchdog/job-1/stop": { status: 200, data: { state: "stopped" } },
      },
    });
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node",
      "rig",
      "watchdog",
      "stop",
      "job-1",
      "--reason",
      "tester stop",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/watchdog/job-1/stop");
    expect(call).toBeDefined();
    expect((call!.body as { reason: string }).reason).toBe("tester stop");
  });
});
