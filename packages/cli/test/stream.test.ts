import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamDeps } from "../src/commands/stream.js";
import { createProgram } from "../src/index.js";

/**
 * `rig stream` CLI tests — PL-004 Phase A revision (R1).
 *
 * Covers parser behavior, HTTP request shape, and non-2xx exit handling for
 * stream emit / list / show / archive plus the GA CLI watch consumer over the
 * already-shipped SSE route.
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
        baseUrl: "http://configured-stream-daemon.test:8444",
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

  it("emit passes observation format through without changing required flags", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "emit",
      "--source", "alice@rig",
      "--body", "structured observation",
      "--format", "markdown",
    ]);
    const body = calls.find((call) => call.path === "/api/stream/emit")!.body as Record<string, unknown>;
    expect(body.format).toBe("markdown");
  });

  it("list passes exact tag and time-window filters through", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "stream", "list",
      "--tag", "review",
      "--since", "2026-08-03T09:00:00.000Z",
      "--until", "2026-08-03T10:00:00.000Z",
    ]);
    const call = calls.find((entry) => entry.method === "GET" && entry.path.startsWith("/api/stream/list"));
    expect(call?.path).toContain("hintTag=review");
    expect(call?.path).toContain("since=2026-08-03T09%3A00%3A00.000Z");
    expect(call?.path).toContain("until=2026-08-03T10%3A00%3A00.000Z");
  });

  it("watch consumes chunk-safe UTF-8, CRLF, multi-event, and EOF SSE frames as JSON lines", async () => {
    const { deps } = makeDeps();
    const encoder = new TextEncoder();
    const items = [
      { streamItemId: "stream-1", tsEmitted: "2026-08-03T09:00:00.000Z", sourceSession: "alice@rig", body: "café" },
      { streamItemId: "stream-2", tsEmitted: "2026-08-03T09:01:00.000Z", sourceSession: "bob@rig", body: "second" },
      { streamItemId: "stream-3", tsEmitted: "2026-08-03T09:02:00.000Z", sourceSession: "carol@rig", body: "eof" },
    ];
    const payload = `id: stream-1\r\ndata: ${JSON.stringify(items[0])}\r\n\r\ndata: ${JSON.stringify(items[1])}\n\ndata: not-json\n\ndata: ${JSON.stringify(items[2])}`;
    const bytes = encoder.encode(payload);
    const unicodeStart = bytes.findIndex((byte) => byte === 0xc3);
    const firstDelimiter = payload.indexOf("\r\n\r\n");
    const cuts = [3, unicodeStart + 1, unicodeStart + 2, firstDelimiter + 1, firstDelimiter + 4, bytes.length - 9]
      .filter((cut, index, all) => cut > 0 && cut < bytes.length && all.indexOf(cut) === index)
      .sort((a, b) => a - b);
    const chunks: Uint8Array[] = [];
    let start = 0;
    for (const cut of cuts) {
      chunks.push(bytes.slice(start, cut));
      start = cut;
    }
    chunks.push(bytes.slice(start));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://configured-stream-daemon.test:8444/api/stream/sse");
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    deps.fetchImpl = fetchImpl as typeof fetch;

    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "stream", "watch", "--json"]);

    expect(logs).toEqual(items.map((item) => JSON.stringify(item)));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("watch renders timestamp, source, and body for humans", async () => {
    const { deps } = makeDeps();
    const item = {
      streamItemId: "stream-1",
      tsEmitted: "2026-08-03T09:00:00.000Z",
      sourceSession: "alice@rig",
      body: "noticed",
    };
    deps.fetchImpl = vi.fn(async () => new Response(`data: ${JSON.stringify(item)}\n\n`, { status: 200 })) as typeof fetch;
    const program = createProgram({ streamDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "stream", "watch"]);
    expect(logs).toEqual(["[2026-08-03T09:00:00.000Z alice@rig] noticed"]);
  });

  it("watch names HTTP, missing-body, and transport failures without reconnecting", async () => {
    const runWatch = async (fetchImpl: ReturnType<typeof vi.fn>) => {
      const { deps } = makeDeps();
      deps.fetchImpl = fetchImpl as typeof fetch;
      const program = createProgram({ streamDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "stream", "watch"]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    };

    await runWatch(vi.fn(async () => new Response(null, { status: 503 })));
    await runWatch(vi.fn(async () => new Response(null, { status: 200 })));
    await runWatch(vi.fn(async () => { throw new Error("socket closed"); }));

    expect(errors).toEqual([
      "Watch failed (HTTP 503)",
      "Watch failed: response body missing",
      "Watch error: socket closed",
    ]);
  });
});
