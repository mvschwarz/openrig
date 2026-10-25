import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// S5 (OPR.0.5.4.7) — CLI surface for rig seat set-model / stop / clean: required
// options, route paths + bodies posted, human output, refusal printing, --json
// pass-through with non-zero exit.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { seatCommand } from "../src/commands/seat.js";
import { DaemonTimeoutError } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) {
        return JSON.stringify({ pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" } as DaemonState);
      }
      return null;
    }),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function makeDeps(response: { status: number; data: unknown }, calls: Array<{ path: string; body: unknown }>): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => { calls.push({ path, body: undefined }); return response; }),
      post: vi.fn(async (path: string, body: unknown) => { calls.push({ path, body }); return response; }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
}

function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub as Command);
}

function makeCommand(deps: StatusDeps): Command {
  const program = new Command();
  program.addCommand(seatCommand(deps));
  applyExitOverride(program);
  return program;
}

async function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const exitCode = process.exitCode;
  process.exitCode = originalExitCode;
  return { logs, errors, exitCode };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("terminal interaction policy", () => {
  it("records the explicit preset and actor exceptions without changing native permissions", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const { logs, exitCode } = await captureLogs(() => makeCommand(makeDeps({ status: 200,
      data: { ok: true, effect: "Saved for managed checks; no native permission change." } }, calls)).parseAsync([
      "node", "rig", "seat", "set-terminal-policy", "reviewer@team", "--preset", "help-within-instructions",
      "--helper", "helper@team", "--peer-model", "deny", "--openrig-compaction", "allow", "--reason", "Keep the review model",
    ]));
    expect(calls).toEqual([{ path: "/api/seat/set-terminal-policy/reviewer%40team", body: {
      preset: "help-within-instructions", helpers: ["helper@team"],
      exceptions: { peer: { model: "deny" }, openrig: { compaction: "allow" } },
      rigDefault: false, reason: "Keep the review model", operator: undefined,
    } }]);
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("rig seat status 'reviewer@team'");
  });

  it("shows actor scope and enforcement limits in the ordinary seat account", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const { logs } = await captureLogs(() => makeCommand(makeDeps({ status: 200, data: {
      seat_ref: "reviewer@team", terminalPolicy: { state: "planned", label: "Custom", source: "explicit",
        instruction: "Keep the review model", rules: { peer: { compaction: "allow", model: "deny" } },
        supported: { compaction: "managed", model: "saved setting; native effect unverified" } },
    } }, calls)).parseAsync(["node", "rig", "seat", "status", "reviewer@team"]));
    expect(logs.join("\n")).toContain("Terminal interaction (planned; managed checks): Custom [explicit]");
    expect(logs.join("\n")).toContain("peer: compaction=allow; model/effort=deny");
    expect(logs.join("\n")).toContain("Other interventions: guidance-only");
  });
});

describe("#729 startup warnings", () => {
  it.each([[200, false], [200, true], [409, false], [409, true]] as const)("seat launch retains warnings and HTTP %s (json=%s)", async (status, json) => {
    const warning = "Startup submission unverified: capture unavailable";
    const calls: Array<{ path: string; body: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ status, data: { ok: status === 200, message: "Identity needs attention", warnings: [warning] } }, calls);
    const { logs, exitCode } = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "launch", "dev@fixture", "--fresh", "--reason", "requested", ...(json ? ["--json"] : []),
    ]));
    expect(exitCode).toBe(status === 200 ? undefined : 1);
    if (json) {
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!).warnings).toEqual([warning]);
      expect(warn).not.toHaveBeenCalled();
    } else expect(warn).toHaveBeenCalledWith(`Warning: ${warning}`);
    expect(calls).toHaveLength(1);
  });
});

