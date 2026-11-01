// Slice 16: `rig seat set-runtime`, as the person or agent sees it. The daemon is a fake; what's checked is what the
// command sends and what it prints.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { seatCommand } from "../src/commands/seat.js";
import { DaemonTimeoutError } from "../src/client.js";
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

type Call = { path: string; body: unknown; options?: { timeoutMs?: number } };
function deps(answer: { status: number; data: unknown } | Error, calls: Call[]): StatusDeps {
  return {
    lifecycleDeps: lifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async () => ({ status: 200, data: {} })),
      post: vi.fn(async (path: string, body: unknown, options?: { timeoutMs?: number }) => {
        calls.push({ path, body, options });
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
}

async function run(answer: { status: number; data: unknown } | Error, args: string[]) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const program = new Command();
  program.addCommand(seatCommand(deps(answer, calls)));
  program.exitOverride();
  for (const sub of program.commands) { sub.exitOverride(); for (const leaf of sub.commands) leaf.exitOverride(); }
  const before = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a) => { errors.push(a.join(" ")); });
  try { await program.parseAsync(["node", "rig", "seat", "set-runtime", ...args]); }
  finally { vi.restoreAllMocks(); }
  const exitCode = process.exitCode;
  process.exitCode = before;
  return { calls, logs, errors, exitCode };
}

const plan = {
  ok: true, dryRun: true, changed: true, seat: { ref: "dev.impl@my-rig" }, from: "codex", to: "claude-code",
  settings: { model: { value: "claude-opus-5-5", source: "agent_spec" }, effort: { value: null, source: "native_default" },
    advisor: { value: null, source: "native_default" }, codexConfigProfile: { value: null, source: "native_default" } },
  permission: { mode: "inherit", source: "member_or_rig_policy" },
  dropped: [{ setting: "model", value: "gpt-5.5" }, { setting: "codex config profile", value: "fast" }],
  costs: ["A new conversation: native history isn't converted; only the handover carries over."],
  notRun: [], warnings: [],
};

