import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectDeps } from "../src/commands/project.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface StubResponse { status: number; data: unknown }

function makeDeps(opts?: { routes?: Record<string, StubResponse> }): { deps: ProjectDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as ProjectDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return routes[`GET ${path}`] ?? { status: 200, data: {} };
        }),
        getText: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: "" }; }),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          return routes[`POST ${path}`] ?? { status: 201, data: {} };
        }),
        delete: vi.fn(async (path: string) => { calls.push({ method: "DELETE", path }); return { status: 204, data: null }; }),
        postText: vi.fn(async (path: string) => { calls.push({ method: "POST", path }); return { status: 200, data: "" }; }),
        postExpectText: vi.fn(async (path: string) => { calls.push({ method: "POST", path }); return { status: 200, data: "" }; }),
      }) as unknown as ReturnType<ProjectDeps["clientFactory"]>,
    },
  };
}

describe("rig project CLI (PL-004 Phase B)", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
  });

  it("project is registered with all R1 subcommands", () => {
    const { deps } = makeDeps();
    const program = createProgram({ projectDeps: deps });
    const cmd = program.commands.find((c) => c.name() === "project");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name()).sort();
    expect(subs).toContain("lease-acquire");
    expect(subs).toContain("lease-heartbeat");
    expect(subs).toContain("lease-show");
    expect(subs).toContain("reclaim-classifier");
    expect(subs).toContain("classify");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
  });

  it("lease-acquire POSTs /api/projects/lease/acquire with classifierSession", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/projects/lease/acquire": { status: 201, data: { state: "active" } } },
    });
    const program = createProgram({ projectDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "project", "lease-acquire", "--session", "alice@rig", "--json"]);
    const call = calls.find((c) => c.path === "/api/projects/lease/acquire");
    expect((call!.body as { classifierSession: string }).classifierSession).toBe("alice@rig");
  });

  it("classify POSTs /api/projects/project with stream-item-id + classification fields", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/projects/project": { status: 201, data: { projectId: "P-1" } } },
    });
    const program = createProgram({ projectDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "project", "classify", "stream-x",
      "--session", "alice@rig",
      "--type", "idea",
      "--urgency", "high",
      "--destination", "planning@rig",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/projects/project");
    const body = call!.body as Record<string, unknown>;
    expect(body.streamItemId).toBe("stream-x");
    expect(body.classifierSession).toBe("alice@rig");
    expect(body.classificationType).toBe("idea");
    expect(body.classificationUrgency).toBe("high");
    expect(body.classificationDestination).toBe("planning@rig");
  });

  it("R1 BLOCKER 1: classify with unknown_stream_item 400 surfaces error + non-zero exit", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/projects/project": {
          status: 400,
          data: {
            error: "unknown_stream_item",
            message: "stream_item_id stream-nonexistent does not exist in stream_items",
            streamItemId: "stream-nonexistent",
          },
        },
      },
    });
    const program = createProgram({ projectDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "project", "classify", "stream-nonexistent",
      "--session", "alice@rig",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("unknown_stream_item");
    expect(out).toContain("does not exist");
  });

  it("classify with idempotency_violation 409 surfaces error + non-zero exit", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/projects/project": {
          status: 409,
          data: { error: "idempotency_violation", message: "stream-x already projected" },
        },
      },
    });
    const program = createProgram({ projectDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "project", "classify", "stream-x",
      "--session", "alice@rig",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("idempotency_violation");
  });

  it("reclaim-classifier --if-dead passes ifDead: true", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/projects/reclaim-classifier": { status: 200, data: { state: "reclaimed" } } },
    });
    const program = createProgram({ projectDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "project", "reclaim-classifier",
      "--session", "operator@rig",
      "--if-dead",
      "--reason", "alice unresponsive",
    ]);
    const call = calls.find((c) => c.path === "/api/projects/reclaim-classifier");
    const body = call!.body as Record<string, unknown>;
    expect(body.byClassifierSession).toBe("operator@rig");
    expect(body.ifDead).toBe(true);
    expect(body.reason).toBe("alice unresponsive");
  });

  it("list constructs /api/projects/list with filter params", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/projects/list?classificationDestination=planning%40rig&limit=50": { status: 200, data: [] } },
    });
    const program = createProgram({ projectDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "project", "list",
      "--destination", "planning@rig",
      "--limit", "50",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/projects/list"));
    expect(call!.path).toContain("classificationDestination=planning%40rig");
    expect(call!.path).toContain("limit=50");
  });
});