describe("default-path rig seat continue", () => {
  it.each([false, true])("names CLI inspection for an ambiguous continuation refusal (json=%s)", async json => {
    const data = { ok: false, code: "continuation_unavailable", message: "No verified pending startup-context delivery exists for this occupant. Refresh to inspect its actual state." };
    const original = structuredClone(data);
    const calls: Array<{ path: string; body: unknown }> = [];
    const { logs, errors, exitCode } = await captureLogs(() => makeCommand(makeDeps({ status: 409, data }, calls)).parseAsync([
      "node", "rig", "seat", "continue", "dev@fixture", ...(json ? ["--json"] : []),
    ]).then(() => {}));
    expect(exitCode).toBe(1);
    expect(calls).toEqual([{ path: "/api/seat/continue/dev%40fixture", body: {} }]);
    expect(data).toEqual(original);
    if (json) {
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(original);
      expect(errors).toEqual([]);
    } else {
      expect(errors.join("\n")).toContain("No verified pending startup-context delivery exists");
      expect(errors.join("\n")).toContain("unknown whether context was already delivered or was never pending");
      expect(errors.join("\n")).toContain("rig seat status 'dev@fixture'");
      expect(errors.join("\n")).not.toContain("Refresh");
    }
  });
  it.each([[200, false], [200, true], [409, false], [409, true]] as const)("preserves response and warnings (HTTP %s, json=%s)", async (status, json) => {
    const data = { ok: status === 200, message: "Configured context delivered to the existing fresh conversation.", warnings: ["Submission unverified"] };
    const calls: Array<{ path: string; body: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logs, exitCode } = await captureLogs(() => makeCommand(makeDeps({ status, data }, calls)).parseAsync([
      "node", "rig", "seat", "continue", "dev@fixture", ...(json ? ["--json"] : []),
    ]).then(() => {}));
    expect(calls).toEqual([{ path: "/api/seat/continue/dev%40fixture", body: {} }]);
    expect(exitCode).toBe(status === 200 ? undefined : 1);
    if (json) {
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(data);
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(warn).toHaveBeenCalledWith("Warning: Submission unverified");
      if (status === 200) expect(logs).toEqual([data.message]);
    }
  });
});

describe("rig seat set-permissions", () => {
  it("posts a rules file as an audited future-launch update, keeping mode separate", async () => {
    const root = mkdtempSync(join(tmpdir(), "seat-rules-")), file = join(root, "rules.json");
    const rules = { allow: ["Bash(node lane.mjs *)"], deny: ["Read(./private/**)"] };
    writeFileSync(file, JSON.stringify(rules));
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: { ok: true, changed: true, to: rules, effect: "Next managed launch only." } }, calls);
    try {
      const result = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "set-permissions", "dev-impl@seat-rig",
        "--rules", file, "--reason", "Select lane", "--operator", "human@example.test"]).then(() => {}));
      expect(result.exitCode).toBeUndefined();
      expect(calls).toEqual([{ path: "/api/seat/set-permissions/dev-impl%40seat-rig", body: { rules, reason: "Select lane", operator: "human@example.test" } }]);
      expect(result.logs.join(" ")).toContain("recorded and audited");
      calls.splice(0);
      const ambiguous = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "set-permissions", "dev-impl@seat-rig",
        "--rules", file, "--mode", "full_bypass", "--reason", "No mixed update"]).then(() => {}));
      expect(ambiguous.exitCode).toBe(1); expect(calls).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("posts the explicit operator with the existing mode and reason", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: { ok: true, changed: true, to: { mode: "floor" }, effect: "Future managed launches only." } }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-permissions", "dev-impl@seat-rig",
        "--mode", "floor", "--reason", "future launch choice", "--operator", "human@example.test"]);
    });
    expect(calls).toEqual([{ path: "/api/seat/set-permissions/dev-impl%40seat-rig",
      body: { mode: "floor", reason: "future launch choice", operator: "human@example.test" } }]);
    expect(logs.join("\n")).toContain("Permission mode: floor");
    expect(exitCode).toBeUndefined();
  });
});

