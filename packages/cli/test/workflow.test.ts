import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDeps } from "../src/commands/workflow.js";
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
  deps: WorkflowDeps;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
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
            return routes[`POST ${path}`] ?? { status: 200, data: {} };
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
        }) as unknown as ReturnType<WorkflowDeps["clientFactory"]>,
    },
  };
}

describe("rig workflow CLI (PL-004 Phase D)", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
  });

  it("workflow command is registered with all 7 subcommands", () => {
    const { deps } = makeDeps();
    const program = createProgram({ workflowDeps: deps });
    const cmd = program.commands.find((c) => c.name() === "workflow");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name()).sort();
    expect(subs).toContain("validate");
    expect(subs).toContain("instantiate");
    expect(subs).toContain("project");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
    expect(subs).toContain("trace");
    expect(subs).toContain("continue");
  });

  it("validate POSTs /api/workflow/validate with specPath", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/validate": { status: 200, data: { ok: true } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "validate", "/abs/path.yaml", "--json"]);
    const call = calls.find((c) => c.path === "/api/workflow/validate");
    expect((call!.body as { specPath: string }).specPath).toBe("/abs/path.yaml");
  });

  it("instantiate POSTs /api/workflow/instantiate with required fields", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/instantiate": { status: 201, data: { instance: {}, entryQitemId: "q-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "workflow", "instantiate", "/abs/spec.yaml",
      "--root-objective", "test obj",
      "--created-by", "ops@rig",
      "--entry-owner", "alice@rig",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/workflow/instantiate");
    const body = call!.body as Record<string, string>;
    expect(body.specPath).toBe("/abs/spec.yaml");
    expect(body.rootObjective).toBe("test obj");
    expect(body.createdBySession).toBe("ops@rig");
    expect(body.entryOwnerSession).toBe("alice@rig");
  });

  it("project POSTs /api/workflow/project with all fields incl exit", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/project": { status: 200, data: { nextQitemId: "q-2" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "workflow", "project",
      "--instance", "inst-1",
      "--current-packet", "q-1",
      "--exit", "handoff",
      "--actor-session", "producer@rig",
      "--result-note", "produced",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/workflow/project");
    const body = call!.body as Record<string, string>;
    expect(body.instanceId).toBe("inst-1");
    expect(body.currentPacketId).toBe("q-1");
    expect(body.exit).toBe("handoff");
    expect(body.actorSession).toBe("producer@rig");
    expect(body.resultNote).toBe("produced");
  });

  it("list GETs /api/workflow/list optionally with status filter", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/workflow/list?status=active": { status: 200, data: [] } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "list", "--status", "active", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/list?status=active")).toBeDefined();
  });

  it("show GETs /api/workflow/:instanceId", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/workflow/inst-1": { status: 200, data: { instanceId: "inst-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "show", "inst-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/inst-1")).toBeDefined();
  });

  it("trace GETs /api/workflow/:instanceId/trace", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/workflow/inst-1/trace": { status: 200, data: { instance: {}, trail: [] } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "trace", "inst-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/inst-1/trace")).toBeDefined();
  });

  it("continue POSTs /api/workflow/:instanceId/continue", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/inst-1/continue": { status: 200, data: { instance: {}, trail: [] } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "continue", "inst-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/inst-1/continue")).toBeDefined();
  });
});
