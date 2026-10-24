// Slice 16: a `rig send` to a seat that is switching runtime waits for the switch, so the sender is told why and for
// how long before it waits, and told plainly if the seat moved and nothing was typed. The daemon is a fake.
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

type Answer = { status: number; data: unknown };
async function send(probe: Answer, sent: Answer) {
  const posts: Array<{ path: string; options?: { timeoutMs?: number } }> = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const deps: StatusDeps = {
    lifecycleDeps: lifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => path.startsWith("/api/seat/runtime-switch/") ? probe : { status: 404, data: {} }),
      post: vi.fn(async (path: string, _body: unknown, options?: { timeoutMs?: number }) => { posts.push({ path, options }); return sent; }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
  const program = new Command();
  program.exitOverride();
  program.addCommand(sendCommand(deps));
  const before = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...a) => { stdout.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { stderr.push(a.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a) => { stderr.push(a.join(" ")); });
  try { await program.parseAsync(["node", "rig", "send", "dev-impl@my-rig", "please pick up the review"]); }
  finally { vi.restoreAllMocks(); }
  const exitCode = process.exitCode;
  process.exitCode = before;
  return { posts, stderr: stderr.join("\n"), stdout: stdout.join("\n"), exitCode };
}

const delivered: Answer = { status: 200, data: { ok: true, sessionName: "dev-impl@my-rig" } };
const switching = (deadlineAt: string, committed = false): Answer =>
  ({ status: 200, data: { runtimeSwitch: { id: "01SW", from: "codex", to: "claude-code", committed, deadlineAt } } });

describe("rig send to a seat that is switching runtime", () => {
  it("says why the send waits and until when, and waits that long instead of timing out first", async () => {
    const deadline = new Date(Date.now() + 120_000).toISOString();
    const { posts, stderr, stdout } = await send(switching(deadline), delivered);
    expect(stderr).toContain(`Note: dev-impl@my-rig is switching runtime (codex -> claude-code, switch 01SW). This send waits for it, until about ${deadline}.`);
    expect(stderr).toMatch(/If the seat moves to claude-code, nothing is typed and you'll need to send again/);
    expect(posts[0]!.path).toBe("/api/transport/send");
    expect(posts[0]!.options?.timeoutMs).toBeGreaterThan(140_000);
    expect(stdout).toMatch(/Sent to dev-impl@my-rig/);
  });

  it("if the seat moved while the send waited, says nothing was typed and to send again", async () => {
    const refused: Answer = { status: 500, data: { ok: false, sessionName: "dev-impl@my-rig", sent: false, reason: "guard_target_changed",
      error: "Input target changed while waiting; no input written." } };
    const { stderr, exitCode } = await send(switching(new Date(Date.now() + 60_000).toISOString()), refused);
    expect(stderr).toMatch(/The seat moved to claude-code while this send waited, so nothing was typed\. Send it again to reach its new occupant\./);
    // The send failed (as before, a daemon 5xx exits 2).
    expect(exitCode).toBeGreaterThan(0);
  });

  it.each([
    ["a seat that isn't switching", { status: 200, data: { runtimeSwitch: null } }],
    ["a committed switch (the seat has already moved)", switching(new Date(Date.now() + 60_000).toISOString(), true)],
    ["a daemon without the route", { status: 404, data: {} }],
  ])("%s: the send goes as before, with no notice", async (_case, probe) => {
    const { posts, stderr, stdout } = await send(probe as Answer, delivered);
    expect(stderr).not.toMatch(/switching runtime/);
    expect(posts[0]!.options?.timeoutMs ?? 0).toBeLessThan(60_000);
    expect(stdout).toMatch(/Sent to dev-impl@my-rig/);
  });
});
