// #1642: queue writes name a host the way `rig send` resolves it, without changing what a daemon decides.
// The token goes as written first. Only a daemon's unknown-host refusal (made before it contacts any host
// or writes anything) sends the same write once more under the local registry entry's id. Create alone
// says "No row was created", and only for refusals that provably come before any write.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { resolveQueueHostDestination } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { DaemonConnectionError } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const ALIAS = "remote-vm";
const SELF_ID = "host-5f2e9c1a";
const entries: Record<string, string> = { [ALIAS]: ALIAS, [SELF_ID]: ALIAS, "other-vm": "other-vm" };
const entryOf = vi.fn((id: string) => entries[id]);

describe("resolveQueueHostDestination with a registry lookup", () => {
  beforeEach(() => entryOf.mockClear());

  it("carries the registry id of the entry a learned self-id names", () => {
    expect(resolveQueueHostDestination(`dev@rig-b@${SELF_ID}`, undefined, entryOf))
      .toEqual({ ok: true, destination: "dev@rig-b", hostId: SELF_ID, entryId: ALIAS });
    expect(resolveQueueHostDestination("dev@rig-b", SELF_ID, entryOf))
      .toEqual({ ok: true, destination: "dev@rig-b", hostId: SELF_ID, entryId: ALIAS });
  });

  it("two spellings of one entry are not a conflict", () => {
    expect(resolveQueueHostDestination(`dev@rig-b@${SELF_ID}`, ALIAS, entryOf))
      .toEqual({ ok: true, destination: "dev@rig-b", hostId: SELF_ID, entryId: ALIAS });
  });

  it("a different entry, or an explicit host that resolves to nothing, still conflicts", () => {
    for (const explicit of ["other-vm", "nowhere"]) {
      const res = resolveQueueHostDestination(`dev@rig-b@${SELF_ID}`, explicit, entryOf);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("host_qualifier_conflict");
    }
  });

  it("a token the registry can't resolve is sent as written", () => {
    expect(resolveQueueHostDestination("dev@rig-b@host-unknown", undefined, entryOf))
      .toEqual({ ok: true, destination: "dev@rig-b", hostId: "host-unknown", entryId: undefined });
  });

  it("local, 'local' and human-seat destinations never consult the registry", () => {
    expect(resolveQueueHostDestination("dev@rig-a", undefined, entryOf)).toEqual({ ok: true, destination: "dev@rig-a", hostId: undefined });
    expect(resolveQueueHostDestination("dev@rig-a@local", undefined, entryOf)).toEqual({ ok: true, destination: "dev@rig-a", hostId: "local" });
    expect(resolveQueueHostDestination("human-ops.1@host", undefined, entryOf)).toEqual({ ok: true, destination: "human-ops.1@host", hostId: undefined });
    expect(entryOf).not.toHaveBeenCalled();
  });
});

type Reply = { status: number; data: unknown } | Error;
const UNKNOWN_HOST = (hostId: string): Reply => ({ status: 502, data: { error: "remote_queue_write_failed", hostId, failureClass: "unknown-host", detail: `unknown host id '${hostId}'.` } });
const CREATED: Reply = { status: 201, data: { qitemId: "qitem-20261020230000-aaaa", destinationSession: "dev@rig-b", state: "pending" } };

