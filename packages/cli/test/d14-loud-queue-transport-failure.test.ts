// D14 (INTAKE 5674431c; accept-and-drop family #6) — a queue write whose transport
// THROWS must fail LOUD (classified stderr + nonzero exit), never exit 1 silently.
// Live specimen: `rig queue create --host <down-host>` exited 1 with ZERO output.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { DaemonTimeoutError } from "../src/client.js";

function lifecycleStub(): QueueDeps["lifecycleDeps"] {
  return {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(),
    exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 0),
    isProcessAlive: vi.fn(() => false), sleep: async () => {},
  } as unknown as QueueDeps["lifecycleDeps"];
}

describe("D14 — queue transport failures are LOUD", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("create --host with a throwing transport prints a classified error + exit 1 (never silent)", async () => {
    const deps: QueueDeps = {
      lifecycleDeps: lifecycleStub(),
      clientFactory: () => ({
        post: vi.fn(async () => { throw new DaemonTimeoutError("POST /api/queue/create timed out after 5000ms"); }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    // B8 supersession (reconciles D14 with the response-integrity render authority):
    // withClient prints the D14 context lines then RETHROWS; the shared runProgram
    // render owns the 3-part + exit. This test now drives the full layered path.
    const { runProgram } = await import("../src/cli-error.js");
    const { Command } = await import("commander");
    const program = new Command();
    program.addCommand(queueCommand(deps));
    let ioExit = 0;
    const ioErr: string[] = [];
    await runProgram(program, [
      "node", "rig", "queue", "create",
      "--source", "a@rig", "--destination", "b@rig", "--body", "x",
      "--summary", "s", "--host", "downhost", "--no-nudge",
    ], { out: () => {}, err: (l: string) => ioErr.push(l), exit: (c: number) => { ioExit = c; } });
    const spyOut = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const all = spyOut + "\n" + ioErr.join("\n");
    expect(all.length).toBeGreaterThan(0); // NEVER silent
    expect(all).toMatch(/timed out|transport|unreachable/i);
    expect(all).toContain("downhost"); // the D14 host context is named
    expect(ioExit === 1 || process.exitCode === 1).toBe(true); // honest nonzero via the shared render
  });
});
