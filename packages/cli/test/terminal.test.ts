// OPR.0.4.6.02 C3 — the `rig terminal` CLI family. Pins arg parsing, the daemon
// path/body each subcommand hits, the --json shape, and the open exit
// semantics (partial-with-names = exit 0; zero-pane = non-zero).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalDeps } from "../src/commands/terminal.js";
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

function makeDeps(opts?: { routes?: Record<string, StubResponse> }): {
  deps: TerminalDeps;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as TerminalDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return routes[`GET ${path}`] ?? { status: 200, data: {} };
        }),
        getText: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: "" }; }),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          return routes[`POST ${path}`] ?? { status: 200, data: {} };
        }),
        delete: vi.fn(async (path: string) => { calls.push({ method: "DELETE", path }); return { status: 204, data: null }; }),
        postText: vi.fn(async (path: string) => { calls.push({ method: "POST", path }); return { status: 200, data: "" }; }),
        postExpectText: vi.fn(async (path: string) => { calls.push({ method: "POST", path }); return { status: 200, data: "" }; }),
      }) as unknown as ReturnType<TerminalDeps["clientFactory"]>,
    },
  };
}

const opened = (seats: string[], extra: Record<string, unknown> = {}) => ({
  provider: "herdr", ok: seats.length > 0, opened: seats, absent: [], degraded: [], pages: 1, ...extra,
});

describe("rig terminal CLI", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  it("registers open/views/status subcommands", () => {
    const { deps } = makeDeps();
    const program = createProgram({ terminalDeps: deps });
    const cmd = program.commands.find((c) => c.name() === "terminal");
    expect(cmd).toBeDefined();
    expect(cmd!.commands.map((c) => c.name()).sort()).toEqual(["open", "status", "views"]);
  });

  it("open POSTs /api/terminal/open with view + provider", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/terminal/open": { status: 200, data: opened(["a-seat"]) } },
    });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "open", "acme-build", "--provider", "cmux", "--json"]);
    const call = calls.find((c) => c.path === "/api/terminal/open");
    expect(call!.body).toEqual({ view: "acme-build", provider: "cmux" });
  });

  it("open with a partial (some opened, some named) is a SUCCESS — exit 0", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/terminal/open": {
          status: 200,
          data: opened(["a-seat"], { absent: [{ seat: "b", host: null, reason: "not alive" }] }),
        },
      },
    });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "open", "acme-build"]);
    expect(process.exitCode).toBeUndefined(); // exit 0 (disclosure, not failure)
  });

  it("open with ZERO panes opened is a failure — non-zero exit", async () => {
    const { deps } = makeDeps({
      routes: { "POST /api/terminal/open": { status: 200, data: opened([], { ok: false, code: "herdr_unavailable", error: "no binary" }) } },
    });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "open", "acme-build"]);
    expect(process.exitCode).toBe(1);
  });

  it("open of an unknown view (404) exits non-zero and surfaces the reason", async () => {
    const { deps } = makeDeps({
      routes: { "POST /api/terminal/open": { status: 404, data: { provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "view_not_found", error: "unknown view 'nope'" } } },
    });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "open", "nope", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("view_not_found");
  });

  it("views GETs /api/terminal/views", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/terminal/views": { status: 200, data: { saved: [], rigs: ["acme-build"] } } },
    });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "views", "--json"]);
    expect(calls.find((c) => c.path === "/api/terminal/views")).toBeDefined();
  });

  it("status GETs /api/terminal/status with the provider query", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/terminal/status?provider=herdr": { status: 200, data: { providers: [] } } },
    });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "status", "--provider", "herdr", "--json"]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/terminal/status"));
    expect(call!.path).toContain("provider=herdr");
  });
});
