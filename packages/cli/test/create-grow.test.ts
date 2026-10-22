import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { createProgram } from "../src/index.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { RigDeps } from "../src/commands/rig.js";

function lifecycleDeps(): LifecycleDeps {
  const state: DaemonState = {
    pid: 123,
    port: 7433,
    db: "test.sqlite",
    startedAt: "2026-08-31T00:00:00Z",
  };
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((path: string) => path === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(run: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const oldLog = console.log;
    const oldError = console.error;
    const oldExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await run();
    } finally {
      console.log = oldLog;
      console.error = oldError;
    }
    const exitCode = process.exitCode;
    process.exitCode = oldExitCode;
    resolve({ logs, exitCode });
  });
}

function deps(client: Partial<DaemonClient>): StatusDeps {
  return {
    lifecycleDeps: lifecycleDeps(),
    clientFactory: () => client as DaemonClient,
  };
}

const library = [{
  kind: "agent",
  name: "orchestrator",
  sourceType: "builtin",
  sourcePath: "/opt/openrig/specs/agents/orchestration/orchestrator/agent.yaml",
}];

afterEach(() => vi.restoreAllMocks());

describe("rig create", () => {
  it("creates one launched seat from the shipped agent without user-authored YAML", async () => {
    let sentYaml = "";
    let sentHeaders: Record<string, string> | undefined;
    const client = {
      get: vi.fn(async () => ({ status: 200, data: library })),
      postText: vi.fn(async (_path, yaml, _contentType, headers) => {
        sentYaml = yaml;
        sentHeaders = headers;
        return {
          status: 201,
          data: {
            rigId: "rig-1",
            specName: "alpha",
            specVersion: "0.2",
            nodes: [{ logicalId: "main.lead", status: "launched", sessionName: "main-lead@alpha" }],
          },
        };
      }),
    };

    const program = createProgram({ createDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "create", "alpha", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.postText).toHaveBeenCalledWith(
      "/api/rigs/import",
      expect.any(String),
      "text/yaml",
      { "X-Rig-Root": "/work", "X-Cwd-Override": "/work" },
      { timeoutMs: 120_000 },
    );
    const spec = parseYaml(sentYaml);
    expect(spec).toEqual({
      version: "0.2",
      name: "alpha",
      pods: [{
        id: "main",
        label: "Main",
        members: [{
          id: "lead",
          agent_ref: "path:/opt/openrig/specs/agents/orchestration/orchestrator",
          runtime: "claude-code",
          profile: "default",
          cwd: "/work",
        }],
        edges: [],
      }],
      edges: [],
    });
    expect(sentHeaders).toEqual({ "X-Rig-Root": "/work", "X-Cwd-Override": "/work" });
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      rigId: "rig-1",
      pod: "main",
      seat: "main.lead",
    });
  });

  it("fails plainly when the shipped default agent is unavailable", async () => {
    const client = {
      get: vi.fn(async () => ({ status: 200, data: [] })),
      postText: vi.fn(),
    };
    const program = createProgram({ createDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "create", "alpha"]));

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("shipped default agent is unavailable");
    expect(logs.join("\n")).toContain('runtime "claude-code"');
    expect(logs.join("\n")).toContain("rig up <spec>");
    expect(client.postText).not.toHaveBeenCalled();
  });

  async function createWith(response: { status: number; data: Record<string, unknown> }, json: boolean) {
    const client = { get: vi.fn(async () => ({ status: 200, data: library })), postText: vi.fn(async () => response) };
    const program = createProgram({ createDeps: deps(client) });
    program.exitOverride();
    return captureLogs(() => program.parseAsync(["node", "rig", "create", "alpha", "--cwd", "/work", ...(json ? ["--json"] : [])]));
  }

  it.each([
    ["the daemon's errors", { status: 400, data: { errors: ["first problem", "second problem"] } }, "first problem; second problem"],
    ["the daemon's message", { status: 409, data: { message: "rig alpha is running" } }, "rig alpha is running"],
    ["a seat that needs attention", {
      status: 201,
      data: { rigId: "rig-1", nodes: [{ logicalId: "main.lead", status: "attention_required", error: "Startup requires attention: log in" }] },
    }, "Startup requires attention: log in"],
    ["no detail at all", { status: 500, data: {} }, "Create failed (HTTP 500)"],
  ])("a failed create's --json carries the reason the text output prints: %s", async (_label, response, reason) => {
    const json = await createWith(response, true);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.logs.join("\n"))).toMatchObject({ ok: false, detail: reason });

    const text = await createWith(response, false);
    expect(text.exitCode).toBe(1);
    expect(text.logs).toEqual([reason]);
  });

  it("a successful create's --json has no detail", async () => {
    const { logs } = await createWith({ status: 201, data: { rigId: "rig-1", nodes: [{ logicalId: "main.lead", status: "launched" }] } }, true);
    expect(JSON.parse(logs.join("\n"))).not.toHaveProperty("detail");
  });
});