function makeDeps(replies: Reply[]): { deps: QueueDeps; posts: Array<{ path: string; body: Record<string, unknown> }> } {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  return {
    posts,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async () => ({ status: 200, data: {} })),
        post: vi.fn(async (p: string, body: Record<string, unknown>) => {
          posts.push({ path: p, body });
          const reply = replies.shift() ?? { status: 500, data: { error: "unrouted" } };
          if (reply instanceof Error) throw reply;
          return reply;
        }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("queue writes against a daemon that doesn't know the token", () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-host-retry-"));
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: ${ALIAS}\n    transport: http\n    url: http://127.0.0.1:9\n`);
    const at = "2026-10-20T00:00:00.000Z";
    fs.writeFileSync(path.join(home, "host-bindings.json"), JSON.stringify({ version: 1, bindings: { [ALIAS]: { hostId: SELF_ID, firstObservedAt: at, lastObservedAt: at } } }));
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig-a");
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(a.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function run(argv: string[], replies: Reply[]) {
    const { deps, posts } = makeDeps(replies);
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "queue", ...argv, "--json"]);
    return posts;
  }

  const CALLERS: Array<{ verb: string; argv: (to: string) => string[]; route: string }> = [
    { verb: "create", argv: (to) => ["create", "--destination", to, "--body", "b", "--summary", "s"], route: "/api/queue/create" },
    { verb: "handoff", argv: (to) => ["handoff", "qitem-src-1", "--to", to, "--summary", "s"], route: "/api/queue/qitem-src-1/handoff" },
    { verb: "handoff-and-complete", argv: (to) => ["handoff-and-complete", "qitem-src-1", "--to", to, "--summary", "s"], route: "/api/queue/qitem-src-1/handoff-and-complete" },
  ];

  for (const c of CALLERS) {
    it(`${c.verb}: an unknown-host refusal of a learned self-id sends the same write once more under the registry id`, async () => {
      const posts = await run(c.argv(`dev@rig-b@${SELF_ID}`), [UNKNOWN_HOST(SELF_ID), CREATED]);
      expect(posts.map((p) => [p.path, p.body.hostId])).toEqual([[c.route, SELF_ID], [c.route, ALIAS]]);
      const { hostId: _first, ...firstRest } = posts[0]!.body;
      const { hostId: _second, ...secondRest } = posts[1]!.body;
      expect(secondRest).toEqual(firstRest);
      expect(stderr.join("\n")).toContain(`The daemon doesn't know host '${SELF_ID}'. Sending the same write as '${ALIAS}'`);
      expect(stdout).toEqual([JSON.stringify((CREATED as { data: unknown }).data)]);
      expect(process.exitCode).toBeUndefined();
    });

    it(`${c.verb}: a daemon that accepts the token as written decides alone (one write)`, async () => {
      const posts = await run(c.argv(`dev@rig-b@${SELF_ID}`), [CREATED]);
      expect(posts.map((p) => p.body.hostId)).toEqual([SELF_ID]);
    });

    it(`${c.verb}: any other failure is never sent again`, async () => {
      const unreachable = { status: 502, data: { error: "remote_queue_write_failed", hostId: SELF_ID, failureClass: "unreachable", detail: "timed out" } };
      const posts = await run(c.argv(`dev@rig-b@${SELF_ID}`), [unreachable]);
      expect(posts).toHaveLength(1);
      expect(process.exitCode).toBe(2);
    });

    it(`${c.verb}: a token the local registry can't resolve is refused by the daemon alone`, async () => {
      const posts = await run(c.argv("dev@rig-b@host-unknown"), [UNKNOWN_HOST("host-unknown")]);
      expect(posts.map((p) => p.body.hostId)).toEqual(["host-unknown"]);
      expect(process.exitCode).toBe(2);
    });

    it(`${c.verb}: --host with the registry alias beside the self-id suffix is one host`, async () => {
      const posts = await run([...c.argv(`dev@rig-b@${SELF_ID}`), "--host", ALIAS], [CREATED]);
      expect(posts).toHaveLength(1);
      expect(process.exitCode).toBeUndefined();
    });
  }

  describe("create: 'No row was created' only for refusals that come before any write", () => {
    const PROVEN: Array<[string, Reply]> = [
      ["unknown host", UNKNOWN_HOST("host-unknown")],
      ["SSH-declared host", { status: 502, data: { error: "remote_queue_write_failed", hostId: "ssh-1", failureClass: "unsupported-transport", detail: "ssh" } }],
      ["unreadable registry", { status: 502, data: { error: "remote_queue_write_failed", hostId: "vps-b", failureClass: "registry", detail: "not found" } }],
      ["unknown rig", { status: 400, data: { error: "unknown_destination_rig", message: "no rig 'portfolio'" } }],
    ];
    for (const [label, reply] of PROVEN) {
      it(`says it for ${label}, with stdout and exit unchanged`, async () => {
        const to = label === "unknown rig" ? "ops@portfolio" : "dev@rig-b@host-unknown";
        await run(["create", "--destination", to, "--body", "b", "--summary", "s"], [reply]);
        const r = reply as { status: number; data: unknown };
        expect(stdout).toEqual([JSON.stringify(r.data)]);
        expect(process.exitCode).toBe(r.status >= 500 ? 2 : 1);
        expect(stderr.join("\n")).toContain("Queue create request ID:");
        expect(stderr.filter((l) => l.startsWith("No row was created: "))).toHaveLength(1);
      });
    }

    const UNPROVEN: Array<[string, Reply]> = [
      ["a timeout", { status: 502, data: { error: "remote_queue_write_failed", hostId: "vps-b", failureClass: "unreachable", detail: "remote queue write timed out after 15000ms" } }],
      ["an ambiguous transport failure", { status: 502, data: { error: "remote_queue_write_failed", hostId: "vps-b", failureClass: "unreachable", outcome: "indeterminate", detail: "socket hang up" } }],
      ["a remote's refusal", { status: 502, data: { error: "remote_queue_write_failed", hostId: "vps-b", failureClass: "remote-error", remoteStatus: 400, detail: "HTTP 400" } }],
      ["an auth failure", { status: 502, data: { error: "remote_queue_write_failed", hostId: "vps-b", failureClass: "auth-failed", detail: "401" } }],
      ["an internal error", { status: 500, data: { error: "internal_error", message: "boom" } }],
    ];
    for (const [label, reply] of UNPROVEN) {
      it(`never says it after ${label}`, async () => {
        await run(["create", "--destination", "dev@rig-b@vps-b", "--body", "b", "--summary", "s"], [reply]);
        expect(stderr.some((l) => l.includes("No row was created"))).toBe(false);
        expect(process.exitCode).toBe((reply as { status: number }).status >= 500 ? 2 : 1);
      });
    }

    it("never says it when the connection drops (the write may have committed)", async () => {
      await expect(run(["create", "--destination", "dev@rig-b@vps-b", "--body", "b", "--summary", "s"], [new DaemonConnectionError("socket hang up")]))
        .rejects.toThrow();
      expect(stderr.some((l) => l.includes("No row was created"))).toBe(false);
    });

    it("handoff never says it, even for an unknown-host refusal", async () => {
      await run(["handoff", "qitem-src-1", "--to", "dev@rig-b@host-unknown", "--summary", "s"], [UNKNOWN_HOST("host-unknown")]);
      expect(stderr.some((l) => l.includes("No row was created"))).toBe(false);
      expect(process.exitCode).toBe(2);
    });
  });
});
