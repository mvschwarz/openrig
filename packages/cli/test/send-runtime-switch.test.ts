// Slice 16: a `rig send` to a seat that is switching runtime. The daemon answers on the send itself (held at once, or
// "the seat moved" if it waited), so the CLI makes one request and shows that answer. The daemon is a fake.
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { sendCommand } from "../src/commands/send.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE
      ? JSON.stringify({ pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" } as DaemonState) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
}

async function send(answer: { status: number; data: unknown }) {
  const requests: string[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const deps: StatusDeps = {
    lifecycleDeps: lifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => { requests.push(`GET ${path}`); return { status: 404, data: {} }; }),
      post: vi.fn(async (path: string) => { requests.push(`POST ${path}`); return answer; }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
  const program = new Command();
  program.exitOverride();
  program.addCommand(sendCommand(deps));
  const before = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...a) => { stdout.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { stderr.push(a.join(" ")); });
  try { await program.parseAsync(["node", "rig", "send", "dev-impl@my-rig", "please pick up the review"]); }
  finally { vi.restoreAllMocks(); }
  const exitCode = process.exitCode;
  process.exitCode = before;
  return { requests, stderr: stderr.join("\n"), stdout: stdout.join("\n"), exitCode };
}

describe("rig send to a seat that is switching runtime", () => {
  it("is held at once, and the sender is told why and until when, in one request", async () => {
    const { requests, stdout, exitCode } = await send({ status: 200, data: { ok: true, sessionName: "dev-impl@my-rig", outcome: "retained", sent: false,
      reason: "runtime_switch_in_progress", warning: "dev-impl@my-rig is switching runtime (codex -> claude-code, switch 01SW) until about 2026-10-24T03:00:00Z. Send it again after the switch; it then reaches whoever holds the seat." } });
    expect(requests).toEqual(["POST /api/transport/send"]);
    expect(stdout).toBe("Retained, not delivered to dev-impl@my-rig. dev-impl@my-rig is switching runtime (codex -> claude-code, switch 01SW) until about 2026-10-24T03:00:00Z. Send it again after the switch; it then reaches whoever holds the seat.");
    expect(exitCode).toBeFalsy();
  });

  it("a send that waited while the seat moved says nothing was typed and to send again", async () => {
    const { stderr, exitCode } = await send({ status: 409, data: { ok: false, sessionName: "dev-impl@my-rig", sent: false, reason: "guard_target_changed",
      error: "Input target changed while waiting; no input written. dev-impl@my-rig moved to claude-code (runtime switch 01SW) while this send waited, so nothing was typed. Send it again to reach its new occupant." } });
    expect(stderr).toMatch(/moved to claude-code \(runtime switch 01SW\) while this send waited, so nothing was typed\. Send it again to reach its new occupant\./);
    expect(exitCode).toBe(1);
  });
});