describe("rig grow", () => {
  it("infers the only pod and adds one launched seat through the existing member ingress", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async () => ({
        status: 201,
        data: {
          ok: true,
          result: {
            podNamespace: "main",
            node: { logicalId: "main.worker", status: "launched", sessionName: "main-worker@alpha" },
          },
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "worker", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/pods/main/members",
      {
        member: {
          id: "worker",
          agent_ref: "path:/opt/openrig/specs/agents/orchestration/orchestrator",
          runtime: "claude-code",
          profile: "default",
          cwd: "/work",
        },
        rigRoot: "/work",
      },
      { timeoutMs: 120_000 },
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      rigName: "alpha",
      pod: "main",
      seat: "main.worker",
    });
  });

  it("adds several seats to an existing pod without YAML", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async (_path: string, body: { member: { id: string } }) => ({
        status: 201,
        data: {
          ok: true,
          result: {
            podNamespace: "main",
            node: {
              logicalId: `main.${body.member.id}`,
              status: "launched",
              sessionName: `main-${body.member.id}@alpha`,
            },
          },
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "worker", "qa", "--pod", "main", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/api/rigs/rig-1/pods/main/members",
      expect.objectContaining({ member: expect.objectContaining({ id: "worker" }) }),
      { timeoutMs: 120_000 },
    );
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      "/api/rigs/rig-1/pods/main/members",
      expect.objectContaining({ member: expect.objectContaining({ id: "qa" }) }),
      { timeoutMs: 120_000 },
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      pod: "main",
      seats: ["main.worker", "main.qa"],
    });
  });

  it("reports every outcome when existing-pod batch growth partially mutates", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async (_path: string, body: { member: { id: string } }) => body.member.id === "lead"
        ? {
            status: 409,
            data: {
              ok: false,
              message: "Member main.lead already exists. Pick a different member id.",
            },
          }
        : {
            status: 201,
            data: {
              ok: true,
              result: {
                podNamespace: "main",
                node: {
                  logicalId: "main.worker",
                  status: "launched",
                  sessionName: "main-worker@alpha",
                },
              },
            },
          }),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "lead", "worker", "--pod", "main"]));

    const output = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(output).toContain("[FAIL] main.lead");
    expect(output).toContain("already exists");
    expect(output).toContain("[OK] main.worker");
    expect(output).toContain("main-worker@alpha");
  });

  it("adds a new pod with several seats without YAML", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async (_path: string, _body: Record<string, unknown>) => {
        return {
          status: 201,
          data: {
            ok: true,
            status: "ok",
            podNamespace: "review",
            nodes: [
              { logicalId: "review.reviewer", status: "launched", sessionName: "review-reviewer@alpha" },
              { logicalId: "review.qa", status: "launched", sessionName: "review-qa@alpha" },
            ],
          },
        };
      }),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "reviewer", "qa", "--new-pod", "review", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/expand",
      expect.objectContaining({
        pod: {
          id: "review",
          label: "review",
          members: [
            expect.objectContaining({ id: "reviewer" }),
            expect.objectContaining({ id: "qa" }),
          ],
          edges: [],
        },
        rigRoot: "/work",
      }),
      { timeoutMs: 120_000 },
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      pod: "review",
      seats: ["review.reviewer", "review.qa"],
    });
  });

  it("preserves node outcomes and retry guidance for partial new-pod growth", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async () => ({
        status: 207,
        data: {
          ok: true,
          status: "partial",
          podNamespace: "review",
          nodes: [
            { logicalId: "review.reviewer", status: "launched", sessionName: "review-reviewer@alpha" },
            { logicalId: "review.qa", status: "failed", error: "harness launch failed" },
          ],
          warnings: ["review.qa needs attention"],
          retryTargets: ["review.qa"],
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "reviewer", "qa", "--new-pod", "review"]));

    const output = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(output).toContain("[OK] review.reviewer");
    expect(output).toContain("[FAIL] review.qa");
    expect(output).toContain("harness launch failed");
    expect(output).toContain("review.qa needs attention");
    expect(output).toContain("rig launch rig-1 review.qa");
  });

  it("keeps partial new-pod JSON actionable", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async () => ({
        status: 207,
        data: {
          ok: true,
          status: "partial",
          podNamespace: "review",
          nodes: [
            { logicalId: "review.reviewer", status: "launched" },
            { logicalId: "review.qa", status: "failed", error: "harness launch failed" },
          ],
          retryTargets: ["review.qa"],
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "reviewer", "qa", "--new-pod", "review", "--json"]));

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: false,
      nodes: [
        { logicalId: "review.reviewer", status: "launched" },
        { logicalId: "review.qa", status: "failed", error: "harness launch failed" },
      ],
      retryTargets: ["review.qa"],
    });
  });

  it("requires --pod when the target is ambiguous", async () => {
    const client = {
      get: vi.fn(async () => ({
        status: 200,
        data: [
          { rigName: "alpha", podNamespace: "main" },
          { rigName: "alpha", podNamespace: "review" },
        ],
      })),
      post: vi.fn(),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "worker"]));

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Choose a pod with --pod");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("registers both public verbs", () => {
    const names = createProgram().commands.map((command) => command.name());
    expect(names).toContain("create");
    expect(names).toContain("grow");
  });

  describe("rig name or id resolution", () => {
    const RIG_SUMMARY = [
      { id: "01J00000000000000000000001", name: "my-rig", archivedAt: null },
      { id: "01J00000000000000000000002", name: "dup-rig", archivedAt: null },
      { id: "01J00000000000000000000003", name: "dup-rig", archivedAt: null },
    ];

    it("resolves a unique rig name to its id", async () => {
      const client = {
        get: vi.fn(async (path: string) => {
          if (path.includes("/api/rigs/summary")) return { status: 200, data: RIG_SUMMARY };
          if (path.includes("specs/library")) return { status: 200, data: library };
          return { status: 200, data: [{ rigName: "my-rig", podNamespace: "main" }] };
        }),
        post: vi.fn(async () => ({
          status: 201,
          data: {
            ok: true,
            result: {
              podNamespace: "main",
              node: { logicalId: "main.worker", status: "launched", sessionName: "main-worker@my-rig" },
            },
          },
        })),
      };

      const program = createProgram({ growDeps: deps(client) });
      program.exitOverride();
      const { logs, exitCode } = await captureLogs(() =>
        program.parseAsync(["node", "rig", "grow", "my-rig", "worker", "--pod", "main", "--json"]));

      expect(exitCode).toBeUndefined();
      expect(client.post).toHaveBeenCalledWith(
        "/api/rigs/01J00000000000000000000001/pods/main/members",
        expect.anything(),
        expect.anything(),
      );
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        ok: true,
        rigId: "01J00000000000000000000001",
      });
    });

    it("resolves an exact id", async () => {
      const client = {
        get: vi.fn(async (path: string) => {
          if (path.includes("/api/rigs/summary")) return { status: 200, data: RIG_SUMMARY };
          if (path.includes("specs/library")) return { status: 200, data: library };
          return { status: 200, data: [{ rigName: "my-rig", podNamespace: "main" }] };
        }),
        post: vi.fn(async () => ({
          status: 201,
          data: {
            ok: true,
            result: {
              podNamespace: "main",
              node: { logicalId: "main.worker", status: "launched", sessionName: "main-worker@my-rig" },
            },
          },
        })),
      };

      const program = createProgram({ growDeps: deps(client) });
      program.exitOverride();
      const { logs, exitCode } = await captureLogs(() =>
        program.parseAsync(["node", "rig", "grow", "01J00000000000000000000001", "worker", "--pod", "main", "--json"]));

      expect(exitCode).toBeUndefined();
      expect(client.post).toHaveBeenCalledWith(
        "/api/rigs/01J00000000000000000000001/pods/main/members",
        expect.anything(),
        expect.anything(),
      );
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        ok: true,
        rigId: "01J00000000000000000000001",
      });
    });

    it("warns to use rig id when summary lookup fails (HTTP 500) and downstream node lookup fails", async () => {
      const client = {
        get: vi.fn(async (path: string) => {
          if (path.includes("/api/rigs/summary")) return { status: 500, data: { error: "Internal Server Error" } };
          if (path.includes("specs/library")) return { status: 200, data: library };
          return { status: 404, data: { error: "Rig not found" } };
        }),
        post: vi.fn(),
      };

      const program = createProgram({ growDeps: deps(client) });
      program.exitOverride();
      const { logs, exitCode } = await captureLogs(() =>
        program.parseAsync(["node", "rig", "grow", "my-rig", "worker", "--pod", "main"]));

      expect(exitCode).toBe(1);
      const output = logs.join("\n");
      expect(output).toContain("Rig my-rig was not found.");
      expect(output).toContain("Could not list rigs to resolve a name. If this is a rig name, pass the rig id instead (rig ps --json).");
    });

    it("refuses an ambiguous rig name and reports candidate ids", async () => {
      const client = {
        get: vi.fn(async (path: string) => {
          if (path.includes("/api/rigs/summary")) return { status: 200, data: RIG_SUMMARY };
          return { status: 200, data: [] };
        }),
        post: vi.fn(),
      };

      const program = createProgram({ growDeps: deps(client) });
      program.exitOverride();
      const { logs, exitCode } = await captureLogs(() =>
        program.parseAsync(["node", "rig", "grow", "dup-rig", "worker", "--pod", "main"]));

      expect(exitCode).toBe(1);
      expect(client.post).not.toHaveBeenCalled();
      const output = logs.join("\n");
      expect(output).toContain("'dup-rig' matches 2 rigs");
      expect(output).toContain("01J00000000000000000000002");
      expect(output).toContain("01J00000000000000000000003");
    });
  });
});

