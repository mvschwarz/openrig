// A cross-host queue write waits for the selected daemon's own answer (its forward gives the remote 10 s), so a
// slow remote doesn't become a local 5 s timeout; and a timeout reads as an unknown outcome, never a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";
import { runProgram } from "../src/cli-error.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

type Reply = { status: number; data: unknown } | Error;
type RequestOptions = { timeoutMs?: number; headers?: Record<string, string> };
type Request = { path: string; options?: RequestOptions };
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
        post: vi.fn(async (p: string, body: unknown, options?: RequestOptions) => {
          requests.push({ path: p, options });
          const reply = replies.shift() ?? { status: 500, data: { error: "unrouted" } };
          if (reply instanceof Error) throw reply;
          if (p === "/api/queue/create" && reply.status === 201 && reply.data && typeof reply.data === "object"
            && body && typeof body === "object" && typeof (body as { qitemId?: unknown }).qitemId === "string") {
            return { ...reply, data: { ...(reply.data as Record<string, unknown>), qitemId: (body as { qitemId: string }).qitemId } };
          }
          return reply;
        }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("cross-host queue writes wait for the daemon's answer", () => {
  let home: string;
  let stderr: string[];
  let stdout: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-xhost-wait-"));
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_SESSION_NAME", "lead@rig-a");
    stderr = [];
    stdout = [];
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
      const options = requests[0]!.options;
      expect(options?.timeoutMs).toBe(15_000);
      if (c.verb === "create") {
        expect(options).toEqual({ timeoutMs: 15_000 });
      } else {
        expect(options).toEqual({
          timeoutMs: 15_000,
          headers: { "X-OpenRig-CLI-Handoff-Scope-Advisory": "1" },
        });
      }
    });

    it(`${c.verb} on this daemon keeps the client's default wait`, async () => {
      const requests = await run(c.argv("dev@rig-b"), [c.reply]);
      expect(requests).toHaveLength(1);
      const options = requests[0]!.options;
      expect(options?.timeoutMs).toBeUndefined();
      if (c.verb === "create") {
        expect(options).toBeUndefined();
      } else {
        expect(options).toEqual({
          headers: { "X-OpenRig-CLI-Handoff-Scope-Advisory": "1" },
        });
      }
    });
  }

  const oldDaemonHandoffCases = CALLERS.filter(c => c.verb !== "create").flatMap(c => [
    { verb: c.verb, label: "without advisories", reply: c.reply },
    { verb: c.verb, label: "with destination-only advice", reply: {
      status: 200,
      data: { ...(c.reply as { status: number; data: Record<string, unknown> }).data,
        advisories: [{ code: "unmatched_destination_seat", message: "destination advice is not a scope-check acknowledgement" }] },
    } },
  ]);

  it.each(oldDaemonHandoffCases)("$verb reports a missing scope-check acknowledgement for an old-daemon response $label", async row => {
    const requests = await run([row.verb, "qitem-src-1", "--to", "dev@rig-b", "--summary", "s"], [row.reply]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.options).toEqual({ headers: { "X-OpenRig-CLI-Handoff-Scope-Advisory": "1" } });
    expect(stderr.filter(line => /this daemon didn't report a scope check/i.test(line))).toEqual([
      "Warning: this daemon didn't report a scope check; it may be older than this CLI",
    ]);
    expect(stderr.join("\n")).not.toContain("scope_check_unavailable");
    const expected = (row.reply as { data: Record<string, unknown> }).data;
    expect(stdout).toEqual([JSON.stringify(expected)]);
    expect(JSON.parse(stdout[0]!)).not.toHaveProperty("handoffScopeCheckAcknowledged");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a create that gets no answer in time reads as unknown, never as a failure, with the ID to reconcile by", async () => {
    let thrown: unknown;
    await run(["create", "--destination", "dev@rig-b@vps-b", "--body", "b", "--summary", "s"],
      [new DaemonTimeoutError("Request to http://localhost:7433/api/queue/create timed out after 15000ms")]).catch((e: unknown) => { thrown = e; });
    const all = stderr.join("\n");
    expect(all).toContain("queue request got no answer in time (routing to host 'vps-b')");
    expect(all).not.toContain("queue transport failure");
    expect(all).toContain("The write outcome is INDETERMINATE");
    // The final timeout error carries the same-ID instruction itself, not only the request line printed before the write.
    const id = /Queue create request ID: (qitem-\d{14}-[0-9a-f]{16})/.exec(all)?.[1];
    expect(id).toBeDefined();
    expect(thrown).toBeInstanceOf(DaemonTimeoutError);
    expect((thrown as Error).message).toContain(`repeat the same create with --id '${id}' and unchanged source, destination, body and options`);
  });

  // A handoff's lost answer leaves the source row, on the daemon the command used, as the thing to read: its successor is
  // named there once recorded. The error never names a successor id, says the handoff failed, or asks to repeat it.
  for (const verb of ["handoff", "handoff-and-complete"] as const) {
    for (const [where, to, successor] of [
      ["to another host", "dev@rig-b@vps-b", "Read its recorded outcome: a handed-off row names its successor on host 'vps-b', or says why it can't."],
      ["on this daemon", "dev@rig-b", "Read its recorded outcome: a handed-off row names its successor, or says why it can't."],
    ] as const) {
      it(`a ${verb} ${where} that gets no answer in time names the source row to read before any retry`, async () => {
        let thrown: unknown;
        await run([verb, "qitem-src-1", "--to", to, "--summary", "s"],
          [new DaemonTimeoutError(`Request to http://localhost:7433/api/queue/qitem-src-1/${verb} timed out after 15000ms`)])
          .catch((e: unknown) => { thrown = e; });
        expect(thrown).toBeInstanceOf(DaemonTimeoutError);
        const message = (thrown as Error).message;
        expect(message).toContain("Before any retry, read source row qitem-src-1 at the same endpoint and OPENRIG_HOME: rig queue show 'qitem-src-1' --full --json.");
        expect(message).toContain(successor);
        expect(message).toContain("doesn't show the handoff failed");
        expect(message).not.toMatch(/--id|repeat the/);
      });
    }
  }

  // Rendered as a person sees it, through the shared program renderer: a lost connection or an unreadable response after
  // a handoff was sent is an unknown outcome, never "not delivered", and keeps the source row to read.
  async function runRendered(argv: string[], replies: Reply[], json: boolean): Promise<{ text: string; code: number }> {
    const { deps } = makeDeps(replies);
    const lines: string[] = [];
    const code = await runProgram(createProgram({ queueDeps: deps }), ["node", "rig", "queue", ...argv, ...(json ? ["--json"] : [])],
      { out: (l) => lines.push(l), err: (l) => lines.push(l), exit: () => {} });
    return { text: [...stderr, ...lines].join("\n"), code };
  }

  for (const verb of ["handoff", "handoff-and-complete"] as const) {
    for (const [kind, error] of [
      ["a lost connection", () => new DaemonConnectionError("Cannot connect to the daemon at http://localhost:7433: fetch failed", "ECONNRESET")],
      ["an unreadable response", () => new DaemonResponseError(200, "")],
    ] as const) {
      for (const json of [false, true]) {
        it(`a ${verb} that meets ${kind} reads as an unknown outcome, never undelivered (${json ? "--json" : "human"})`, async () => {
          const { text, code } = await runRendered([verb, "qitem-src-1", "--to", "dev@rig-b", "--summary", "s"], [error()], json);
          expect(code).toBe(1);
          expect(text).toContain("outcome is UNKNOWN");
          expect(text).not.toMatch(/not delivered/i);
          expect(text).toContain("Before any retry, read source row qitem-src-1");
        });
      }
    }
  }

  // The selected daemon's forward can answer with a structured reply instead of throwing. An explicit indeterminate one
  // gets the same source-row hint, with the reply and its exit code unchanged; a refusal before any forward implies no
  // write that may still commit.
  const INDETERMINATE = { status: 502, data: { error: "remote_queue_write_failed", hostId: "vps-b", failureClass: "unreachable",
    outcome: "indeterminate", detail: "remote queue write timed out after 10000ms; the remote may still commit it" } };
  const REFUSED = { status: 502, data: { error: "remote_queue_write_failed", hostId: "vps-b", failureClass: "unsupported-transport",
    detail: "host 'vps-b' is SSH-declared" } };
  for (const verb of ["handoff", "handoff-and-complete"] as const) {
    it(`a ${verb} whose forward answers indeterminate names the source row to read, keeping the reply and exit code`, async () => {
      await run([verb, "qitem-src-1", "--to", "dev@rig-b@vps-b", "--summary", "s"], [INDETERMINATE]);
      const all = stderr.join("\n");
      expect(all).toContain("Before any retry, read source row qitem-src-1 at the same endpoint and OPENRIG_HOME: rig queue show 'qitem-src-1' --full --json.");
      expect(all).toContain("a handed-off row names its successor on host 'vps-b', or says why it can't.");
      expect(stdout).toEqual([JSON.stringify(INDETERMINATE.data)]);
      expect(process.exitCode).toBe(2);
    });

    it(`a ${verb} the daemon refused to forward says nothing may still commit`, async () => {
      await run([verb, "qitem-src-1", "--to", "dev@rig-b@vps-b", "--summary", "s"], [REFUSED]);
      expect(stderr.join("\n")).not.toMatch(/may still commit|INDETERMINATE|Before any retry/);
      expect(stdout).toEqual([JSON.stringify(REFUSED.data)]);
      expect(process.exitCode).toBe(2);
    });
  }
});
