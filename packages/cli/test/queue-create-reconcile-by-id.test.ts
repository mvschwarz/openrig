// A create whose answer didn't arrive in time may still commit. Before reporting an unknown outcome, the CLI reads the row back once
// by the ID it sent, from the daemon that holds it. A row found there is reported as created; anything else stays
// INDETERMINATE, with the ID to reconcile by. The create is never sent again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { DaemonClient, DaemonConnectionError, DaemonResponseError, DaemonTimeoutError, remoteDaemonClient, SENDER_IDENTITY_HEADER, senderIdentityHeaders } from "../src/client.js";
import { getDaemonUrl } from "../src/daemon-lifecycle.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});
// This instance's host id, which a request to a daemon not proven local carries in its sender.
vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => "host-a" }));

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
  const clientFactory = (base: string) => ({
    baseUrl: base,
    // A client for the local daemon, proven local: its requests carry the seat's own name.
    senderIdentity: async () => ({ session: senderIdentityHeaders()[SENDER_IDENTITY_HEADER], originUnknown: false }),
    get: vi.fn(async (p: string, options?: Call["options"]) => {
      calls.push({ base, method: "get", path: p, options });
      return answer(gets[`${base}${p}`], { status: 404, data: { error: "not_found" } });
    }),
    post: vi.fn(async (p: string, _body: unknown, options?: Call["options"]) => {
      calls.push({ base, method: "post", path: p, options });
      return answer(posts.shift(), { status: 500, data: { error: "unrouted" } });
    }),
  }) as unknown as ReturnType<QueueDeps["clientFactory"]>;
  return {
    calls,
    deps: {
      deliveryVerify,
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory,
      receiptReadClientFactory: clientFactory,
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

  async function run(destination: string, posts: Reply[], gets: Record<string, Reply> = {}, extra: string[] = [], configureDeps?: (deps: QueueDeps, calls: Call[]) => void): Promise<{ calls: Call[]; error: unknown }> {
    const { deps, calls } = makeDeps(posts, gets);
    configureDeps?.(deps, calls);
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

  it.each([
    ["an explicit host", "dev@rig-b", ["--host", "vps-b"]],
    ["a host-qualified destination", "dev@rig-b@vps-b", []],
  ])("create --verify reads the remote receipt with %s and its bearer, never the local row", async (_case, destination, extra) => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n    bearer_env: XH_AUTH\n`);
    vi.stubEnv("XH_AUTH", AUTH_VALUE);
    const { calls, error } = await run(destination, [{ status: 201, data: REMOTE_ROW }], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${LOCAL}/api/queue/${ID}`]: { status: 404, data: { error: "qitem_not_found" } },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: { ...REMOTE_ROW, lastNudgeResult: "verified" } },
    }, ["--verify", ...extra]);
    expect(error).toBeNull();
    expect(posts(calls)).toEqual([expect.objectContaining({ base: LOCAL, path: "/api/queue/create" })]);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: REMOTE,
      options: { timeoutMs: 10_000, headers: { Authorization: `Bearer ${AUTH_VALUE}` } } })]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID, persisted: true,
      delivery: { receiptSource: "terminal", outcome: "verified", wakeResult: "verified" } });
    expect(stdout.join("\n") + stderr.join("\n")).not.toContain(AUTH_VALUE);
  });

  it.each([
    ["missing", { status: 404, data: { error: "qitem_not_found" } }],
    ["unreachable", new DaemonTimeoutError("remote receipt timed out")],
    ["wrong id", { status: 200, data: { ...REMOTE_ROW, qitemId: "another-id", lastNudgeResult: "verified" } }],
    ["wrong destination", { status: 200, data: { ...REMOTE_ROW, destinationSession: "other@rig-b", lastNudgeResult: "verified" } }],
    ["wrong body", { status: 200, data: { ...REMOTE_ROW, body: "different", lastNudgeResult: "verified" } }],
  ] satisfies Array<[string, Reply]>)("create --verify keeps a %s remote receipt indeterminate without resending", async (_case, receipt) => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls, error } = await run("dev@rig-b@vps-b", [{ status: 201, data: REMOTE_ROW }], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...REMOTE_ROW, lastNudgeResult: "verified" } },
      [`${REMOTE}/api/queue/${ID}`]: receipt,
    }, ["--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: REMOTE })]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ persisted: true, delivery: { outcome: "indeterminate" } });
  });

  it("create --verify accepts a remote receipt with the requested destination and body when source differs", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls, error } = await run("dev@rig-b@vps-b", [{ status: 201, data: REMOTE_ROW }], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: { ...REMOTE_ROW, sourceSession: "other@rig-a", lastNudgeResult: "verified" } },
    }, ["--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: REMOTE })]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ persisted: true, delivery: { outcome: "verified" } });
  });

  it("does not read a remote receipt when the requested host is missing from this CLI's registry", async () => {
    const { calls, error } = await run("dev@rig-b@vps-b", [{ status: 201, data: REMOTE_ROW }], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, lastNudgeResult: "verified" } },
    }, ["--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([]);
    expect(calls.filter((call) => call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ persisted: true, delivery: { outcome: "indeterminate" } });
  });

  it("does not recover a cross-host create from a matching selected-endpoint row when the host is unknown", async () => {
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, lastNudgeResult: "verified" } },
    });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ error: "remote_queue_write_failed", outcome: "indeterminate", qitemId: ID });
    expect(stderr.join("\n")).not.toContain(`committed after all: row ${ID}`);
  });

  it("reads the registered host by ID without a response target fingerprint", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW },
    });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: REMOTE })]);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} on host 'vps-b'`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID, state: "pending" });
  });

  it("does not verify an older stored body returned by a successful colliding create", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const oldRow = { ...REMOTE_ROW, body: "older body", lastNudgeResult: "verified" };
    const { calls, error } = await run("dev@rig-b@vps-b", [{ status: 200, data: { ...oldRow,
      createWarning: { code: "qitem_body_not_saved", message: "The supplied body was not saved." } } }], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: oldRow },
    }, ["--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      persisted: true,
      delivery: { outcome: "indeterminate" },
    });
    expect(stderr.join("\n")).toContain("not saved");
  });

  it("create --verify reads locally when --host is local", async () => {
    const { calls, error } = await run("dev@rig-b", [{ status: 201, data: ROW }], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, lastNudgeResult: "verified" } },
    }, ["--host", "local", "--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: LOCAL })]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ persisted: true, delivery: { outcome: "verified" } });
  });

  it("a reconciled remote create still verifies its remote receipt without another write", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: { ...REMOTE_ROW, lastNudgeResult: "verified" } },
    }, ["--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(2);
    expect(readBacks(calls).every(c => c.base === REMOTE)).toBe(true);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ persisted: true, delivery: { outcome: "verified" } });
  });

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

  it.each([
    ["connection loss before headers", new DaemonConnectionError(`Request to ${LOCAL}/api/queue/create failed`, "ECONNRESET")],
    ["timeout before headers", new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 15000ms`)],
  ])("reads a remote create by ID after %s", async (_label, failure) => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls, error } = await run("dev@rig-b@vps-b", [failure], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW },
    });
    expect(error).toBeNull();
    expect(posts(calls)).toEqual([expect.objectContaining({ base: LOCAL, path: "/api/queue/create" })]);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: REMOTE })]);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} on host 'vps-b'`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID, state: "pending" });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reads a local create by ID when --host names this daemon without a registry entry", async () => {
    const { calls, error } = await run("dev@rig-b", [new DaemonConnectionError(`Request to ${LOCAL}/api/queue/create failed`, "ECONNRESET")], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: ROW },
    }, ["--host", "host-a"]);
    expect(error).toBeNull();
    expect(fs.existsSync(path.join(home, "hosts.yaml"))).toBe(false);
    expect(posts(calls)).toEqual([expect.objectContaining({ base: LOCAL, path: "/api/queue/create" })]);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: LOCAL })]);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID, state: "pending" });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a local create with no row yet stays INDETERMINATE, says it may still commit, and isn't sent again", async () => {
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)]);
    expect(error).toBeInstanceOf(DaemonTimeoutError);
    expect((error as DaemonTimeoutError).writeOutcome).toBe("unknown");
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    const all = stderr.join("\n");
    expect(all).toContain(`No row ${ID} yet`);
    expect(all).toContain("may still commit");
    expect(all).toContain("The write outcome is INDETERMINATE");
    expect(stdout).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("a cross-host create the destination committed late reads back from that host, with its bearer, never printed", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n    bearer_env: XH_AUTH\n`);
    vi.stubEnv("XH_AUTH", AUTH_VALUE);
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN],
      { [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW }, [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } } });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: REMOTE, options: expect.objectContaining({ headers: { Authorization: `Bearer ${AUTH_VALUE}` } }) })]);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} on host 'vps-b'`);
    expect(process.exitCode ?? 0).toBe(0);
    expect([...stdout, ...stderr].join("\n")).not.toContain(AUTH_VALUE);
  });

  it("keeps a cross-host create indeterminate when its host is missing from this CLI's registry", async () => {
    const { calls } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN]);
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([]);
    const all = stderr.join("\n");
    expect(all).toContain(`The CLI could not establish the queue for requested host 'vps-b'. The write outcome is still unknown. Keep this ID for recovery.`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ error: "remote_queue_write_failed", outcome: "indeterminate", qitemId: ID });
    expect(process.exitCode).toBe(2);
  });

  it("recovers a selected-daemon create named by its host ID when the registry maps to the selected endpoint", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: host-a\n    transport: http\n    url: ${LOCAL}\n`);
    const receiptFactory = vi.fn((base: string) => {
      throw new Error(`receipt reader must reuse the selected client for ${base}`);
    });
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: ROW },
    }, ["--host", "host-a", "--tags", "mission:local"], (deps) => { deps.receiptReadClientFactory = receiptFactory; });
    expect(error).toBeNull();
    expect(receiptFactory).not.toHaveBeenCalled();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: LOCAL })]);
    expect(calls.filter((call) => call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} (read back by its ID).`);
    expect(stderr.join("\n")).not.toContain(`committed after all: row ${ID} on host 'host-a'`);
    expect(stderr.join("\n")).not.toContain("row was forwarded");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("keeps own-host read-back local via daemon self-ID even when hosts.yaml maps that host to a different URL", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), "hosts:\n  - id: host-a\n    transport: http\n    url: http://external-host-a.example:7433\n");
    const receiptFactory = vi.fn((base: string) => {
      throw new Error(`receipt reader must reuse the selected client for ${base}`);
    });
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: ROW },
    }, ["--host", "host-a"], (deps) => { deps.receiptReadClientFactory = receiptFactory; });
    expect(error).toBeNull();
    expect(receiptFactory).not.toHaveBeenCalled();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([expect.objectContaining({ base: LOCAL })]);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} (read back by its ID).`);
    expect(stderr.join("\n")).not.toContain(`committed after all: row ${ID} on host 'host-a'`);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("refuses a matching registry URL for read-back when the selected daemon reports a different non-empty host ID", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${LOCAL}\n`);
    const { calls, error } = await run("dev@rig-b", [FORWARD_UNKNOWN], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: ROW },
    }, ["--host", "vps-b"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([]);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(stderr.join("\n")).toContain("The CLI could not establish the queue for requested host 'vps-b'. The write outcome is still unknown. Keep this ID for recovery.");
    expect(stderr.join("\n")).not.toContain(`committed after all: row ${ID}`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ error: "remote_queue_write_failed", outcome: "indeterminate", qitemId: ID });
    expect(process.exitCode).toBe(2);
  });

  it("refuses a matching registry URL for --verify when the selected daemon reports a different non-empty host ID", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${LOCAL}\n`);
    const { calls, error } = await run("dev@rig-b", [{ status: 201, data: ROW }], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, lastNudgeResult: "verified" } },
    }, ["--host", "vps-b", "--verify"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([]);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ delivery: { outcome: "indeterminate" } });
  });

  it("keeps delivery unknown when a matching selected-endpoint row cannot be tied to the requested host", async () => {
    const receiptFactory = vi.fn((base: string) => {
      throw new Error(`receipt reader must reuse the selected client for ${base}`);
    });
    const { calls, error } = await run("dev@rig-b", [{ status: 201, data: ROW }], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, lastNudgeResult: "verified" } },
    }, ["--host", "host-a", "--verify"], (deps) => { deps.receiptReadClientFactory = receiptFactory; });
    expect(error).toBeNull();
    expect(receiptFactory).not.toHaveBeenCalled();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([]);
    expect(calls.filter((call) => call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ delivery: { outcome: "indeterminate" } });
  });

  it.each([
    ["stale", { observedUrl: "http://old-vps-b.example:7433" }],
    ["conflicting", { observedUrl: REMOTE, conflict: { hostId: "different-host", observedAt: "2026-11-19T00:00:00Z" } }],
  ])("does not route a requested host through a %s learned binding", async (_label, binding) => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    fs.writeFileSync(path.join(home, "host-bindings.json"), JSON.stringify({ version: 1, bindings: {
      "vps-b": { hostId: "host-b", firstObservedAt: "2026-11-01T00:00:00Z", lastObservedAt: "2026-11-07T00:00:00Z", ...binding },
    } }));
    const { calls, error } = await run("dev@rig-b", [FORWARD_UNKNOWN], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: ROW },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW },
    }, ["--host", "host-b"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ error: "remote_queue_write_failed", outcome: "indeterminate", qitemId: ID });
    expect(stderr.join("\n")).not.toContain(`committed after all: row ${ID}`);
  });

  it.each([
    ["stale", { observedUrl: "http://old-vps-b.example:7433" }],
    ["conflicting", { observedUrl: REMOTE, conflict: { hostId: "different-host", observedAt: "2026-11-19T00:00:00Z" } }],
  ])("labels a %s learned host binding as unconfirmed", async (_label, binding) => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    fs.writeFileSync(path.join(home, "host-bindings.json"), JSON.stringify({ version: 1, bindings: {
      "vps-b": { hostId: "host-b", firstObservedAt: "2026-11-01T00:00:00Z", lastObservedAt: "2026-11-07T00:00:00Z", ...binding },
    } }));
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "true");
    const { calls, error } = await run("dev@rig-b", [{ status: 201, data: ROW }], {}, ["--host", "host-b"]);
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ host: "host-b", hostUnconfirmed: true });
  });

  it("settles a compact create receipt via /healthz even when hosts.yaml maps --host to the selected URL", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: host-a\n    transport: http\n    url: ${LOCAL}\n`);
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "true");
    const localRun = await run("dev@rig-b", [{ status: 201, data: ROW }], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
    }, ["--host", "host-a"]);
    expect(localRun.error).toBeNull();
    expect(posts(localRun.calls)).toHaveLength(1);
    expect(localRun.calls.filter((call) => call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(JSON.parse(stdout.join("\n"))).not.toHaveProperty("host");

    stdout = [];
    const remoteRun = await run("dev@rig-b", [{ status: 201, data: ROW }], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "other-host" } },
    }, ["--host", "host-a"]);
    expect(remoteRun.error).toBeNull();
    expect(posts(remoteRun.calls)).toHaveLength(1);
    expect(remoteRun.calls.filter((call) => call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    const remoteJson = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
    expect(remoteJson).toMatchObject({ host: "host-a" });
    expect(remoteJson).not.toHaveProperty("hostUnconfirmed");
  });

  it("recovered compact forwarded create keeps its recovered host without a second /healthz read", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "true");
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], {
      [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } },
      [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW },
    });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(calls.filter((call) => call.base === REMOTE && call.method === "get" && call.path === "/healthz")).toHaveLength(0);
    const json = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
    expect(json).toMatchObject({ qitemId: ID, host: "vps-b" });
    expect(json).not.toHaveProperty("hostUnconfirmed");
  });

  it("reads a forwarded create once from the remote without requesting remote healthz identity", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const remoteRequests: Array<{ url: string; method?: string }> = [];
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], {}, [], (deps, recordedCalls) => {
      const ordinaryFactory = deps.clientFactory;
      deps.clientFactory = (base) => {
        const client = ordinaryFactory(base) as unknown as { get: (requestPath: string, options?: Call["options"]) => Promise<unknown> };
        if (base === REMOTE) {
          const get = client.get.bind(client);
          client.get = async (requestPath, options) => {
            recordedCalls.push({ base, method: "get", path: "/healthz", options });
            return get(requestPath, options);
          };
        }
        return client as unknown as ReturnType<QueueDeps["clientFactory"]>;
      };
      deps.receiptReadClientFactory = (base) => remoteDaemonClient((target) => new DaemonClient(target, {
        fetchImpl: async (input, init) => {
          remoteRequests.push({ url: String(input), method: init?.method });
          return new Response(JSON.stringify(REMOTE_ROW), { status: 200, headers: { "content-type": "application/json" } });
        },
      }), base, "host-a", "lead@rig-a");
    });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(remoteRequests).toEqual([{ url: `${REMOTE}/api/queue/${ID}`, method: "GET" }]);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(calls.filter((call) => call.base === REMOTE && call.method === "get" && call.path === "/healthz")).toHaveLength(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID, state: "pending" });
  });

  // The read-back checks the sent ID, destination and body. It does not need to reconstruct the source stamp.
  it.each([
    ["destination", { ...ROW, destinationSession: "other@rig-c" }],
    ["body", { ...ROW, body: "older work" }],
  ])("a row with this ID whose %s differs isn't this create: the outcome stays unknown, and the ID isn't for other work", async (_field, row) => {
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)],
      { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: row } });
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    const all = stderr.join("\n");
    expect(all).not.toContain("committed after all");
    expect(error).toBeInstanceOf(DaemonTimeoutError);
    expect((error as DaemonTimeoutError).writeOutcome).toBe("unknown");
    expect(all).toContain(`The row ID ${ID} exists, but its destination or body hash contradicts this request.`);
    expect(all).toContain("The write outcome stays unknown. Keep this ID for recovery.");
    expect(all).toContain("The write outcome is INDETERMINATE");
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("destination or body hash contradicts this request");
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps a missing readback ID unreadable instead of calling it a different ID", async () => {
    const noIdRow: Record<string, unknown> = { ...ROW };
    delete noIdRow.qitemId;
    const directResponse = { state: "pending", destinationSession: "dev@rig-b", body: "b" };
    const { calls, error } = await run("dev@rig-b", [{ status: 201, data: directResponse }], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: noIdRow },
    });
    expect(error).toMatchObject({
      name: "DaemonResponseError",
      status: 201,
      message: expect.stringContaining(`--id '${ID}'`),
    });
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("did not include a valid ID");
    expect(stderr.join("\n")).not.toContain("returned a different ID");
  });

  it("treats an empty direct-response ID as unreadable instead of calling it a different ID", async () => {
    const noIdRow: Record<string, unknown> = { ...ROW };
    delete noIdRow.qitemId;
    const directResponse = { qitemId: "", state: "pending", destinationSession: "dev@rig-b", body: "b" };
    const { calls, error } = await run("dev@rig-b", [{ status: 201, data: directResponse }], {
      [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: noIdRow },
    });
    expect(error).toMatchObject({
      name: "DaemonResponseError",
      status: 201,
      message: expect.stringContaining(`--id '${ID}'`),
    });
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("did not include a valid ID");
    expect(stderr.join("\n")).not.toMatch(/differ(?:ent|ed)/);
  });

  it("accepts a row with matching destination and body when its source differs", async () => {
    const { calls, error } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)],
      { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, sourceSession: "someone@rig-z" } } });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ qitemId: ID, state: "pending" });
    expect(process.exitCode ?? 0).toBe(0);
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

  // The source a row must carry is the one the daemon stores for this create: the sender this client sent, as that daemon
  // canonicalizes it, and on a forwarded create stamped with the forwarding daemon's own host id.
  it("a forwarded create accepts matching destination and body when the stored source differs", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN],
      { [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: { ...ROW, sourceSession: "lead@rig-a@host-c" } } });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} on host 'vps-b'`);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a forwarded create readback does not require the forwarding daemon's host id", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], { [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW } });
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID} on host 'vps-b'`);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  // The daemon forwards only to another host: a --host naming its own id is a local create, stored without a host suffix.
  it.each([
    ["bare session", "lead@rig-a"],
    ["stamped session", "lead@rig-a@host-a"],
  ])("with a registered host URL, reads back by ID regardless of the %s source", async (_case, stored) => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: host-a\n    transport: http\n    url: ${LOCAL}\n`);
    const { calls } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)],
      { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, sourceSession: stored } } },
      ["--host", "host-a"]);
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    expect(calls.filter((call) => call.base === LOCAL && call.method === "get" && call.path === "/healthz")).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  describe("with the real client's sender", () => {
    type Request = { method: string; path: string; sender: string | null };
    async function runReal(reply: (method: string, url: URL) => Response): Promise<{ requests: Request[]; error: unknown }> {
      const requests: Request[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, path: url.pathname, sender: new Headers(init?.headers).get(SENDER_IDENTITY_HEADER) });
        return reply(method, url);
      };
      const deps = {
        lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
        clientFactory: (base: string) => new DaemonClient(base, { fetchImpl, ownerProbe: async () => ({ state: "unverified" }) as never }),
      } as unknown as QueueDeps;
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      let error: unknown = null;
      try {
        await program.parseAsync(["node", "rig", "queue", "create", "--destination", "dev@rig-b", "--body", "b", "--summary", "s", "--id", ID, "--json"]);
      } catch (err) { error = err; }
      return { requests, error };
    }
    const lostCreate = (stored: string) => (method: string, _url: URL): Response => {
      if (method === "POST") throw new TypeError("connection lost");
      return Response.json({ ...ROW, sourceSession: stored });
    };

    describe("sent straight to another host's daemon (OPENRIG_URL)", () => {
      beforeEach(() => {
        vi.stubEnv("OPENRIG_URL", REMOTE);
        vi.mocked(getDaemonUrl).mockReturnValue(REMOTE);
      });
      afterEach(() => { vi.mocked(getDaemonUrl).mockReturnValue(LOCAL); });

      it("reads back as created when that daemon stored the sender with this host's id", async () => {
        const { requests, error } = await runReal(lostCreate("lead@rig-a@host-a"));
        expect(requests.filter((r) => r.method === "POST")).toEqual([expect.objectContaining({ sender: "lead@rig-a@host-a" })]);
        const createIndex = requests.findIndex((r) => r.method === "POST");
        const healthzIndices = requests.flatMap((r, index) => r.path === "/healthz" ? [index] : []);
        expect(healthzIndices).toHaveLength(1);
        expect(healthzIndices[0]).toBeLessThan(createIndex);
        expect(requests.slice(createIndex + 1).filter((r) => r.path === "/healthz")).toHaveLength(0);
        expect(error).toBeNull();
        expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
      });

      it("accepts matching destination and body when the stored source names another origin host", async () => {
        const { requests, error } = await runReal(lostCreate("lead@rig-a@host-c"));
        expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
        const createIndex = requests.findIndex((r) => r.method === "POST");
        const healthzIndices = requests.flatMap((r, index) => r.path === "/healthz" ? [index] : []);
        expect(healthzIndices).toHaveLength(1);
        expect(healthzIndices[0]).toBeLessThan(createIndex);
        expect(requests.slice(createIndex + 1).filter((r) => r.path === "/healthz")).toHaveLength(0);
        expect(error).toBeNull();
        expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
      });
    });

    it.each([
      ["names its own host", "lead@rig-a@host-a"],
      ["has stray spaces", " lead@rig-a "],
    ])("a local create from a seat whose session name %s reads back as created: the daemon stores the bare seat", async (_case, session) => {
      vi.stubEnv("OPENRIG_SESSION_NAME", session);
      const { requests, error } = await runReal(lostCreate("lead@rig-a"));
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(error).toBeNull();
      expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    });
  });
});