describe("rig seat set-runtime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an older daemon cannot silently ignore the chosen home and execute a switch", async () => {
    const { calls, exitCode } = await run({ status: 200, data: plan }, ["dev.impl@my-rig", "--runtime", "claude-code",
      "--account-home", "/accounts/claude-api", "--reason", "Plan limit", "--json"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ dryRun: true });
  });

  it("selects the successor's account home in the same runtime-switch request", async () => {
    const { calls, exitCode } = await run({ status: 200, data: { ...plan, accountHome: "/accounts/claude-api" } }, ["dev.impl@my-rig", "--runtime", "claude-code",
      "--account-home", "/accounts/claude-api", "--reason", "Use API budget", "--json", "--dry-run"]);
    expect(calls[0]!.body).toMatchObject({ runtime: "claude-code", accountHome: "/accounts/claude-api", reason: "Use API budget", dryRun: true });
    expect(exitCode).toBeFalsy();
  });

  it("requires an explicit null-home acknowledgement before clearing the account selection", async () => {
    const args = ["dev.impl@my-rig", "--runtime", "claude-code", "--clear-account-home", "--reason", "Plan reset", "--json", "--dry-run"];
    const old = await run({ status: 200, data: plan }, args);
    expect(old.exitCode).toBe(1);
    expect(old.calls).toHaveLength(1);
    const accepted = await run({ status: 200, data: { ...plan, accountHome: null } }, args);
    expect(accepted.exitCode).toBeFalsy();
    expect(accepted.calls[0]!.body).toMatchObject({ clearAccountHome: true, dryRun: true });
    expect(JSON.parse(accepted.logs[0]!)).toMatchObject({ accountHome: null });
  });

  it("a human dry run identifies the selected account home and token reference without reading credentials", async () => {
    const selected = { ...plan, accountHome: "/accounts/claude-plan",
      accountToken: { label: "work-plan", tokenFile: "/tokens/work-plan" } };
    const { calls, logs, exitCode } = await run({ status: 200, data: selected }, ["dev.impl@my-rig", "--runtime", "claude-code",
      "--account-home", "/accounts/claude-plan", "--token-file", "/tokens/work-plan", "--account-label", "work-plan",
      "--reason", "Use plan", "--dry-run"]);
    expect(logs).toContain("Selected account home: /accounts/claude-plan");
    expect(logs).toContain("Claude token reference: work-plan, read from /tokens/work-plan at launch");
    expect(logs.join("\n")).toContain("Nothing changes until you run it without --dry-run.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ dryRun: true });
    expect(exitCode).toBeFalsy();
  });

  it("a dry run shows the target's settings and where each comes from, what is cleared, and the costs", async () => {
    const { calls, logs, exitCode } = await run({ status: 200, data: plan }, ["dev.impl@my-rig", "--runtime", "claude-code", "--reason", "Codex limit", "--dry-run"]);
    expect(calls[0]).toMatchObject({ path: "/api/seat/set-runtime/dev.impl%40my-rig", body: { runtime: "claude-code", reason: "Codex limit", dryRun: true } });
    expect(logs).toContain("Runtime switch plan for dev.impl@my-rig: codex -> claude-code. Nothing changes until you run it without --dry-run.");
    expect(logs).toContain("  model: claude-opus-5-5 (from the seat's agent spec)");
    expect(logs).toContain("  effort: none (the runtime's default)");
    expect(logs).toContain("  permissions: the seat's member and rig policy");
    expect(logs).toContain("Cleared from codex: model gpt-5.5; codex config profile fast.");
    expect(logs).toContain("  - A new conversation: native history isn't converted; only the handover carries over.");
    expect(exitCode).toBeFalsy();
  });

  it("a completed switch says the successor confirmed, and what happened to the seat's queue", async () => {
    const done = { ...plan, dryRun: false, switchId: "01SW", confirmation: { note: "picking up the review", at: "x" }, openRows: 3, claimsMoved: 1, recoveryPending: false };
    const { calls, logs, exitCode } = await run({ status: 200, data: done }, ["dev.impl@my-rig", "--runtime", "claude-code", "--reason", "Codex limit", "--confirm-timeout", "120"]);
    expect(calls[0]!.body).toMatchObject({ dryRun: false, confirmTimeoutSeconds: 120 });
    // The CLI waits long enough for the successor to start and confirm.
    expect(calls[0]!.options?.timeoutMs).toBe(240_000);
    expect(logs).toContain("Switched dev.impl@my-rig from codex to claude-code (switch 01SW).");
    expect(logs).toContain('The successor confirmed the handover: "picking up the review"');
    expect(logs).toContain("Queue: 3 open rows stay addressed to the seat; 1 claims moved to the successor.");
    expect(exitCode).toBeFalsy();
  });

  it("reports pending recovery without presenting the runtime switch as complete", async () => {
    const pending = { ...plan, dryRun: false, switchId: "01SW", recoveryPending: true,
      warnings: ["Run rig seat set-runtime dev.impl@my-rig --recover before trying again."] };
    const args = ["dev.impl@my-rig", "--runtime", "claude-code", "--reason", "Plan limit"];
    const { logs, errors, exitCode } = await run({ status: 200, data: pending }, args);
    expect(logs.join("\n")).not.toContain("Switched dev.impl@my-rig");
    expect(logs.join("\n")).toContain("Recovery is still pending");
    expect(errors.join("\n")).toContain("rig seat set-runtime dev.impl@my-rig --recover");
    expect(exitCode).toBe(1);
    const json = await run({ status: 200, data: pending }, [...args, "--json"]);
    expect(JSON.parse(json.logs.join("\n"))).toEqual(pending);
    expect(json.exitCode).toBe(1);
  });

  it("a switch that didn't happen says why and what's unchanged, and exits 1", async () => {
    const refusal = { ok: false, code: "runtime_switch_failed", committed: false,
      message: "The claude-code successor didn't confirm the handover within 180 s, so it isn't shown able to carry on.",
      guidance: "dev.impl@my-rig is unchanged on codex. Correct the cause and try again." };
    const { errors, exitCode } = await run({ status: 409, data: refusal }, ["dev.impl@my-rig", "--runtime", "claude-code", "--reason", "Codex limit"]);
    expect(errors.join("\n")).toMatch(/didn't confirm the handover within 180 s/);
    expect(errors.join("\n")).toMatch(/unchanged on codex/);
    expect(exitCode).toBe(1);
  });

  it("the staged successor confirms with a note saying what it'll do first", async () => {
    const { calls, logs } = await run({ status: 200, data: { ok: true, switchId: "01SW", message: "Confirmed. OpenRig is moving dev-impl@my-rig to you now." } },
      ["dev.impl@my-rig", "--confirm", "01SW", "--note", "picking up the review"]);
    expect(calls[0]).toMatchObject({ path: "/api/seat/set-runtime/dev.impl%40my-rig/confirm", body: { switchId: "01SW", note: "picking up the review" } });
    expect(logs).toContain("Confirmed. OpenRig is moving dev-impl@my-rig to you now.");
  });

  it("an interrupted switch is finished with --recover", async () => {
    const { calls, logs } = await run({ status: 200, data: { ok: true, outcome: "committed: finished; the seat runs claude-code", switchId: "01SW" } },
      ["dev.impl@my-rig", "--recover"]);
    expect(calls[0]!.path).toBe("/api/seat/set-runtime/dev.impl%40my-rig/recover");
    expect(logs).toContain("committed: finished; the seat runs claude-code");
  });

  it("when the CLI stops waiting, it says the outcome is unknown and how to check, rather than guessing", async () => {
    const { errors, exitCode } = await run(new DaemonTimeoutError("Request to /api/seat/set-runtime timed out after 300000ms"),
      ["dev.impl@my-rig", "--runtime", "claude-code", "--reason", "Codex limit"]);
    expect(errors.join("\n")).toMatch(/the daemon may still be switching the seat/);
    expect(errors.join("\n")).toMatch(/rig seat status 'dev\.impl@my-rig'/);
    expect(exitCode).toBe(1);
  });

  it.each([
    [["dev.impl@my-rig"], /exactly one of --runtime/],
    [["dev.impl@my-rig", "--runtime", "codex", "--recover"], /exactly one of --runtime/],
    [["dev.impl@my-rig", "--runtime", "codex"], /Pass --reason with --runtime/],
    [["dev.impl@my-rig", "--confirm", "01SW"], /Pass --note with --confirm/],
    [["dev.impl@my-rig", "--runtime", "codex", "--reason", "x", "--confirm-timeout", "5"], /from 10 to 3600/],
  ])("%j is refused before anything is sent", async (args, message) => {
    const { calls, errors, exitCode } = await run({ status: 200, data: {} }, args);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toMatch(message);
    expect(exitCode).toBe(1);
  });
});