describe("rig spec show", () => {
  it("prints a reusable template without adding an MCP surface", async () => {
    const yaml = `version: "0.2"\nname: alpha\npods:\n  - id: main\n    label: Main\n    members:\n      - id: lead\n        agent_ref: path:/opt/agent\n        profile: default\n        runtime: codex\n        cwd: /work\n        session_source:\n          mode: fork\n          ref:\n            kind: native_id\n            value: old\n        starter_ref:\n          name: old\n    edges: []\nedges: []\n`;
    const client = {
      getText: vi.fn(async () => ({ status: 200, data: yaml })),
    };
    const rigDeps: RigDeps = {
      ...deps(client),
      readFile: vi.fn(),
    };
    const program = createProgram({ rigDeps });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "spec", "show", "rig-1", "--as-template", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.getText).toHaveBeenCalledWith("/api/rigs/rig-1/spec");
    const template = JSON.parse(logs.join("\n"));
    expect(template.name).toBe("REPLACE-ME");
    expect(template.pods[0].members[0]).not.toHaveProperty("session_source");
    expect(template.pods[0].members[0]).not.toHaveProperty("starter_ref");
    expect(createProgram().commands.find((command) => command.name() === "spec")?.commands.map((command) => command.name()))
      .toContain("show");
  });
});
