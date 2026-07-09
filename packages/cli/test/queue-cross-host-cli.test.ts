// OPR.0.4.6.MH3 C3 — the CLI edge of cross-host queue routing (D-2/D-3).
// Pins:
//   - resolveQueueHostDestination: human-seat classifier FIRST; <2 `@` =
//     passthrough; >=2 `@` = split on the LAST `@`, trailing segment stripped
//     into hostId (unconditional — queue destinations are canonical-only, so
//     a typo dies loud as an unknown HOST, not a rig-shaped error);
//     --host + a DIFFERENT qualifier = structured ambiguity error;
//     empty trailing segment = structured error;
//   - the 3-part string NEVER leaves the CLI edge: the request body carries
//     the 2-part destination + the out-of-band hostId envelope (BR-1);
//   - D-2 explicit-only: no persisted-selection lookup anywhere on this path
//     (the resolver is pure; the commands add no selection fallback);
//   - local invocations post byte-identical bodies (no hostId key at all).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QueueDeps } from "../src/commands/queue.js";
import { resolveQueueHostDestination } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

function makeDeps(): { deps: QueueDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: {} }; }),
        getText: vi.fn(async () => ({ status: 200, data: "" })),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          return { status: 201, data: { qitemId: "qitem-test-1" } };
        }),
        delete: vi.fn(async () => ({ status: 204, data: null })),
        postText: vi.fn(async () => ({ status: 200, data: "" })),
        postExpectText: vi.fn(async () => ({ status: 200, data: "" })),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("resolveQueueHostDestination (D-3)", () => {
  it("plain 2-part destination passes through untouched (with or without --host)", () => {
    expect(resolveQueueHostDestination("dev@rig-b")).toEqual({ ok: true, destination: "dev@rig-b", hostId: undefined });
    expect(resolveQueueHostDestination("dev@rig-b", "vps-b")).toEqual({ ok: true, destination: "dev@rig-b", hostId: "vps-b" });
  });

  it("3-part form splits on the LAST @ — trailing segment becomes hostId; the session stays 2-part", () => {
    expect(resolveQueueHostDestination("dev@rig-b@vps-b")).toEqual({ ok: true, destination: "dev@rig-b", hostId: "vps-b" });
  });

  it("many-@ input strips exactly ONE trailing segment (canonical-only backstop rejects the rest daemon-side)", () => {
    expect(resolveQueueHostDestination("a@b@c@d")).toEqual({ ok: true, destination: "a@b@c", hostId: "d" });
  });

  it("human-seat refs are classified FIRST and never captured", () => {
    expect(resolveQueueHostDestination("human@kernel")).toEqual({ ok: true, destination: "human@kernel", hostId: undefined });
    expect(resolveQueueHostDestination("human-ops.1@host", "vps-b")).toEqual({ ok: true, destination: "human-ops.1@host", hostId: "vps-b" });
  });

  it("reserved trailing segment 'local' resolves to the explicit local envelope (daemon treats as the local path)", () => {
    expect(resolveQueueHostDestination("dev@rig-b@local")).toEqual({ ok: true, destination: "dev@rig-b", hostId: "local" });
  });

  it("--host + a DIFFERENT host qualifier = structured ambiguity error (never a silent precedence pick)", () => {
    const res = resolveQueueHostDestination("dev@rig-b@vps-b", "vps-c");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("host_qualifier_conflict");
  });

  it("--host + the MATCHING qualifier is fine (one host named twice)", () => {
    expect(resolveQueueHostDestination("dev@rig-b@vps-b", "vps-b")).toEqual({ ok: true, destination: "dev@rig-b", hostId: "vps-b" });
  });

  it("empty trailing host segment = structured error", () => {
    const res = resolveQueueHostDestination("dev@rig-b@");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_host_qualified_destination");
  });
});

describe("rig queue cross-host CLI wiring (C3)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  it("create --host <id>: body carries the 2-part destination + the hostId envelope", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "orch@rig-a", "--destination", "dev@rig-b",
      "--host", "vps-b", "--body", "do thing", "--json",
    ]);
    const body = calls.find((c) => c.path === "/api/queue/create")!.body as Record<string, unknown>;
    expect(body.destinationSession).toBe("dev@rig-b");
    expect(body.hostId).toBe("vps-b");
  });

  it("create with the 3-part destination form: same envelope — the 3-part string never leaves the CLI", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "orch@rig-a", "--destination", "dev@rig-b@vps-b",
      "--body", "do thing", "--json",
    ]);
    const body = calls.find((c) => c.path === "/api/queue/create")!.body as Record<string, unknown>;
    expect(body.destinationSession).toBe("dev@rig-b");
    expect(body.hostId).toBe("vps-b");
    expect(JSON.stringify(body)).not.toContain("dev@rig-b@vps-b");
  });

  it("local create posts NO hostId key at all (byte-identical local body)", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "orch@rig-a", "--destination", "dev@rig-a",
      "--body", "do thing", "--json",
    ]);
    const body = calls.find((c) => c.path === "/api/queue/create")!.body as Record<string, unknown>;
    expect("hostId" in body).toBe(false);
  });

  it("handoff --to member@rig@host: 2-part toSession + hostId envelope", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff", "qitem-src-1",
      "--from", "worker@rig-a", "--to", "dev@rig-b@vps-b", "--json",
    ]);
    const body = calls.find((c) => c.path === "/api/queue/qitem-src-1/handoff")!.body as Record<string, unknown>;
    expect(body.toSession).toBe("dev@rig-b");
    expect(body.hostId).toBe("vps-b");
  });

  it("handoff-and-complete --host <id>: same envelope", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff-and-complete", "qitem-src-1",
      "--from", "worker@rig-a", "--to", "dev@rig-b", "--host", "vps-b", "--json",
    ]);
    const body = calls.find((c) => c.path === "/api/queue/qitem-src-1/handoff-and-complete")!.body as Record<string, unknown>;
    expect(body.toSession).toBe("dev@rig-b");
    expect(body.hostId).toBe("vps-b");
  });

  it("conflicting --host + qualifier: local structured error, NOTHING posted, exit 1", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff", "qitem-src-1",
      "--from", "worker@rig-a", "--to", "dev@rig-b@vps-b", "--host", "vps-c", "--json",
    ]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });
});
