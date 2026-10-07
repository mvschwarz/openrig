// An invalid --wake-after duration (and any other non-Commander error) must never fail silently.
// Before: `rig queue block <id> --on <blocker> --wake-after 7d` exited 1 with no output in a human
// run, so the owner believed the row was parked with a wake when nothing was parked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command, InvalidArgumentError } from "commander";
import { createProgram } from "../src/index.js";
import { runProgram } from "../src/cli-error.js";
import type { QueueDeps } from "../src/commands/queue.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

function makeQueueDeps(): { deps: QueueDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: {} }; }),
        getText: vi.fn(async () => ({ status: 200, data: "" })),
        post: vi.fn(async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return { status: 200, data: {} }; }),
        delete: vi.fn(async () => ({ status: 204, data: null })),
        postText: vi.fn(async () => ({ status: 200, data: "" })),
        postExpectText: vi.fn(async () => ({ status: 200, data: "" })),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

async function runCli(program: Command, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  await runProgram(program, ["node", "rig", ...args], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    exit: (c) => { exitCode = c; },
  });
  return { out, err, exitCode };
}

const FORMAT = "must be a positive integer with an optional s, m or h suffix (for example 90s, 15m, 168h)";
const block = (value: string, ...extra: string[]) =>
  ["queue", "block", "qitem-park", "--on", "external:cooldown", "--wake-after", value, ...extra];
const update = (value: string, ...extra: string[]) =>
  ["queue", "update", "qitem-park", "--state", "blocked", "--blocked-on", "external:cooldown", "--wake-after", value, ...extra];

describe("--wake-after: an invalid duration is refused loudly, before any daemon call", () => {
  // A seat identity, so a valid run really reaches the daemon client and "no daemon call" below
  // proves the parse refusal, not a missing seat.
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([
    ["queue block", block],
    ["queue update", update],
  ])("%s --wake-after 7d prints the accepted formats and the bad value to stderr and exits 1", async (_name, argv) => {
    const { deps, calls } = makeQueueDeps();
    const { out, err, exitCode } = await runCli(createProgram({ queueDeps: deps }), argv("7d"));
    expect(exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([`error: option '--wake-after <duration>' argument '7d' is invalid. ${FORMAT}; got '7d'`]);
    expect(calls).toEqual([]); // the daemon is never called
  });

  it.each(["15h20m", "0", "-5m", "1.5h", "99999999999999999999h"])("queue block --wake-after %s is refused the same way", async (value) => {
    const { deps, calls } = makeQueueDeps();
    const { err, exitCode } = await runCli(createProgram({ queueDeps: deps }), block(value));
    expect(exitCode).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(`${FORMAT}; got '${value}'`);
    expect(calls).toEqual([]);
  });

  it("--json: one parseable error object on stdout, nothing on stderr, exit 1, no daemon call", async () => {
    const { deps, calls } = makeQueueDeps();
    const { out, err, exitCode } = await runCli(createProgram({ queueDeps: deps }), block("7d", "--json"));
    expect(exitCode).toBe(1);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ ok: false, error: {
      code: "commander.invalidArgument",
      message: `option '--wake-after <duration>' argument '7d' is invalid. ${FORMAT}; got '7d'`,
    } });
    expect(calls).toEqual([]);
  });

  it("valid durations still reach the daemon unchanged (90s, 15m, 168h)", async () => {
    for (const [value, seconds] of [["90s", 90], ["15m", 900], ["168h", 604800]] as const) {
      const { deps, calls } = makeQueueDeps();
      await runCli(createProgram({ queueDeps: deps }), block(value, "--json"));
      expect(calls.find((c) => c.path === "/api/queue/qitem-park/update")?.body).toMatchObject({ wakeAfterSeconds: seconds });
    }
  });
});

describe("runProgram: no thrown error is silent in a human run", () => {
  const throwing = () => {
    const program = new Command("rig");
    program.command("boom").option("--json").action(() => { throw new Error("something broke"); });
    return program;
  };

  it("a plain Error thrown inside an action is written to stderr, exit 1", async () => {
    const { out, err, exitCode } = await runCli(throwing(), ["boom"]);
    expect(exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["error: something broke"]);
  });

  it("--json output for the same error is unchanged: the cli_error object only", async () => {
    const { out, err, exitCode } = await runCli(throwing(), ["boom", "--json"]);
    expect(exitCode).toBe(1);
    expect(err).toEqual([]);
    expect(out).toEqual(['{"ok":false,"error":{"code":"cli_error","message":"something broke"}}']);
  });

  // A CommanderError that an ACTION throws is not written by Commander (only the errors Commander
  // raises itself are), so it must be printed here too, exactly once.
  const throwingInvalid = () => {
    const program = new Command("rig");
    program.command("boom").option("--json").action(() => { throw new InvalidArgumentError("the value is not usable here"); });
    return program;
  };

  it("an InvalidArgumentError thrown inside an action is written to stderr once, exit 1", async () => {
    const { out, err, exitCode } = await runCli(throwingInvalid(), ["boom"]);
    expect(exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["error: the value is not usable here"]);
  });

  it("--json for an action's InvalidArgumentError is the commander.invalidArgument object only", async () => {
    const { out, err, exitCode } = await runCli(throwingInvalid(), ["boom", "--json"]);
    expect(exitCode).toBe(1);
    expect(err).toEqual([]);
    expect(out).toEqual(['{"ok":false,"error":{"code":"commander.invalidArgument","message":"the value is not usable here"}}']);
  });

  it("Commander's own errors are printed exactly once", async () => {
    const { deps } = makeQueueDeps();
    const { err, exitCode } = await runCli(createProgram({ queueDeps: deps }), ["queue", "list", "--no-such-flag"]);
    expect(exitCode).toBe(1);
    expect(err).toEqual(["error: unknown option '--no-such-flag'"]);
  });
});