describe("rig seat set-cwd", () => {
  const args = ["node", "rig", "seat", "set-cwd", "planner@project", "--cwd", "/srv/remote/space dir/../planner", "--reason", "isolate planning"];

  it("requires cwd and reason before contacting the daemon", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: {} }, calls);
    await expect(makeCommand(deps).parseAsync(args.slice(0, 5))).rejects.toThrow(/--cwd/);
    await expect(makeCommand(deps).parseAsync(args.slice(0, 7))).rejects.toThrow(/--reason/);
    expect(calls).toEqual([]);
  });

  it("forwards the daemon-host path unchanged and describes the future-launch effect", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: { ok: true, seat: { logicalId: "planner", rigName: "project" },
      from: "/srv/shared", to: "/srv/remote/planner", changed: true, effect: "next_launch", warnings: ["Retained local guidance"] } }, calls);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logs, exitCode } = await captureLogs(() => makeCommand(deps).parseAsync([...args, "--operator", "operator@project"]).then(() => {}));
    expect(calls).toEqual([{ path: "/api/seat/set-cwd/planner%40project", body: {
      cwd: "/srv/remote/space dir/../planner", reason: "isolate planning", operator: "operator@project",
    } }]);
    expect(logs.join("\n")).toContain("/srv/remote/planner");
    expect(logs.join("\n")).toContain("The running process keeps its current directory");
    expect(logs.join("\n")).toContain("rig seat launch planner@project --fresh --stop");
    expect(warn).toHaveBeenCalledWith("Warning: Retained local guidance");
    expect(exitCode).toBeUndefined();
  });

  it.each([200, 409, 500])("preserves the daemon response in JSON, including a refused change (HTTP %s)", async status => {
    const data = status === 200
      ? { ok: true, changed: false, to: "/srv/remote/planner", effect: "next_launch", warnings: [] }
      : { ok: false, code: status === 500 ? "cwd_check_failed" : "cwd_destination_conflict", message: "The working directory was not changed", warnings: ["Protected destination file: /srv/remote/planner/.claude/agents/reviewer.md"] };
    const calls: Array<{ path: string; body: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logs, exitCode } = await captureLogs(() => makeCommand(makeDeps({ status, data }, calls)).parseAsync([...args, "--json"]).then(() => {}));
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual(data);
    expect(warn).not.toHaveBeenCalled();
    expect(exitCode).toBe(status === 200 ? undefined : status === 500 ? 2 : 1);
  });

  it("treats a timeout as an unknown outcome and directs the caller to status", async () => {
    const post = vi.fn(async () => { throw new DaemonTimeoutError("directory change timed out"); });
    const deps = { ...makeDeps({ status: 200, data: {} }, []), clientFactory: () => ({ post }) as never };
    const { logs, exitCode } = await captureLogs(() => makeCommand(deps).parseAsync([...args, "--json"]).then(() => {}));
    // set-cwd writes no startup files now, so it uses the default request deadline.
    expect(post).toHaveBeenCalledExactlyOnceWith("/api/seat/set-cwd/planner%40project", expect.any(Object));
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, code: "set_cwd_outcome_unknown", status: "unknown",
      guidance: expect.stringContaining("rig seat status planner@project") });
    expect(exitCode).toBe(1);
  });

  it("prints protected destination paths and recovery guidance for a conflict", async () => {
    const protectedPath = "/srv/remote/planner/.claude/agents/reviewer.md";
    const data = { ok: false, code: "cwd_destination_conflict", message: "Destination files conflict; cwd was not committed",
      guidance: "Use a clean destination, or inspect and move/merge the reported files before retrying.",
      warnings: [`Protected destination file: ${protectedPath}`] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { errors, exitCode } = await captureLogs(() => makeCommand(makeDeps({ status: 409, data }, [])).parseAsync(args).then(() => {}));
    expect(warn).toHaveBeenCalledWith(`Warning: Protected destination file: ${protectedPath}`);
    expect(errors.join("\n")).toContain("cwd was not committed");
    expect(errors.join("\n")).toContain("inspect and move/merge");
    expect(exitCode).toBe(1);
  });
});

describe("rig seat set-model", () => {
  it("posts model/reason/operator to /api/seat/set-model/<seat> and prints the from->to summary", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: { ok: true, seat: { logicalId: "dev.impl", rigName: "seat-rig" }, from: "fable", to: "claude-fable-5", changed: true },
    }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev-impl@seat-rig", "--model", "claude-fable-5", "--reason", "alias migration", "--operator", "op@rig"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/set-model/dev-impl%40seat-rig");
    expect(calls[0]!.body).toEqual({ model: "claude-fable-5", reason: "alias migration", operator: "op@rig" });
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("fable -> claude-fable-5");
  });

  it("requires --model and --reason (commander rejects before any request)", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: {} }, calls);
    await expect(
      makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev-impl@seat-rig", "--reason", "x"]),
    ).rejects.toThrow(/--model/);
    await expect(
      makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev-impl@seat-rig", "--model", "m"]),
    ).rejects.toThrow(/--reason/);
    expect(calls).toHaveLength(0);
  });

  it("prints the daemon's refusal (message + guidance) and exits 1 on 4xx", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 409,
      data: { ok: false, code: "seat_ambiguous", message: 'Seat "dev.impl" matched multiple nodes', guidance: "List seats with: rig ps --nodes", matches: [{ rig_name: "a", logical_id: "dev.impl", current_occupant: null }] },
    }, calls);
    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev.impl", "--model", "m", "--reason", "x"]);
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("matched multiple nodes");
    expect(errors.join("\n")).toContain("rig ps --nodes");
  });
});

