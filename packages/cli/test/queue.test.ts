import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

/**
 * `rig queue` CLI tests — PL-004 Phase A revision (R1).
 *
 * Pattern mirrors compact-plan.test.ts: mock daemon-lifecycle to fake a
 * running daemon, inject a clientFactory that returns a stubbed HTTP client.
 * Tests assert: command parsing, HTTP request shape, non-2xx exit handling,
 * hot-potato error rendering. No real daemon, no DB, no network.
 */

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface StubResponse {
  status: number;
  data: unknown;
}

function makeDeps(opts?: {
  routes?: Record<string, StubResponse>;
}): { deps: QueueDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
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
          return routes[`POST ${path}`] ?? { status: 201, data: { qitemId: "qitem-test-1" } };
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
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("rig queue CLI", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });

  it("queue is registered on createProgram with all R1 subcommands", async () => {
    const { deps } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    const queueCmd = program.commands.find((c) => c.name() === "queue");
    expect(queueCmd).toBeDefined();
    const subs = queueCmd!.commands.map((c) => c.name()).sort();
    // R1 ratified contract: handoff-and-complete + whoami present alongside the originals.
    expect(subs).toContain("create");
    expect(subs).toContain("handoff");
    expect(subs).toContain("handoff-and-complete");
    expect(subs).toContain("whoami");
    expect(subs).toContain("update");
    expect(subs).toContain("inbox-drop");
    expect(subs).toContain("inbox-absorb");
    expect(subs).toContain("inbox-deny");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
  });

  it("create POSTs to /api/queue/create with sourceSession + destinationSession + body", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "qitem-x", state: "pending" } } },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig",
      "--destination", "bob@rig",
      "--body", "do thing",
      "--json",
    ]);
    const create = calls.find((c) => c.path === "/api/queue/create");
    expect(create).toBeDefined();
    const body = create!.body as Record<string, unknown>;
    expect(body.sourceSession).toBe("alice@rig");
    expect(body.destinationSession).toBe("bob@rig");
    expect(body.body).toBe("do thing");
    // R1: commander's --no-nudge sets opts.nudge to true by default.
    // The CLI sends nudge: true, and the daemon treats nudge !== false as nudging.
    expect(body.nudge).toBe(true);
  });

  it("create --no-nudge passes nudge: false to the daemon (cold-queue opt-out)", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig",
      "--destination", "bob@rig",
      "--body", "cold",
      "--no-nudge",
    ]);
    const create = calls.find((c) => c.path === "/api/queue/create");
    expect((create!.body as { nudge: boolean }).nudge).toBe(false);
  });

  it("update --state done WITHOUT --closure-reason renders structured hot-potato error and exits non-zero", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/queue/qitem-x/update": {
          status: 400,
          data: {
            error: "missing_closure_reason",
            message: "state=done requires closure_reason; valid values: handed_off_to, blocked_on, denied, canceled, no-follow-on, escalation",
            validReasons: ["handed_off_to", "blocked_on", "denied", "canceled", "no-follow-on", "escalation"],
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "update", "qitem-x",
      "--actor", "bob@rig",
      "--state", "done",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("missing_closure_reason");
    expect(out).toContain("validReasons");
  });

  it("handoff-and-complete POSTs to /api/queue/:id/handoff-and-complete with from + to", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/qitem-src/handoff-and-complete": {
          status: 201,
          data: {
            closed: { state: "done", closureReason: "handed_off_to" },
            created: { state: "pending", qitemId: "qitem-new" },
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff-and-complete", "qitem-src",
      "--from", "bob@rig",
      "--to", "carol@rig",
      "--body", "carol's piece",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/queue/qitem-src/handoff-and-complete");
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    expect(body.fromSession).toBe("bob@rig");
    expect(body.toSession).toBe("carol@rig");
    expect(body.body).toBe("carol's piece");
  });

  it("whoami GETs /api/queue/whoami with session + recentLimit query params", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "GET /api/queue/whoami?session=bob%40rig&recentLimit=10": {
          status: 200,
          data: {
            session: "bob@rig",
            asDestination: { pending: 2, inProgress: 1, blocked: 0, recent: [] },
            asSource: { total: 5 },
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "whoami",
      "--session", "bob@rig",
      "--recent-limit", "10",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/whoami"));
    expect(call).toBeDefined();
    expect(call!.path).toContain("session=bob%40rig");
    expect(call!.path).toContain("recentLimit=10");
  });

  it("whoami defaults the session from OPENRIG_SESSION_NAME when --session is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "GET /api/queue/whoami?session=bob%40rig&recentLimit=25": {
            status: 200,
            data: {
              session: "bob@rig",
              asDestination: { pending: 1, inProgress: 0, blocked: 0, recent: [] },
              asSource: { total: 0 },
            },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "whoami", "--json"]);

      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/whoami"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("session=bob%40rig");
      expect(call!.path).toContain("recentLimit=25");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("claim defaults the destination from OPENRIG_SESSION_NAME when --destination is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/claim": {
            status: 200,
            data: { qitemId: "qitem-x", destinationSession: "bob@rig", state: "in-progress" },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "claim", "qitem-x", "--json"]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/claim");
      expect(call).toBeDefined();
      expect((call!.body as { destinationSession: string }).destinationSession).toBe("bob@rig");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("update defaults the actor from OPENRIG_SESSION_NAME when --actor is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/update": {
            status: 200,
            data: { qitemId: "qitem-x", state: "done", closureReason: "no-follow-on" },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "update", "qitem-x",
        "--state", "done",
        "--closure-reason", "no-follow-on",
        "--json",
      ]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/update");
      expect(call).toBeDefined();
      expect((call!.body as { actorSession: string }).actorSession).toBe("bob@rig");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("handoff defaults the source from OPENRIG_SESSION_NAME when --from is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/handoff": {
            status: 201,
            data: { closed: { state: "handed-off" }, created: { qitemId: "qitem-new" } },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "handoff", "qitem-x",
        "--to", "carol@rig",
        "--json",
      ]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/handoff");
      expect(call).toBeDefined();
      expect((call!.body as { fromSession: string }).fromSession).toBe("bob@rig");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("create against unknown destination rig surfaces 400 error and exits non-zero", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/queue/create": {
          status: 400,
          data: {
            error: "unknown_destination_rig",
            message: "destination_session bob@phantom-rig references an unknown rig",
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@known-rig",
      "--destination", "bob@phantom-rig",
      "--body", "x",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("unknown_destination_rig");
  });

  it("handoff with --no-nudge passes nudge: false through to daemon", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/qitem-x/handoff": {
          status: 201,
          data: { closed: {}, created: {} },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff", "qitem-x",
      "--from", "bob@rig",
      "--to", "carol@rig",
      "--no-nudge",
    ]);
    const call = calls.find((c) => c.path === "/api/queue/qitem-x/handoff");
    expect((call!.body as { nudge: boolean }).nudge).toBe(false);
  });

  it("list constructs /api/queue/list with filter params", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/queue/list?destinationSession=bob%40rig&state=pending&limit=50": { status: 200, data: [] } },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "list",
      "--destination", "bob@rig",
      "--state", "pending",
      "--limit", "50",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
    expect(call).toBeDefined();
    expect(call!.path).toContain("destinationSession=bob%40rig");
    expect(call!.path).toContain("state=pending");
    expect(call!.path).toContain("limit=50");
  });
});
