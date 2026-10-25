// A create whose answer didn't arrive in time may still commit. Before reporting an unknown outcome, the CLI reads the row back once
// by the ID it sent, from the daemon that holds it. A row found there is reported as created; anything else stays
// INDETERMINATE, with the ID to reconcile by. The create is never sent again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { DaemonResponseError, DaemonTimeoutError } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const LOCAL = "http://localhost:7433";
const REMOTE = "http://vps-b.example:7433";
const ID = "qitem-20261025050000-0123456789abcdef";
const AUTH_VALUE = "fixture-only-value";
// What the daemon stores for this create: the destination and body sent, and the sender's session as its source (stamped
// with the forwarding daemon's host id on a cross-host row).
const ROW = { qitemId: ID, destinationSession: "dev@rig-b", sourceSession: "lead@rig-a", body: "b", state: "pending" };
const REMOTE_ROW = { ...ROW, sourceSession: "lead@rig-a@host-a" };
const FORWARD_UNKNOWN = { status: 502, data: { error: "remote_queue_write_failed", failureClass: "unreachable", outcome: "indeterminate" } };

type Reply = { status: number; data: unknown } | Error;
type Call = { base: string; method: "get" | "post"; path: string; options?: { timeoutMs?: number; headers?: Record<string, string> } };

function makeDeps(posts: Reply[], gets: Record<string, Reply>): { deps: QueueDeps; calls: Call[] } {
  // --verify reads the row once and reports what it holds, without waiting.
  const deliveryVerify = { timeoutMs: 0, intervalMs: 0, sleep: async () => {} };
  const calls: Call[] = [];
  const answer = (reply: Reply | undefined, fallback: Reply) => {
    const r = reply ?? fallback;
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    calls,
    deps: {
      deliveryVerify,
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: (base: string) => ({
        baseUrl: base,
        get: vi.fn(async (p: string, options?: Call["options"]) => {
          calls.push({ base, method: "get", path: p, options });
          return answer(gets[`${base}${p}`], { status: 404, data: { error: "not_found" } });
        }),
        post: vi.fn(async (p: string, _body: unknown, options?: Call["options"]) => {
          calls.push({ base, method: "post", path: p, options });
          return answer(posts.shift(), { status: 500, data: { error: "unrouted" } });
        }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("a queue create that got no answer is read back once by its ID", () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-reconcile-"));
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_SESSION_NAME", "lead@rig-a");
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(a.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function run(destination: string, posts: Reply[], gets: Record<string, Reply> = {}, extra: string[] = []): Promise<{ calls: Call[]; error: unknown }> {
    const { deps, calls } = makeDeps(posts, gets);
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    let error: unknown = null;
    try {
      await program.parseAsync(["node", "rig", "queue", "create", "--destination", destination, "--body", "b", "--summary", "s", "--id", ID, "--json", ...extra]);
    } catch (err) { error = err; }
    return { calls, error };
  }

  const posts = (calls: Call[]) => calls.filter((c) => c.method === "post");
  const readBacks = (calls: Call[]) => calls.filter((c) => c.method === "get" && c.path === `/api/queue/${ID}`);

  it("a local create that committed after the CLI stopped waiting reads back as created, and isn't sent again", async () => {
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)],
      { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: ROW } });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: LOCAL, options: expect.objectContaining({ timeoutMs: expect.any(Number) }) })]);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a local create with no row yet stays INDETERMINATE, says it may still commit, and isn't sent again", async () => {
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)]);
    expect(error).not.toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    const all = stderr.join("\n");
    expect(all).toContain(`No row ${ID} yet`);
    expect(all).toContain("may still commit");
    expect(all).toContain("The write outcome is INDETERMINATE");
  });

  it("a cross-host create the destination committed late reads back from that host, with its bearer, never printed", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n    bearer_env: XH_AUTH\n`);
    vi.stubEnv("XH_AUTH", AUTH_VALUE);
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], { [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW } });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: REMOTE, options: expect.objectContaining({ headers: { Authorization: `Bearer ${AUTH_VALUE}` } }) })]);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} on host 'vps-b'`);
    expect(process.exitCode ?? 0).toBe(0);
    expect([...stdout, ...stderr].join("\n")).not.toContain(AUTH_VALUE);
  });

  it("a cross-host create whose host this CLI can't read stays INDETERMINATE and says why", async () => {
    const { calls } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN]);
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(0);
    const all = stderr.join("\n");
    expect(all).toContain("couldn't read the row back from host 'vps-b'");
    expect(all).toContain("The write outcome is INDETERMINATE");
    expect(process.exitCode).toBe(2);
  });

  // The daemon returns the stored row for a same-ID create only when its destination and source match, and says when the body
  // wasn't saved. The read-back holds a row to the same test: a row with this ID that isn't this create leaves it unknown.
  it.each([
    ["destination", { ...ROW, destinationSession: "other@rig-c", sourceSession: "other@rig-c", body: "older work" }],
    ["source", { ...ROW, sourceSession: "someone@rig-z" }],
    ["body", { ...ROW, body: "older work" }],
  ])("a row with this ID whose %s differs isn't this create: the outcome stays unknown, and the ID isn't for other work", async (field, row) => {
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)],
      { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: row } });
    expect(error).not.toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    const all = stderr.join("\n");
    expect(all).not.toContain("committed after all");
    expect(all).toContain(`Row ${ID} exists but isn't this create (its ${field} differs)`);
    expect(all).toContain("Don't reuse this ID for other work");
    expect(all).toContain("The write outcome is INDETERMINATE");
  });

  it("a create read back after it timed out keeps --verify: its delivery is reported as on any create", async () => {
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)],
      { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, lastNudgeResult: "retained:typing_guard" } } }, ["--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID, persisted: true, delivery: expect.any(Object) });
  });

  it("a create whose response body was lost after its headers is read back too", async () => {
    const { calls, error } = await run("dev@rig-b", [new DaemonResponseError(201, "")], { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: ROW } });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
