import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";

// `rig workflow instantiate|run --project/--mission/--slice/--tags`: the scope a
// run's packets carry, sent to the daemon as a `scope` object on BOTH verbs (run
// instantiates too). The object is what opts the request into the daemon's strict
// validation; bare fields keep their old meaning there (ignored). Unscoped
// invocations send no scope.

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

// `workflow run` follows the instance after creating it; the follow loop is not under test here.
vi.mock("../src/commands/workflow-follow.js", () => ({ followInstance: vi.fn(async () => 0) }));

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

describe("workflow scope flags", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  const run = async (verb: "instantiate" | "run", extra: string[]) => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/instantiate": { status: 201, data: { instance: {}, entryQitemId: "q-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", verb, "/abs/spec.yaml", "--root-objective", "obj", "--created-by", "ops@rig", "--json", ...extra]);
    return calls.find((c) => c.path === "/api/workflow/instantiate")!.body as Record<string, unknown>;
  };

  it.each(["instantiate", "run"] as const)("%s posts project, mission, slice and split tags", async (verb) => {
    const body = await run(verb, ["--project", "p1", "--mission", "m1", "--slice", "01-s1", "--tags", "ticket-7, area:db,"]);
    expect(body.scope).toEqual({ project: "p1", mission: "m1", slice: "01-s1", tags: ["ticket-7", "area:db"] });
    for (const key of ["project", "mission", "slice", "tags"]) expect(body).not.toHaveProperty(key);
  });

  it.each(["instantiate", "run"] as const)("%s sends only the flags given", async (verb) => {
    const body = await run(verb, ["--slice", "01-s1"]);
    expect(body.scope).toEqual({ slice: "01-s1" });
  });

  it.each(["instantiate", "run"] as const)("%s --slice help says the packets also need --project in a project-scoped view", (verb) => {
    const program = createProgram({ workflowDeps: makeDeps().deps });
    const command = program.commands.find((c) => c.name() === "workflow")!.commands.find((c) => c.name() === verb)!;
    const slice = command.options.find((o) => o.long === "--slice")!;
    expect(slice.description).toMatch(/--project/);
  });

  it.each(["instantiate", "run"] as const)("%s without scope flags sends none of the scope fields", async (verb) => {
    const body = await run(verb, []);
    for (const key of ["scope", "project", "mission", "slice", "tags"]) expect(body).not.toHaveProperty(key);
  });

  // Local checks: refused as a usage error before any request, using the daemon's own normalizer.
  describe.each(["instantiate", "run"] as const)("%s refuses what the CLI can check locally", (verb) => {
    it.each([
      ["a malformed project id", ["--project", "has space"], /not a valid project id/],
      ["a malformed slice id", ["--slice", "-bad"], /not a valid slice id/],
      ["a reserved tag", ["--tags", "gate"], /scope_tag_reserved/],
      ["a reserved-prefix tag", ["--tags", "instance:evil"], /scope_tag_reserved/],
      ["a tag that contradicts a flag", ["--project", "p1", "--tags", "project:other"], /scope_tag_contradiction/],
    ])("%s", async (_label, extra, message) => {
      const { deps, calls } = makeDeps();
      const program = createProgram({ workflowDeps: deps });
      program.exitOverride();
      const errors: string[] = [];
      program.configureOutput({ writeErr: (text) => errors.push(text), writeOut: () => {} });
      // subcommands were built before exitOverride, so they need it (and the output capture) themselves
      program.commands.find((c) => c.name() === "workflow")!.commands.forEach((c) => c.exitOverride().configureOutput({ writeErr: (text) => errors.push(text), writeOut: () => {} }));
      await expect(program.parseAsync(["node", "rig", "workflow", verb, "/abs/spec.yaml", "--root-objective", "obj", "--created-by", "ops@rig", ...extra])).rejects.toMatchObject({ code: "workflow.scope.invalid" });
      expect(errors.join("")).toMatch(message);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    });
  });

  // What only the daemon can check: an unknown --project. The daemon creates the instance unscoped and says so in the
  // response advisories; the CLI prints them to stderr (never stdout, so --json stays parseable) and does not retry.
  describe.each(["instantiate", "run"] as const)("%s with a project the daemon does not know", (verb) => {
    const NOTE = "Scope not applied (project_not_found: project 'nope' is not declared). Instance WF-1 was created unscoped: its packets carry no project, mission, slice or tag scope. Correct the scope and instantiate again for a scoped instance; that creates a second instance.";
    const reply = { instance: { instanceId: "WF-1", status: "active" }, entryQitemId: "q-1", advisories: [NOTE], scopeIgnored: { fields: ["scope"], message: NOTE } };

    const invoke = async (json: boolean) => {
      const { deps, calls } = makeDeps({ routes: { "POST /api/workflow/instantiate": { status: 201, data: reply } } });
      const stderr: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as never);
      const program = createProgram({ workflowDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "workflow", verb, "/abs/spec.yaml", "--root-objective", "obj", "--created-by", "ops@rig", "--project", "nope", ...(json ? ["--json"] : [])]);
      const stdout = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      return { calls, stderr: stderr.join(""), stdout };
    };

    it("prints the advice on stderr in text mode, names the instance, and does not read as a scoped success", async () => {
      const { calls, stderr, stdout } = await invoke(false);
      expect(stderr).toContain(`⚠ workflow advisory: ${NOTE}`);
      expect(stdout.join("\n")).toMatch(/WF-1/);
      expect(stdout.join("\n")).toMatch(/UNSCOPED/);
      expect(process.exitCode).toBeUndefined();
      // sent once: the CLI never retries, which would create a second instance
      expect(calls.filter((c) => c.path === "/api/workflow/instantiate")).toHaveLength(1);
    });

    it("with --json keeps stdout parseable and puts the advice on stderr", async () => {
      const { calls, stderr, stdout } = await invoke(true);
      expect(stderr).toContain(`⚠ workflow advisory: ${NOTE}`);
      for (const line of stdout) expect(() => JSON.parse(line)).not.toThrow();
      if (verb === "instantiate") expect(JSON.parse(stdout[0]!)).toMatchObject({ instance: { instanceId: "WF-1" }, scopeIgnored: { fields: ["scope"] } });
      expect(calls.filter((c) => c.path === "/api/workflow/instantiate")).toHaveLength(1);
    });
  });
});