describe("rig seat set-effort", () => {
  const seat = { logicalId: "dev.impl", rigName: "seat-rig" };

  it("posts effort/reason to /api/seat/set-effort/<seat> and keeps saved, emitted and observed apart", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: {
        ok: true, seat, runtime: "claude-code", requested: "high", changed: true, running: "yes", emitted: "not_yet", observed: "not_observed",
        saved: { choice: "high", authored: "medium", effective: "high", source: "seat_choice" },
        effect: "Saved for the seat's next managed continuation. The running process is unchanged; nothing was restarted.",
      },
    }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-effort", "dev-impl@seat-rig", "--effort", "high", "--reason", "long refactor"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/set-effort/dev-impl%40seat-rig");
    expect(calls[0]!.body).toEqual({ effort: "high", reason: "long refactor" });
    expect(exitCode).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("Effort for dev.impl@seat-rig: high (this seat's choice).");
    expect(out).toContain("next managed continuation");
    expect(out).toContain("Seat running now. Emitted at launch: not yet. Native effort: not observed.");
  });

  it("--clear posts clear and names what the seat falls back to", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: {
        ok: true, seat, runtime: "codex", requested: null, changed: true, running: "unknown", runningDetail: "probe failed", emitted: "not_yet", observed: "not_observed",
        saved: { choice: null, authored: null, effective: null, source: "runtime_default" },
        effect: "Cleared: the next managed continuation uses no effort flag (the runtime's own default). The running process is unchanged; nothing was restarted.",
      },
    }, calls);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-effort", "dev.impl", "--clear", "--reason", "back"]);
    });
    expect(calls[0]!.body).toEqual({ clear: true, reason: "back" });
    expect(logs.join("\n")).toContain("no effort flag (runtime default)");
    expect(logs.join("\n")).toContain("running state unknown (probe failed)");
  });

  it("requires exactly one of --effort or --clear, before any request", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: {} }, calls);
    for (const extra of [[], ["--effort", "high", "--clear"]]) {
      const { errors, exitCode } = await captureLogs(async () => {
        await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-effort", "dev.impl", "--reason", "x", ...extra]);
      });
      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("exactly one of --effort <level> or --clear");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("rig seat effort", () => {
  const seat = { logicalId: "dev.impl", rigName: "seat-rig" };

  it("reads /api/seat/effort/<seat> and prints the four values apart, with NOT VERIFIED where native can't be seen", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: {
        ok: true, seat, runtime: "codex",
        requested: { value: "high", at: "2026-10-13 05:50:00", reason: "long refactor", operator: null },
        saved: { choice: "high", authored: "medium", effective: "high", source: "seat_choice" },
        emitted: { state: "observed", value: "medium", pid: 200, startedAt: null, matchesSaved: false },
        observed: { state: "not_verified", detail: "The session has recorded no turn with an effort since this process started." },
        precedence: { decided: false, detail: "Precedence is the founder's open decision." },
        summary: "Saved: high (seat choice). Launch sent: medium.",
      },
    }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "effort", "dev-impl@seat-rig"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/effort/dev-impl%40seat-rig");
    expect(exitCode).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain('Requested: high at 2026-10-13 05:50:00 ("long refactor")');
    expect(out).toContain("Saved:     high (this seat's choice)");
    expect(out).toContain("Launch:    medium (process 200)");
    expect(out).toContain("Native:    NOT VERIFIED: The session has recorded no turn");
    expect(out).toContain("Note: Precedence is the founder's open decision.");
  });

  it("prints a refusal and exits non-zero", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 409, data: { ok: false, code: "effort_unsupported_runtime", message: "Seat runs pi." } }, calls);
    const { exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "effort", "dev.pi"]);
    });
    expect(exitCode).toBe(1);
  });
});

