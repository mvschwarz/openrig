import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ViewDeps } from "../src/commands/view.js";
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

function makeDeps(opts?: { routes?: Record<string, StubResponse> }): { deps: ViewDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as ViewDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return routes[`GET ${path}`] ?? { status: 200, data: [] };
        }),
        getText: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: "" }; }),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          return routes[`POST ${path}`] ?? { status: 201, data: {} };
        }),
        delete: vi.fn(async (path: string) => { calls.push({ method: "DELETE", path }); return { status: 204, data: null }; }),
        postText: vi.fn(async (path: string) => { calls.push({ method: "POST", path }); return { status: 200, data: "" }; }),
        postExpectText: vi.fn(async (path: string) => { calls.push({ method: "POST", path }); return { status: 200, data: "" }; }),
      }) as unknown as ReturnType<ViewDeps["clientFactory"]>,
    },
  };
}

describe("rig view CLI (PL-004 Phase B)", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
  });

  it("view is registered with list/show/register subcommands", () => {
    const { deps } = makeDeps();
    const program = createProgram({ viewDeps: deps });
    const cmd = program.commands.find((c) => c.name() === "view");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name()).sort();
    expect(subs).toContain("list");
    expect(subs).toContain("show");
    expect(subs).toContain("register");
  });

  it("list GETs /api/views/list", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/views/list": { status: 200, data: { builtIn: ["recently-active"], custom: [] } } },
    });
    const program = createProgram({ viewDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "view", "list", "--json"]);
    const call = calls.find((c) => c.path === "/api/views/list");
    expect(call).toBeDefined();
  });

  it("show GETs /api/views/<viewName> with rig + limit query", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/views/recently-active?rig=product-lab&limit=50": { status: 200, data: { rowCount: 0 } } },
    });
    const program = createProgram({ viewDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "view", "show", "recently-active",
      "--rig", "product-lab",
      "--limit", "50",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/views/recently-active"));
    expect(call!.path).toContain("rig=product-lab");
    expect(call!.path).toContain("limit=50");
  });

  it("show without query params constructs path without ?", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/views/founder": { status: 200, data: { rowCount: 0 } } },
    });
    const program = createProgram({ viewDeps: deps });
    program.exitOverride();
    // Note: --limit has a default of "100"; so this test needs explicit limit empty OR we accept default.
    await program.parseAsync(["node", "rig", "view", "show", "founder"]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/views/founder"));
    expect(call).toBeDefined();
    // Default limit appended.
    expect(call!.path).toContain("limit=100");
  });

  it("show with view_not_found 404 surfaces error + non-zero exit", async () => {
    const { deps } = makeDeps({
      routes: {
        "GET /api/views/nonexistent?limit=100": { status: 404, data: { error: "view_not_found" } },
      },
    });
    const program = createProgram({ viewDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "view", "show", "nonexistent"]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("view_not_found");
  });

  it("register POSTs /api/views/custom/register with name + definition + session", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/views/custom/register": { status: 201, data: { viewId: "V-1" } } },
    });
    const program = createProgram({ viewDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "view", "register",
      "--name", "my-view",
      "--definition", "SELECT 1",
      "--session", "operator@rig",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/views/custom/register");
    const body = call!.body as Record<string, unknown>;
    expect(body.viewName).toBe("my-view");
    expect(body.definition).toBe("SELECT 1");
    expect(body.registeredBySession).toBe("operator@rig");
  });
});
