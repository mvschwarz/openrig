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
  // Cadence flags keep today's parseInt reading; a value whose number changes (or isn't a number)
  // gets a stderr warning naming the flag, the value as typed and what it is read as.
  async function registerWith(cadence: string[], opts?: { json?: boolean; response?: StubResponse }) {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/watchdog/register": opts?.response ?? { status: 201, data: { jobId: "01J..." } } },
    });
    const tmp = mkdtempSync(join(tmpdir(), "wd-cli-"));
    const spec = join(tmp, "spec.yaml");
    writeFileSync(spec, "policy: artifact-pool-ready\n");
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "watchdog", "register", "--spec", spec, "--policy", "artifact-pool-ready",
      "--target-session", "alice@rig", "--registered-by", "ops@kernel", ...cadence, ...(opts?.json ? ["--json"] : []),
    ]);
    const call = calls.find((c) => c.path === "/api/watchdog/register");
    return { body: call?.body as Record<string, unknown> | undefined };
  }

  const CADENCE_FLAGS = [
    ["--interval-seconds", "intervalSeconds"],
    ["--active-wake-interval-seconds", "activeWakeIntervalSeconds"],
    ["--scan-interval-seconds", "scanIntervalSeconds"],
  ] as const;
  const withInterval = (flag: string, value: string) =>
    flag === "--interval-seconds" ? [flag, value] : ["--interval-seconds", "60", flag, value];

  for (const [flag, field] of CADENCE_FLAGS) {
    it.each([["5m", 5], ["1.5", 1], ["1e3", 1], ["30s", 30], ["10x", 10]])(
      `${flag} %s warns on stderr and still sends today's parsed value %d`,
      async (value, sent) => {
        const { body } = await registerWith(withInterval(flag, value));
        expect(body![field]).toBe(sent);
        expect(errors).toEqual([`Warning: ${flag} '${value}' is being interpreted as ${sent} seconds.`]);
      },
    );

    it(`${flag} abc warns that it is not a number and still sends today's NaN (null on the wire)`, async () => {
      const { body } = await registerWith(withInterval(flag, "abc"));
      expect(Number.isNaN(body![field])).toBe(true);
      expect(errors).toEqual([`Warning: ${flag} 'abc' is not a number.`]);
    });

    it.each(["5", "05", "0", "-5"])(`${flag} %s matches the number sent, so it stays quiet`, async (value) => {
      const { body } = await registerWith(withInterval(flag, value));
      expect(body![field]).toBe(Number.parseInt(value, 10));
      expect(errors).toEqual([]);
    });
  }

  it("omitted optional cadences stay omitted and quiet", async () => {
    const { body } = await registerWith(["--interval-seconds", "60"]);
    expect(body!.activeWakeIntervalSeconds).toBeUndefined();
    expect(body!.scanIntervalSeconds).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("a required abc still gets today's daemon refusal; --json stdout stays clean JSON and the exit is non-zero", async () => {
    const refusal = { error: "intervalSeconds is required" };
    await registerWith(["--interval-seconds", "abc"], { json: true, response: { status: 400, data: refusal } });
    expect(logs.map((line) => JSON.parse(line))).toEqual([refusal]);
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["Warning: --interval-seconds 'abc' is not a number."]);
    expect(errors.join("\n")).not.toMatch(/registered/i);
  });

  it("--json keeps stdout to the daemon's JSON when a warning is printed", async () => {
    await registerWith(["--interval-seconds", "5m"], { json: true });
    expect(logs.map((line) => JSON.parse(line))).toEqual([{ jobId: "01J..." }]);
    expect(errors).toEqual(["Warning: --interval-seconds '5m' is being interpreted as 5 seconds."]);
    expect(process.exitCode).toBeUndefined();
  });

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
    expect(register!.helpInformation()).toMatch(/queue block.*wake-watchdog/i);
  });

  it("registers a context threshold without a spec file", async () => {
    const { deps, calls } = makeDeps();
    const tmp = mkdtempSync(join(tmpdir(), "wd-cli-context-"));
    const transcript = join(tmp, "session.jsonl");
    writeFileSync(transcript, "1234");
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node",
      "rig",
      "watchdog",
      "register",
      "--policy",
      "context-usage-threshold",
      "--target-session",
      "alice@rig",
      "--threshold-mb",
      "1.5",
      "--watched-file",
      transcript,
      "--interval-seconds",
      "60",
      "--registered-by",
      "ops@kernel",
      "--message",
      "Prepare continuity now",
      "--json",
    ]);
    const request = calls.find((call) => call.path === "/api/watchdog/register");
    expect(request?.body).toMatchObject({
      policy: "context-usage-threshold",
      targetSession: "alice@rig",
      thresholdBytes: 1_500_000,
      watchedFilePath: transcript,
    });
    expect((request?.body as { specYaml: string }).specYaml).toContain("Prepare continuity now");
  });

  it("teaches conservative calibration and the margin rationale in register help", () => {
    const { deps } = makeDeps();
    const program = createProgram({ watchdogDeps: deps });
    const watchdog = program.commands.find((command) => command.name() === "watchdog");
    const register = watchdog?.commands.find((command) => command.name() === "register");
    const help = register?.helpInformation() ?? "";
    expect(help).toContain("context-usage-threshold");
    expect(help).toMatch(/113K.*153K.*tokens.*MB/i);
    expect(help).toMatch(/margin.*protection/i);
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

  it("list defaults to at most 100 active compact jobs", async () => {
    const jobs = Array.from({ length: 101 }, (_, index) => ({
      jobId: `job-${index}`,
      policy: "periodic-reminder",
      specYaml: `policy: periodic-reminder\nmessage: ${"x".repeat(1_000)}`,
      targetSession: `worker-${index}@rig`,
      intervalSeconds: 60,
      lastEvaluationAt: "2026-09-02T06:00:00.000Z",
      lastFireAt: null,
      actionable: index === 100,
      lastActionableAt: index === 100 ? "2026-09-02T06:00:00.000Z" : null,
      state: "active",
      registeredBySession: "ops@rig",
      registeredAt: "2026-09-02T05:00:00.000Z",
    }));
    jobs.push({
      ...jobs[0],
      jobId: "stopped-job",
      state: "stopped",
    });
    const { deps } = makeDeps({
      routes: { "GET /api/watchdog/list": { status: 200, data: jobs } },
    });
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "watchdog", "list", "--json"]);

    const result = JSON.parse(logs.at(-1)!) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(100);
    expect(result.every((job) => job.state === "active")).toBe(true);
    expect(result[0]).toEqual({
      jobId: "job-100",
      policy: "periodic-reminder",
      targetSession: "worker-100@rig",
      intervalSeconds: 60,
      lastEvaluationAt: "2026-09-02T06:00:00.000Z",
      lastFireAt: null,
      actionable: true,
      lastActionableAt: "2026-09-02T06:00:00.000Z",
      state: "active",
      registeredAt: "2026-09-02T05:00:00.000Z",
    });
    expect(result[0]).not.toHaveProperty("specYaml");
    expect(result.some((job) => job.jobId === "stopped-job")).toBe(false);
    expect(errors.at(-1)).toMatch(/Showing 100 of 101.*--all --full/);
  });

  it("list --all --full preserves the complete legacy record", async () => {
    const jobs = [
      {
        jobId: "active-job",
        policy: "periodic-reminder",
        specYaml: "policy: periodic-reminder\nmessage: full record",
        targetSession: "worker@rig",
        intervalSeconds: 60,
        state: "active",
      },
      {
        jobId: "stopped-job",
        policy: "periodic-reminder",
        specYaml: "policy: periodic-reminder\nmessage: stopped history",
        targetSession: "worker@rig",
        intervalSeconds: 60,
        state: "stopped",
      },
    ];
    const { deps } = makeDeps({
      routes: { "GET /api/watchdog/list": { status: 200, data: jobs } },
    });
    const program = createProgram({ watchdogDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node",
      "rig",
      "watchdog",
      "list",
      "--all",
      "--full",
      "--json",
    ]);

    expect(JSON.parse(logs.at(-1)!)).toEqual(jobs);
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
