import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamDeps } from "../src/commands/stream.js";
import { createProgram } from "../src/index.js";

/**
 * `rig stream` CLI tests — PL-004 Phase A revision (R1).
 *
 * Covers parser behavior, HTTP request shape, and non-2xx exit handling for
 * stream emit / list / show / archive. SSE consumer is daemon-side only at
 * Phase A (cli-side `watch` consumer is not in scope for v1; the route is
 * exposed for browser/dashboard tooling and in-process tests).
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
}): { deps: StreamDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as StreamDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return routes[`GET ${path}`] ?? { status: 200, data: [] };
        }),
        getText: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return { status: 200, data: "" };
        }),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          return routes[`POST ${path}`] ?? { status: 201, data: { streamItemId: "stream-test-1" } };
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
      }) as unknown as ReturnType<StreamDeps["clientFactory"]>,
    },
  };
}

describe("rig stream CLI", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });

  it("stream is registered on createProgram with emit/list/show/archive subcommands", () => {
    const { deps } = makeDeps();
    const program = createProgram({ streamDeps: deps });
    const streamCmd = program.commands.find((c) => c.name() === "stream");
    expect(streamCmd).toBeDefined();
    const subs = streamCmd!.commands.map((c) => c.name()).sort();
    expect(subs).toContain("emit");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
    expect(subs).toContain("archive");
  });

  it("emit POSTs to /api/stream/emit with sourceSession + body", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/stream/emit": {
          status: 201,
          data: { streamItemId: "stream-emitted", streamSortKey: "01KQ...", tsEmitted: "2026-05-03T00:00:00Z" },
        },
      },
    });
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "emit",
      "--source", "alice@rig",
      "--body", "stream content",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/stream/emit");
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    expect(body.sourceSession).toBe("alice@rig");
    expect(body.body).toBe("stream content");
  });

  it("emit with --id passes idempotent stream_item_id through", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "emit",
      "--source", "alice@rig",
      "--body", "x",
      "--id", "stream-fixed-id",
    ]);
    const call = calls.find((c) => c.path === "/api/stream/emit");
    expect((call!.body as { streamItemId: string }).streamItemId).toBe("stream-fixed-id");
  });

  it("list GETs /api/stream/list with limit + sourceSession query", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/stream/list?sourceSession=bob%40rig&limit=20": { status: 200, data: [] } },
    });
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "list",
      "--source", "bob@rig",
      "--limit", "20",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/stream/list"));
    expect(call).toBeDefined();
    expect(call!.path).toContain("sourceSession=bob%40rig");
    expect(call!.path).toContain("limit=20");
  });

  it("show GETs /api/stream/:id", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/stream/stream-x": { status: 200, data: { streamItemId: "stream-x" } } },
    });
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "show", "stream-x",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path === "/api/stream/stream-x");
    expect(call).toBeDefined();
  });

  it("archive POSTs to /api/stream/:id/archive", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/stream/stream-x/archive": { status: 200, data: { ok: true } } },
    });
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "archive", "stream-x",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "POST" && c.path === "/api/stream/stream-x/archive");
    expect(call).toBeDefined();
  });

  it("non-2xx response on emit exits non-zero with structured error in JSON", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/stream/emit": {
          status: 400,
          data: { error: "sourceSession is required" },
        },
      },
    });
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "emit",
      "--source", "alice@rig",
      "--body", "x",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("sourceSession is required");
  });

  it("show 404 for nonexistent id exits non-zero", async () => {
    const { deps } = makeDeps({
      routes: { "GET /api/stream/missing": { status: 404, data: { error: "stream item not found" } } },
    });
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "show", "missing",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
  });
});