describe("rig seat stop", () => {
  it("posts reason to /api/seat/stop/<seat> and prints the stopped summary", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: { ok: true, seat: { logicalId: "dev.impl", rigName: "seat-rig" }, sessionName: "dev-impl@seat-rig", sessionId: "S1" },
    }, calls);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "stop", "dev-impl@seat-rig", "--reason", "wave boundary"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/stop/dev-impl%40seat-rig");
    expect(calls[0]!.body).toEqual({ reason: "wave boundary", operator: undefined });
    expect(logs.join("\n")).toContain("Stopped dev-impl@seat-rig");
    expect(logs.join("\n")).toContain("siblings untouched");
  });

  it("--json passes the refusal through verbatim and exits 1", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const refusal = { ok: false, code: "session_not_live", message: "not alive", guidance: "rig seat clean" };
    const deps = makeDeps({ status: 409, data: refusal }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "stop", "dev-impl@seat-rig", "--reason", "x", "--json"]);
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(logs.join(""))).toEqual(refusal);
  });
});

describe("rig seat clean", () => {
  it("posts reason to /api/seat/clean/<seat> and prints the actions summary", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: { ok: true, seat: { logicalId: "dev.impl", rigName: "seat-rig" }, actions: { sessionsExited: ["dev-impl@seat-rig"], bindingCleared: true } },
    }, calls);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "clean", "dev-impl@seat-rig", "--reason", "clean exit observed"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/clean/dev-impl%40seat-rig");
    expect(logs.join("\n")).toContain("Sessions marked exited: dev-impl@seat-rig");
    expect(logs.join("\n")).toContain("binding cleared: yes");
    expect(logs.join("\n")).toContain("launchable again");
  });
});

describe("fresh launch preview", () => {
  it.each([true, false, null].flatMap(launchable => [false, true].map(json => ({ launchable, json }))))("renders a read-only plan and its exit status: %j", async ({ launchable, json }) => {
    const data = { ok: true, planOnly: true, complete: launchable !== null, launchable,
      sessionName: "dev@fixture", currentOccupant: launchable === null ? "unknown" : "present",
      startup: { projectionCount: 2, fileCount: 1, actionCount: 0 },
      stopRequired: launchable === null ? null : true, wouldStop: launchable === null ? null : launchable,
      blockers: launchable === false ? [{ code: "session_live", message: "Needs --stop" }] : [], warnings: [],
      siblings: [{ logicalId: "qa", effect: "unchanged" }] };
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data }, calls);
    const output = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "launch", "dev@fixture", "--fresh", "--plan", ...(json ? ["--json"] : []),
    ]).then(() => undefined));
    expect(calls).toEqual([{ path: "/api/seat/launch-plan/dev%40fixture", body: { fresh: true, reason: undefined, stop: false, operator: undefined } }]);
    expect(output.exitCode).toBeUndefined();
    if (json) expect(JSON.parse(output.logs.join("\n"))).toEqual(data);
    else {
      expect(output.logs.join("\n")).toContain("no changes made");
      expect(output.logs.join("\n")).toContain("launchable:");
      expect(output.logs.join("\n")).toContain("2 projections, 1 files, 0 actions");
      expect(output.logs.join("\n")).toContain("Sibling qa: unchanged");
      expect(output.logs.join("\n")).not.toContain("Fresh occupant ready");
    }
    expect(deps.lifecycleDeps.writeFile).not.toHaveBeenCalled();
    expect(deps.lifecycleDeps.spawn).not.toHaveBeenCalled();
  });

  it("OPR.0.7.0.9: the printed plan shows the seat's launch additions, as the seat view does", async () => {
    const launchAdditions = { agent: "openrig:reviewer", agentPromptReplacesDefault: true, appendSystemPromptFile: "/s/additions/system-prompt.md",
      pluginDirs: ["/s/additions/plugins/review"], missing: ["/s/gone"], refused: ["/s/linked is not inside this seat's storage"] };
    const data = { ok: true, planOnly: true, complete: true, launchable: true, sessionName: "dev@fixture", currentOccupant: "absent",
      startup: { projectionCount: 0, fileCount: 0, actionCount: 0 }, stopRequired: false, wouldStop: false, blockers: [], warnings: [], siblings: [],
      launchAdditions };
    const deps = makeDeps({ status: 200, data }, []);
    const output = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "launch", "dev@fixture", "--fresh", "--plan"]).then(() => undefined));
    const text = output.logs.join("\n");
    expect(text).toContain("agent       openrig:reviewer (--agent; its prompt replaces Claude's default system prompt)");
    expect(text).toContain("prompt      /s/additions/system-prompt.md (--append-system-prompt-file)");
    expect(text).toContain("plugin dir  /s/additions/plugins/review (CLAUDE_CODE_PLUGIN_DIRS)");
    expect(text).toContain("missing     /s/gone: not passed to the launch");
    expect(text).toContain("refused     /s/linked is not inside this seat's storage: not passed to the launch");
  });

  it("fails closed on an older daemon without ever posting to the launch endpoint", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 404, data: { error: "Not Found" } }, calls);
    const output = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "launch", "dev@fixture", "--fresh", "--plan", "--stop", "--reason", "optional preview reason", "--json",
    ]).then(() => undefined));
    expect(output.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/seat/launch-plan/dev%40fixture");
  });

  it("requires a reason for execution before contacting the daemon", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data: {} }, calls)).parseAsync([
      "node", "rig", "seat", "launch", "dev@fixture", "--fresh", "--json",
    ]).then(() => undefined));
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.logs.join("\n"))).toMatchObject({ code: "missing_reason" });
    expect(calls).toEqual([]);
  });
});

