// A cross-host queue write waits for the selected daemon's own answer (its forward gives the remote 10 s), so a
// slow remote doesn't become a local 5 s timeout; and a timeout reads as an unknown outcome, never a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { DaemonTimeoutError } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

type Reply = { status: number; data: unknown } | Error;
type Request = { path: string; options?: { timeoutMs?: number } };
const CREATED: Reply = { status: 201, data: { qitemId: "qitem-20261024070000-aaaa", destinationSession: "dev@rig-b", state: "pending" } };
const HANDED_OFF: Reply = { status: 200, data: { closed: { qitemId: "qitem-src-1", state: "handed-off" }, created: { qitemId: "qitem-20261024070000-bbbb", state: "pending" } } };

function makeDeps(replies: Reply[]): { deps: QueueDeps; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async () => ({ status: 200, data: {} })),
        post: vi.fn(async (p: string, _body: unknown, options?: { timeoutMs?: number }) => {
          requests.push({ path: p, options });
          const reply = replies.shift() ?? { status: 500, data: { error: "unrouted" } };
          if (reply instanceof Error) throw reply;
          return reply;
        }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("cross-host queue writes wait for the daemon's answer", () => {
  let home: string;
  let stderr: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-xhost-wait-"));
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_SESSION_NAME", "lead@rig-a");
    stderr = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
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

  async function run(argv: string[], replies: Reply[]): Promise<Request[]> {
    const { deps, requests } = makeDeps(replies);
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "queue", ...argv, "--json"]);
    return requests;
  }

  const CALLERS: Array<{ verb: string; argv: (to: string) => string[]; reply: Reply }> = [
    { verb: "create", argv: (to) => ["create", "--destination", to, "--body", "b", "--summary", "s"], reply: CREATED },
    { verb: "handoff", argv: (to) => ["handoff", "qitem-src-1", "--to", to, "--summary", "s"], reply: HANDED_OFF },
    { verb: "handoff-and-complete", argv: (to) => ["handoff-and-complete", "qitem-src-1", "--to", to, "--summary", "s"], reply: HANDED_OFF },
  ];

  for (const c of CALLERS) {
    it(`${c.verb} to another host waits longer than the daemon's 10 s forward deadline`, async () => {
      const requests = await run(c.argv("dev@rig-b@vps-b"), [c.reply]);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.options?.timeoutMs).toBe(15_000);
    });

    it(`${c.verb} on this daemon keeps the client's default wait`, async () => {
      const requests = await run(c.argv("dev@rig-b"), [c.reply]);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.options).toBeUndefined();
    });
  }

  it("a create that gets no answer in time reads as unknown, never as a failure, with the ID to reconcile by", async () => {
    await expect(run(["create", "--destination", "dev@rig-b@vps-b", "--body", "b", "--summary", "s"],
      [new DaemonTimeoutError("Request to http://localhost:7433/api/queue/create timed out after 15000ms")])).rejects.toThrow();
    const all = stderr.join("\n");
    expect(all).toContain("queue request got no answer in time (routing to host 'vps-b')");
    expect(all).not.toContain("queue transport failure");
    expect(all).toContain("The write outcome is INDETERMINATE");
    expect(all).toMatch(/repeat the same create with --id 'qitem-\d{14}-[0-9a-f]{16}'/);
  });
});
