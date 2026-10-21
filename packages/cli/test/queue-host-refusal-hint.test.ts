// #1642: when a daemon refuses a host token it doesn't know, queue writes keep that refusal (one write,
// unchanged stdout and exit) and add a qualified hint: the host substitution this CLI's own registry
// suggests, which isn't proof of the same host in the registry of the daemon the command reached.
// Create alone says "No row was created", and only for refusals that provably come before any write.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
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

type Reply = { status: number; data: unknown } | Error;
const UNKNOWN_HOST = (hostId: string): Reply => ({ status: 502, data: { error: "remote_queue_write_failed", hostId, failureClass: "unknown-host", detail: `unknown host id '${hostId}'.` } });
const CREATED: Reply = { status: 201, data: { qitemId: "qitem-20261020230000-aaaa", destinationSession: "dev@rig-b", state: "pending" } };

function makeDeps(replies: Reply[]): { deps: QueueDeps; requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> } {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  return {
    requests,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (p: string) => { requests.push({ method: "GET", path: p }); return { status: 200, data: {} }; }),
        post: vi.fn(async (p: string, body: Record<string, unknown>) => {
          requests.push({ method: "POST", path: p, body });
          const reply = replies.shift() ?? { status: 500, data: { error: "unrouted" } };
          if (reply instanceof Error) throw reply;
          return reply;
        }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("queue writes refused for a host token the daemon doesn't know", () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-host-hint-"));
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: ${ALIAS}\n    transport: http\n    url: http://127.0.0.1:9\n`);
    const at = "2026-10-20T00:00:00.000Z";
    fs.writeFileSync(path.join(home, "host-bindings.json"), JSON.stringify({ version: 1, bindings: { [ALIAS]: { hostId: SELF_ID, firstObservedAt: at, lastObservedAt: at } } }));
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_SESSION_NAME", "lead@rig-a");
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
    const { deps, requests } = makeDeps(replies);
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "queue", ...argv, "--json"]);
    return requests;
  }

  const hints = () => stderr.filter((l) => l.startsWith(`Host '${SELF_ID}' resolves to '${ALIAS}' in this CLI's host registry.`));

  const CALLERS: Array<{ verb: string; argv: (to: string) => string[] }> = [
    { verb: "create", argv: (to) => ["create", "--destination", to, "--body", "b", "--summary", "s"] },
    { verb: "handoff", argv: (to) => ["handoff", "qitem-src-1", "--to", to, "--summary", "s"] },
    { verb: "handoff-and-complete", argv: (to) => ["handoff-and-complete", "qitem-src-1", "--to", to, "--summary", "s"] },
  ];

  for (const c of CALLERS) {
    it(`${c.verb}: a refused learned self-id suffix stays refused, with one write and a qualified address-form hint`, async () => {
      const requests = await run(c.argv(`dev@rig-b@${SELF_ID}`), [UNKNOWN_HOST(SELF_ID)]);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.body!.hostId).toBe(SELF_ID);
      expect(stdout).toEqual([JSON.stringify((UNKNOWN_HOST(SELF_ID) as { data: unknown }).data)]);
      expect(process.exitCode).toBe(2);
      expect(hints()).toHaveLength(1);
      const hint = hints()[0]!;
      expect(hint).toContain(`That doesn't prove '${ALIAS}' names the same host in the registry of the daemon this command reached`);
      expect(hint).toContain(`the destination 'dev@rig-b@${ALIAS}'`);
      expect(hint).not.toContain("--host");
      if (c.verb === "create") expect(hint).toMatch(/keeping --id 'qitem-[0-9]{14}-[0-9a-f]{16}'\.$/);
      else expect(hint).not.toContain("--id");
    });

    it(`${c.verb}: a refused --host self-id gets the --host substitution`, async () => {
      const requests = await run([...c.argv("dev@rig-b"), "--host", SELF_ID], [UNKNOWN_HOST(SELF_ID)]);
      expect(requests).toHaveLength(1);
      expect(hints()).toHaveLength(1);
      expect(hints()[0]).toContain(`--host '${ALIAS}'`);
      expect(hints()[0]).not.toContain("the destination");
    });

    it(`${c.verb}: a token this CLI's registry can't resolve gets no hint`, async () => {
      await run(c.argv("dev@rig-b@host-unknown"), [UNKNOWN_HOST("host-unknown")]);
      expect(stderr.some((l) => l.includes("in this CLI's host registry"))).toBe(false);
      expect(process.exitCode).toBe(2);
    });

    it(`${c.verb}: a daemon that accepts the token decides alone, with no hint`, async () => {
      const requests = await run(c.argv(`dev@rig-b@${SELF_ID}`), [CREATED]);
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(hints()).toHaveLength(0);
      expect(process.exitCode).toBeUndefined();
    });

    it(`${c.verb}: any other failure gets no hint and is never sent again`, async () => {
      const unreachable = { status: 502, data: { error: "remote_queue_write_failed", hostId: SELF_ID, failureClass: "unreachable", detail: "timed out" } };
      const requests = await run(c.argv(`dev@rig-b@${SELF_ID}`), [unreachable]);
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(hints()).toHaveLength(0);
      expect(process.exitCode).toBe(2);
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
