import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";
import { renderInstanceShow, renderTraceTree } from "../src/commands/workflow-render.js";

// OPR.0.4.6.FAC1 commit 2 — the CLI rig-binding surface (planner2
// §3.15): `--rig` lands on BOTH instantiate AND run (run instantiates
// too — missing it would silently narrow the founder surface), and the
// human renderers surface the bound rig while unbound rows stay
// byte-identical.

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

function makeDeps(opts?: { routes?: Record<string, StubResponse> }): {
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

describe("FAC-1 C2: --rig on both instantiate verbs + bound-rig rendering", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  it("instantiate --rig posts targetRig", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/instantiate": { status: 201, data: { instance: {}, entryQitemId: "q-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "workflow", "instantiate", "/abs/spec.yaml",
      "--root-objective", "obj",
      "--created-by", "ops@rig",
      "--rig", "factory-b",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/workflow/instantiate");
    expect((call!.body as Record<string, string>).targetRig).toBe("factory-b");
  });

  it("instantiate WITHOUT --rig omits targetRig (unbound default preserved)", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/instantiate": { status: 201, data: { instance: {}, entryQitemId: "q-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "workflow", "instantiate", "/abs/spec.yaml",
      "--root-objective", "obj",
      "--created-by", "ops@rig",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/workflow/instantiate");
    expect((call!.body as Record<string, unknown>).targetRig).toBeUndefined();
  });

  // OPR.0.4.6.FAC1 arch ruling 2026-07-07 (loudness = guard invariant #1):
  // when the daemon degrades a bad spec-default to unbound, it returns
  // `advisories`; the CLI MUST surface them to stderr even in --json mode
  // (a consumer piping stdout still sees the warning). Never silent.
  it("instantiate surfaces daemon advisories to STDERR even in --json mode", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/workflow/instantiate": {
          status: 201,
          data: {
            instance: { boundRig: null },
            entryQitemId: "q-1",
            advisories: [
              `workflow spec default target.rig "vanished-rig" is not a registered rig on this daemon — instantiating UNBOUND.`,
            ],
          },
        },
      },
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const program = createProgram({ workflowDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "workflow", "instantiate", "/abs/spec.yaml",
        "--root-objective", "obj",
        "--created-by", "ops@rig",
        "--json",
      ]);
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderr).toContain("advisory");
      expect(stderr).toContain("vanished-rig");
      expect(stderr).toContain("UNBOUND");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("run --rig posts targetRig too (the second instantiate call site)", async () => {
    const { deps, calls } = makeDeps({
      // No instanceId in the response → run prints and returns without
      // entering the follow loop (keeps this a pure body-shape test).
      routes: { "POST /api/workflow/instantiate": { status: 200, data: {} } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "workflow", "run", "/abs/spec.yaml",
      "--root-objective", "obj",
      "--created-by", "ops@rig",
      "--rig", "factory-a",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/workflow/instantiate");
    expect((call!.body as Record<string, string>).targetRig).toBe("factory-a");
  });

  it("renderInstanceShow: bound instance renders a rig line; unbound renders none (byte-stable)", () => {
    const bound = renderInstanceShow(
      { instanceId: "WF01", status: "active", boundRig: "factory-a" },
      "2026-07-07T10:00:00.000Z",
    );
    expect(bound.some((l) => l.includes("rig:      factory-a"))).toBe(true);

    const unbound = renderInstanceShow(
      { instanceId: "WF01", status: "active", boundRig: null },
      "2026-07-07T10:00:00.000Z",
    );
    expect(unbound.some((l) => l.includes("rig:"))).toBe(false);
  });

  it("renderTraceTree: the header carries rig=<name> when bound, nothing when unbound", () => {
    const bound = renderTraceTree(
      { instanceId: "WF01", status: "active", workflowName: "wf", boundRig: "factory-b" },
      [],
      "2026-07-07T10:00:00.000Z",
    );
    expect(bound[0]).toContain("rig=factory-b");

    const unbound = renderTraceTree(
      { instanceId: "WF01", status: "active", workflowName: "wf" },
      [],
      "2026-07-07T10:00:00.000Z",
    );
    expect(unbound[0]).not.toContain("rig=");
  });
});