describe("OPR.0.7.0.5 rig seat restart --keep-conversation", () => {
  const report = (outcome?: string) => ({
    ok: true, planOnly: outcome === undefined, ...(outcome ? { outcome } : {}), message: "Done.",
    seat: { logicalId: "dev.codex", rigName: "r" }, sessionName: "dev-codex@r", pane: "%1", paneShape: "shell_backed",
    conversationId: "tok", conversationProof: "argv", activity: { state: "working", detail: "Mid-turn." },
    childProcesses: [{ pid: 9, name: "node" }], codexHome: "/h/.codex",
    account: { credentialStore: { detail: "File-backed." }, authFile: { detail: "Stat only." }, startupGate: null },
    peers: [{ logicalId: "dev.peer", effect: "Not restarted; account unverified." }], warnings: [],
  });

  it("prints the --no-daemon launch evidence and a named startup gate's kind", async () => {
    const data = { ...report("incomplete"), codexNoDaemonFlag: { present: true, detail: "Launch evidence: the running Codex was started with --no-daemon. This doesn't show whether an app-server process, its login or any lock is involved." },
      account: { credentialStore: { detail: "File-backed." }, authFile: { detail: "Stat only." }, startupGate: "Codex is waiting for hook trust approval.", startupGateKind: "hook_trust_gate" },
      remainingStep: "Codex is waiting for a hook review decision in the pane (dev-codex@r, pane %1). That decision is for the person or an authorised operator; once it's made, run the recovery command." };
    const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data }, [])).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--reason", "x"]).then(() => undefined));
    const text = output.logs.join("\n");
    expect(text).toContain("Launch evidence: the running Codex was started with --no-daemon.");
    expect(text).not.toContain("Process mode");
    expect(text).not.toContain("Billing route");
    expect(text).toContain("Codex startup gate (hook_trust_gate): Codex is waiting for hook trust approval.");
    expect(text).toContain("Remaining step: Codex is waiting for a hook review decision");
  });

  it("requires a reason before contacting the daemon, and refuses --plan with --verify", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const missing = await captureLogs(() => makeCommand(makeDeps({ status: 200, data: {} }, calls)).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--json"]).then(() => undefined));
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.logs.join("\n"))).toMatchObject({ code: "missing_reason" });
    const both = await captureLogs(() => makeCommand(makeDeps({ status: 200, data: {} }, calls)).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--plan", "--verify"]).then(() => undefined));
    expect(both.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  it("plan posts to restart-plan and prints activity, children and peers", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data: report() }, calls)).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--plan"]).then(() => undefined));
    expect(calls).toEqual([{ path: "/api/seat/restart-plan/dev%40r", body: {} }]);
    expect(output.exitCode).toBeUndefined();
    const text = output.logs.join("\n");
    expect(text).toContain("Activity: working. Mid-turn.");
    expect(text).toContain("Child processes (stopped with Codex): node 9.");
    expect(text).toContain("Peer dev.peer: Not restarted; account unverified.");
  });

  it.each([
    ["restarted_account_unverified", false, undefined], ["incomplete", false, 1], ["not_started", true, 1], ["native_unknown", true, 1],
  ] as const)("restart %s (json=%s) exits %s", async (outcome, json, exitCode) => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data: report(outcome) }, calls)).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--reason", "new account", "--operator", "op@r",
      ...(json ? ["--json"] : [])]).then(() => undefined));
    expect(calls).toEqual([{ path: "/api/seat/restart/dev%40r", body: { reason: "new account", operator: "op@r" } }]);
    expect(output.exitCode).toBe(exitCode);
    if (json) expect(JSON.parse(output.logs.join("\n"))).toMatchObject({ outcome });
    else expect(output.logs[0]).toContain(`${outcome}: dev.codex@r`);
  });

  it("prints a stale restart and the last recorded result", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const data = { ...report(), staleRestart: { startedAt: "2026-10-12T20:59:59.000Z", detail: "Started before this daemon did." },
      lastRestart: { outcome: "native_unknown", finishedAt: "2026-10-12T21:00:00.000Z" } };
    const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data }, calls)).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--plan"]).then(() => undefined));
    expect(output.logs.join("\n")).toContain("Stale restart from 2026-10-12T20:59:59.000Z: Started before this daemon did.");
    expect(output.logs.join("\n")).toContain("Last restart: native_unknown at 2026-10-12T21:00:00.000Z.");
  });

  it("prints the pane and process state observed after a failed stop", async () => {
    const data = { ...report(), outcome: "incomplete", observedAfterStop: { pane: "gone", process: "exited", detail: "pane gone, original Codex exited" } };
    const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data }, [])).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--reason", "x"]).then(() => undefined));
    expect(output.logs.join("\n")).toContain("Observed after the stop: pane gone, original Codex exited.");
  });

  it("a timed-out restart says the outcome is unknown and how --plan reports it", async () => {
    const { DaemonTimeoutError } = await import("../src/client.js");
    const deps = makeDeps({ status: 200, data: {} }, []);
    deps.clientFactory = () => ({ post: vi.fn(async () => { throw new DaemonTimeoutError("slow"); }) }) as never;
    const output = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--reason", "x", "--json"]).then(() => undefined));
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.logs.join("\n"))).toMatchObject({ code: "restart_outcome_unknown",
      guidance: expect.stringContaining("refuses with restart_in_progress while it is still running, then shows its result as lastRestart") });
  });

  it("verify posts the expected account and prints the outcome", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const data = { ok: true, outcome: "moved", message: "Moved.", toolTurn: { state: "observed", completed: 1, errors: 0 }, accountEvidence: { detail: "Matched." } };
    const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data }, calls)).parseAsync([
      "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--verify", "--expect-account", "me@example.com"]).then(() => undefined));
    expect(calls).toEqual([{ path: "/api/seat/restart-verify/dev%40r", body: { expectAccount: "me@example.com" } }]);
    expect(output.logs.join("\n")).toContain("moved: Moved.");
    expect(output.exitCode).toBeUndefined();
  });

  it("verify exits 1 unless the outcome is moved, with and without --json", async () => {
    const data = { ok: true, outcome: "restarted_account_unverified", message: "Account unverified.", toolTurn: { state: "observed", completed: 1, errors: 0 }, accountEvidence: { detail: "Not matched." } };
    for (const json of [[], ["--json"]]) {
      const output = await captureLogs(() => makeCommand(makeDeps({ status: 200, data }, [])).parseAsync([
        "node", "rig", "seat", "restart", "dev@r", "--keep-conversation", "--verify", "--expect-account", "me@example.com", ...json]).then(() => undefined));
      expect(output.exitCode).toBe(1);
    }
  });
});
