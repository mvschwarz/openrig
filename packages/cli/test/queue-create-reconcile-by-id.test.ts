// A create whose answer didn't arrive in time may still commit. Before reporting an unknown outcome, the CLI reads the row back once
// by the ID it sent, from the daemon that holds it. A row found there is reported as created; anything else stays
// INDETERMINATE, with the ID to reconcile by. The create is never sent again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { DaemonClient, DaemonResponseError, DaemonTimeoutError, SENDER_IDENTITY_HEADER, senderIdentityHeaders } from "../src/client.js";
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
  return {
    calls,
    deps: {
      deliveryVerify,
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: (base: string) => ({
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
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN],
      { [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW }, [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } } });
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

  // The source a row must carry is the one the daemon stores for this create: the sender this client sent, as that daemon
  // canonicalizes it, and on a forwarded create stamped with the forwarding daemon's own host id.
  it("a forwarded create whose stored source names another origin host isn't this create", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls, error } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN],
      { [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: { ...ROW, sourceSession: "lead@rig-a@host-c" } }, [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } } });
    expect(error).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    const all = stderr.join("\n");
    expect(all).not.toContain("committed after all");
    expect(all).toContain(`Row ${ID} on host 'vps-b' exists but isn't this create (its source differs)`);
    expect(process.exitCode).toBe(2);
  });

  it("a forwarded create whose forwarding daemon's host id can't be read stays unknown", async () => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: vps-b\n    transport: http\n    url: ${REMOTE}\n`);
    const { calls } = await run("dev@rig-b@vps-b", [FORWARD_UNKNOWN], { [`${REMOTE}/api/queue/${ID}`]: { status: 200, data: REMOTE_ROW } });
    expect(posts(calls)).toHaveLength(1);
    const all = stderr.join("\n");
    expect(all).not.toContain("committed after all");
    expect(all).toContain("couldn't read this daemon's host id");
    expect(process.exitCode).toBe(2);
  });

  // The daemon forwards only to another host: a --host naming its own id is a local create, stored without a host suffix.
  it.each([
    ["the bare seat, a local create's source, reads back as created", "lead@rig-a", true],
    ["the source a forward would stamp isn't this create", "lead@rig-a@host-a", false],
  ])("with --host naming the daemon's own id, %s", async (_case, stored, created) => {
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: host-a\n    transport: http\n    url: ${LOCAL}\n`);
    const { calls } = await run("dev@rig-b", [new DaemonTimeoutError(`Request to ${LOCAL}/api/queue/create timed out after 5000ms`)],
      { [`${LOCAL}/api/queue/${ID}`]: { status: 200, data: { ...ROW, sourceSession: stored } }, [`${LOCAL}/healthz`]: { status: 200, data: { selfHostId: "host-a" } } },
      ["--host", "host-a"]);
    expect(posts(calls)).toHaveLength(1);
    expect(readBacks(calls)).toHaveLength(1);
    const all = stderr.join("\n");
    if (created) {
      expect(all).toContain(`committed after all: row ${ID}`);
      expect(process.exitCode ?? 0).toBe(0);
    } else {
      expect(all).not.toContain("committed after all");
      expect(all).toContain("isn't this create (its source differs)");
    }
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
    const lostCreate = (selfHostId: string, stored: string) => (method: string, url: URL): Response => {
      if (url.pathname === "/healthz") return Response.json({ selfHostId });
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
        const { requests, error } = await runReal(lostCreate("host-b", "lead@rig-a@host-a"));
        expect(requests.filter((r) => r.method === "POST")).toEqual([expect.objectContaining({ sender: "lead@rig-a@host-a" })]);
        expect(error).toBeNull();
        expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
      });

      it("isn't this create when the stored source names another origin host", async () => {
        const { requests, error } = await runReal(lostCreate("host-b", "lead@rig-a@host-c"));
        expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
        expect(error).not.toBeNull();
        expect(stderr.join("\n")).toContain(`Row ${ID} exists but isn't this create (its source differs)`);
      });
    });

    it.each([
      ["names its own host", "lead@rig-a@host-a"],
      ["has stray spaces", " lead@rig-a "],
    ])("a local create from a seat whose session name %s reads back as created: the daemon stores the bare seat", async (_case, session) => {
      vi.stubEnv("OPENRIG_SESSION_NAME", session);
      const { requests, error } = await runReal(lostCreate("host-a", "lead@rig-a"));
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(error).toBeNull();
      expect(stderr.join("\n")).toContain(`committed after all: row ${ID}`);
    });
  });
});
