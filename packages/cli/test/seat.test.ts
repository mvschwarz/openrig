import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { seatCommand, handoverCommand } from "../src/commands/seat.js";
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

function makeDeps(
  response: { status: number; data: unknown },
  paths: string[],
  postBodies?: unknown[],
): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => {
        paths.push(path);
        return response;
      }),
      post: vi.fn(async (path: string, body?: unknown) => {
        paths.push(path);
        postBodies?.push(body);
        return response;
      }),
    }) as unknown as StatusDeps["clientFactory"] extends (url: string) => infer T ? T : never,
  };
}

function makeCommand(deps: StatusDeps): Command {
  const program = new Command();
  program.exitOverride();
  program.addCommand(seatCommand(deps));
  program.addCommand(handoverCommand(deps));
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

const STATUS = {
  seat_ref: "dev-impl@seat-rig",
  rig_id: "rig-1",
  rig_name: "seat-rig",
  logical_id: "dev.impl",
  pod_id: "pod-1",
  pod_namespace: "dev",
  runtime: "codex",
  current_occupant: "dev-impl@seat-rig",
  session_status: "running",
  startup_status: "ready",
  occupant_lifecycle: "active",
  continuity_outcome: null,
  handover_result: null,
  previous_occupant: null,
  handover_at: null,
  restore_outcome: "n-a",
};

describe("seat typing guard commands", () => {
  it.each([undefined, "lead@test"])("retirement uses transport identity %s and sends only the required reason", async session => {
    const previous = process.env.OPENRIG_SESSION_NAME;
    try {
      if (session === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = session;
      const requests: Array<{ path: string; actor: string | null; body: unknown }> = [];
      const deps: StatusDeps = { lifecycleDeps: mockLifecycleDeps(), clientFactory: url => new DaemonClient(url, {
        fetchImpl: async (url, init) => {
          requests.push({ path: new URL(String(url)).pathname, actor: new Headers(init?.headers).get("X-OpenRig-Session"), body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ entry: { deliveryState: "retired" } }), { status: 200 });
        },
      }) };
      await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "retire-held-message", "worker@test", "held-1",
        "--reason", "read outside the terminal", "--json"]).then(() => undefined));
      expect(requests).toEqual([{ path: "/api/seat/retire-held-message/worker%40test/held-1", actor: session ?? null, body: { reason: "read outside the terminal" } }]);
    } finally {
      if (previous === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = previous;
    }
  });

  it("retirement help explains attribution for both terminal paths and preserves the required reason", () => {
    const cmd = seatCommand(makeDeps({ status: 200, data: {} }, [])).commands.find(c => c.name() === "retire-held-message")!;
    let help = "";
    cmd.configureOutput({ writeOut: text => { help += text; } });
    cmd.outputHelp();
    expect(help).toContain("OPENRIG_SESSION_NAME");
    expect(help).toContain("unattributed (no seat identity)");
    expect(help).toContain("--reason <text>");
    expect(cmd.options.find(o => o.long === "--reason")?.required).toBe(true);
    expect(cmd.options.find(o => o.long === "--reason")?.mandatory).toBe(true);
  });

  it.each([
    { origin: "launched", line: "Origin: launched by OpenRig" },
    { origin: "claimed", line: "Origin: adopted (origin=claimed): OpenRig didn't launch this session, so stop, restart and clean refuse it" },
    { origin: null, line: "Origin: unknown" },
    { origin: undefined, line: null },
    { origin: "unreadable", line: "Origin: unknown" },
  ])("#4003: seat status names the seat's origin ($origin)", async ({ origin, line }) => {
    const human = await captureLogs(() => makeCommand(makeDeps({ status: 200, data: { ...STATUS, origin } }, []))
      .parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]).then(() => undefined));
    expect(human.logs.filter((l) => l.startsWith("Origin:"))).toEqual(line ? [line] : []);
  });
  it("shows body-free current and historical native recovery evidence in human and JSON seat status", async () => {
    const nativeInput = { input: true, wake: true, cancel: false, target: null,
      unresolved: [{ requestId: "uncertain", runId: "old", inCurrentRun: false, kind: "cancel", stage: "completed", outcome: "requested", destination: "dev@rig" }],
      recovery: "Person native controls remain available. Explicit manual choice: rig seat stop dev@rig --reason <text>." };
    const paths: string[] = []; const deps = makeDeps({ status: 200, data: { ...STATUS, nativeInput } }, paths);
    const human = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]).then(() => undefined));
    expect(human.logs.join("\n")).toContain('"requestId":"uncertain"'); expect(human.logs).toContain(nativeInput.recovery);
    const json = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig", "--json"]).then(() => undefined));
    expect(JSON.parse(json.logs.join("\n")).nativeInput).toEqual(nativeInput);
  });
  it.each(["request_observed", "completed"])("reports a %s harness observation with time and honest pending state", async state => {
    const permission_stop = { state, command: "Bash: git [arguments hidden]", origin: "harness",
      source: "PermissionRequest", observed_at: "2026-11-05T01:00:00.000Z", actor: "subagent",
      pending: state === "completed" ? false : "unknown" };
    const paths: string[] = [], bodies: unknown[] = [];
    const deps = makeDeps({ status: 200, data: { ...STATUS, permission_stop } }, paths, bodies);
    const text = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "status", "dev-impl@seat-rig",
    ]).then(() => undefined));
    expect(text.logs).toContain("Latest permission observation at 2026-11-05T01:00:00.000Z: Bash: git [arguments hidden]; harness permission request (PermissionRequest, subagent)");
    expect(text.logs).toContain(state === "completed" ? "  Displayed actor's tool batch completed; this observation is no longer pending."
      : "  Displayed actor's pending status: unknown (an observation does not establish a waiting prompt).");
    expect(text.logs).toContain("  Other actors' pending state: unknown (only the latest observation is shown).");
    expect(text.logs.join("\n")).not.toContain("guard blocked");
    const json = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "status", "dev-impl@seat-rig", "--json",
    ]).then(() => undefined));
    expect(JSON.parse(json.logs.join(""))).toEqual({ ...STATUS, permission_stop });
    expect(paths).toEqual(["/api/seat/status/dev-impl%40seat-rig", "/api/seat/status/dev-impl%40seat-rig"]);
    expect(bodies).toEqual([]);
  });

  it.each([undefined, { state: "unavailable", command: "unavailable", origin: "unknown" }])(
    "omits an unavailable permission section without requesting a permission change (%j)", async permission_stop => {
      const paths: string[] = [], bodies: unknown[] = [];
      const deps = makeDeps({ status: 200, data: { ...STATUS, permission_stop } }, paths, bodies);
      const result = await captureLogs(() => makeCommand(deps).parseAsync([
        "node", "rig", "seat", "status", "dev-impl@seat-rig",
      ]).then(() => undefined));
      expect(result.exitCode).toBeUndefined();
      expect(result.logs.join("\n")).not.toMatch(/Permission observation unavailable|Latest permission observation|Claude's suggested rules/);
      expect(result.logs).toContain("Startup: ready");
      expect(result.logs.join("\n")).not.toMatch(/approval requested|guard blocked|permission pending|Permission stop/);
      expect(paths).toEqual(["/api/seat/status/dev-impl%40seat-rig"]);
      expect(bodies).toEqual([]);
    },
  );

  it("keeps the unknown diagnostic in seat status JSON without a permission mutation", async () => {
    const permission_stop = { state: "unavailable", command: "unavailable", origin: "unknown" };
    const paths: string[] = [], bodies: unknown[] = [];
    const deps = makeDeps({ status: 200, data: { ...STATUS, permission_stop } }, paths, bodies);
    const result = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "status", "dev-impl@seat-rig", "--json",
    ]).then(() => undefined));
    expect(JSON.parse(result.logs.join(""))).toEqual({ ...STATUS, permission_stop });
    expect(result.exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/status/dev-impl%40seat-rig"]);
    expect(bodies).toEqual([]);
  });

  it("renders suggested rules as escaped data while JSON decodes to the unchanged evidence", async () => {
    const ruleContent = "  SYNTHETIC_RULE\u001b[31m\u0000\t\n\r\u0085\u009b\u2028\u2029\u202e\u2066\u034f\u200d\ufeff\u{e0001} ";
    const entry = { type: "removeRules", rules: [{ toolName: "Bash\u001b[0m\u202e", ruleContent }, { toolName: "Read" },
      { toolName: "Edit", ruleContent: "" }], behavior: "deny", destination: "userSettings" };
    const permission_stop = { state: "request_observed", command: "Tool: Read", origin: "harness", source: "PermissionRequest",
      observed_at: "2026-11-05T01:00:00.000Z", actor: "main", pending: "unknown",
      suggested_rules: { state: "present", entries: [entry], unsupported: false, size_cut: false } };
    const paths: string[] = [], bodies: unknown[] = [];
    const deps = makeDeps({ status: 200, data: { ...STATUS, permission_stop } }, paths, bodies);
    const human = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]).then(() => undefined));
    expect(human.logs).toContain("  Claude's suggested rules: read-only evidence; not applied or approved, effectiveness unknown.");
    expect(human.logs).toContain("  These are neither the exact command nor a complete list of dialog options.");
    const data = human.logs.find(line => line.startsWith("  {"))!;
    expect(data).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u);
    expect(JSON.parse(data.trim())).toEqual(entry);
    const json = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig", "--json"]).then(() => undefined));
    expect(json.logs.join("")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u);
    expect(JSON.parse(json.logs.join(""))).toEqual({ ...STATUS, permission_stop });
    expect(bodies).toEqual([]);
  });

  it.each([
    [undefined, "  Suggested-rule evidence: unavailable."],
    [{ state: "missing", entries: [], unsupported: false, size_cut: false }, "  Suggested-rule field: missing from the observed hook."],
    [{ state: "present", entries: [], unsupported: false, size_cut: false }, "  Supported suggested-rule entries: empty."],
    [{ state: "present", entries: [], unsupported: true, size_cut: false }, "  Unsupported or malformed suggested-rule evidence was withheld."],
    [{ state: "present", entries: [], unsupported: false, size_cut: true }, "  Suggested-rule evidence is incomplete because of size bounds."],
  ])("labels missing, empty and incomplete suggestion evidence honestly (case %#)", async (suggested_rules, expected) => {
    const permission_stop = { state: "request_observed", command: "Tool: Read", origin: "harness", source: "PermissionRequest",
      observed_at: "2026-11-05T01:00:00.000Z", actor: "main", pending: "unknown", suggested_rules };
    const paths: string[] = [], bodies: unknown[] = [];
    const deps = makeDeps({ status: 200, data: { ...STATUS, permission_stop } }, paths, bodies);
    const output = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]).then(() => undefined));
    expect(output.logs).toContain(expected);
    expect(bodies).toEqual([]);
  });

  it("identifies the account home selected by a switch rather than the native default", async () => {
    const deps = makeDeps({ status: 200, data: { ...STATUS, runtime_home: {
      variable: "CODEX_HOME", home: "/accounts/api", source: "account-switch",
    } } }, []);
    const result = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]).then(() => undefined));
    expect(result.logs.join("\n")).toContain("/accounts/api (the seat's selected account home;");
    expect(result.logs.join("\n")).not.toContain("the native default");
  });

  it("#3253: prints where the seat's process limits stand, from the readback", async () => {
    const applied = { state: "applied", requested: { tasksMax: 512 }, pidsMax: "512", pidsCurrent: 37, limitHits: 2,
      scope: "openrig-seat-worker_test-1a2b3c4d.scope" };
    const deps = makeDeps({ status: 200, data: { ...STATUS, processLimits: applied } }, []);
    const result = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(result.logs).toContain("Process limits: tasks_max 512: applied (pids.max 512, current 37, limit hit 2 times)");
    const notApplied = { state: "not_applied", requested: { tasksMax: 512 }, reason: "the seat is not running; the limit applies at its next fresh launch" };
    const deps2 = makeDeps({ status: 200, data: { ...STATUS, processLimits: notApplied } }, []);
    const result2 = await captureLogs(() => makeCommand(deps2).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(result2.logs).toContain("Process limits: tasks_max 512: requested, not applied; the seat is not running; the limit applies at its next fresh launch");
    // A stored value that can't be read: this seat's line, with no tasks_max to show.
    const invalid = { state: "invalid", reason: "Seat n process_limits: stored value is not valid JSON; the stored value is kept" };
    const deps4 = makeDeps({ status: 200, data: { ...STATUS, processLimits: invalid } }, []);
    const result4 = await captureLogs(() => makeCommand(deps4).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(result4.logs).toContain("Process limits: process_limits: stored value invalid; Seat n process_limits: stored value is not valid JSON; the stored value is kept");
    // Which process the status read.
    const fallback = { ...applied, readFrom: "the session's active pane (no pane is recorded for the seat)" };
    const deps6 = makeDeps({ status: 200, data: { ...STATUS, processLimits: fallback } }, []);
    const result6 = await captureLogs(() => makeCommand(deps6).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(result6.logs).toContain("Process limits: tasks_max 512: applied (pids.max 512, current 37, limit hit 2 times) " +
      "(read from the session's active pane (no pane is recorded for the seat))");
    // Without limits, no line.
    const deps3 = makeDeps({ status: 200, data: STATUS }, []);
    const result3 = await captureLogs(() => makeCommand(deps3).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(result3.logs.join("\n")).not.toContain("Process limits");
  });

  it("#3253: prints a memory_max request as a size and its readback apart from the pids one", async () => {
    const status = async (processLimits: Record<string, unknown>) => (await captureLogs(() => makeCommand(makeDeps({ status: 200,
      data: { ...STATUS, processLimits } }, [])).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined))).logs;
    expect(await status({ state: "applied", requested: { memoryMax: 4294967296 }, memoryMax: "4294967296", memoryCurrent: 52428800,
      memoryLimitHits: 4, oomKills: 1, scope: "openrig-seat-worker_test-1a2b3c4d.scope" }))
      .toContain("Process limits: memory_max 4G: applied (memory.max 4294967296, current 52428800, at the limit 4 times, OOM kills 1)");
    expect(await status({ state: "applied", requested: { tasksMax: 512, memoryMax: 1610612736 }, pidsMax: "512", pidsCurrent: 37,
      limitHits: 2, memoryMax: "1610612736", memoryCurrent: 1048576, memoryLimitHits: 0, oomKills: 0 }))
      .toContain("Process limits: tasks_max 512, memory_max 1536M: applied (pids.max 512, current 37, limit hit 2 times) " +
        "(memory.max 1610612736, current 1048576, at the limit 0 times, OOM kills 0)");
    expect(await status({ state: "not_applied", requested: { memoryMax: 16777216 + 2 ** 30 },
      reason: "the seat is not running; the limit applies at its next fresh launch" }))
      .toContain("Process limits: memory_max 1040M: requested, not applied; the seat is not running; the limit applies at its next fresh launch");
  });

  it("prints the daemon's managed restore delivery failure", async () => {
    const detail = "OpenRig owes its turn boundary. Last delivery: target_activity_unknown; no_activity_signal.";
    const deps = makeDeps({ status: 200, data: { ...STATUS, compaction: { stage: "compacting", detail } } }, []);
    const result = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(result.logs).toContain(`Managed compaction (compacting): ${detail}`);
  });

  it("keeps the legacy on prefix when status reports hold", async () => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: { ...STATUS, typingGuard: { desired: true, effective: true, effectiveMode: "hold", pending: false, heldCount: 0 } } }, paths);
    const status = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(status.logs.join("\n")).toContain("Typing guard: on (hold)");
  });

  it("sets a level through the same control, and status names it with what types and what's held", async () => {
    const paths: string[] = [], bodies: unknown[] = [];
    const set = makeDeps({ status: 200, data: { effectiveMode: "hold", effectiveLevel: "urgent-only", pending: false } }, paths, bodies);
    await captureLogs(() => makeCommand(set).parseAsync(["node", "rig", "seat", "set-typing-guard", "worker@test",
      "--mode", "urgent-only", "--reason", "reviewing by hand", "--json"]).then(() => undefined));
    expect(bodies).toEqual([{ mode: "urgent-only", reason: "reviewing by hand" }]);
    const deps = makeDeps({ status: 200, data: { ...STATUS, typingGuard: { desired: true, effective: true, effectiveMode: "hold", effectiveLevel: "urgent-only", pending: false, heldCount: 2 } } }, []);
    const status = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(status.logs.join("\n")).toContain("Typing guard: urgent-only; 2 retained\nOnly messages marked urgent type. Other automatic input is held, readable with rig seat held-messages dev-impl@seat-rig.");
  });

  it("sets queue-only through the same control, and status says deliberate sends type and OpenRig's reminders queue (#3076)", async () => {
    const paths: string[] = [], bodies: unknown[] = [];
    const set = makeDeps({ status: 200, data: { effectiveMode: "hold", effectiveLevel: "queue-only", pending: false } }, paths, bodies);
    const result = await captureLogs(() => makeCommand(set).parseAsync(["node", "rig", "seat", "set-typing-guard", "worker@test",
      "--mode", "queue-only", "--reason", "I type in this terminal", "--json"]).then(() => undefined));
    expect(result.exitCode).toBeUndefined();
    expect(bodies).toEqual([{ mode: "queue-only", reason: "I type in this terminal" }]);
    const deps = makeDeps({ status: 200, data: { ...STATUS, typingGuard: { desired: true, effective: true, effectiveMode: "hold", effectiveLevel: "queue-only", pending: false, heldCount: 0 } } }, []);
    const status = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(status.logs.join("\n")).toContain("Typing guard: queue-only");
    expect(status.logs.join("\n")).toContain("Deliberate sends type, never over a draft; OpenRig's reminders arrive as queue rows, never typed.");
  });

  it("sends draft-aware mode through the existing control", async () => {
    const paths: string[] = [], bodies: unknown[] = [];
    const deps = makeDeps({ status: 200, data: { effectiveMode: "draft-aware", pending: false } }, paths, bodies);
    const result = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "set-typing-guard", "worker@test",
      "--mode", "draft-aware", "--reason", "keep my draft", "--json"]).then(() => undefined));
    expect(result.exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/set-typing-guard/worker%40test"]);
    expect(bodies).toEqual([{ mode: "draft-aware", reason: "keep my draft" }]);
    expect(JSON.parse(result.logs.join(""))).toMatchObject({ effectiveMode: "draft-aware" });
  });

  it.each([["--mode", "typo"]])("rejects invalid %s %s before requesting a change", async (flag, value) => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: {} }, paths);
    const result = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "set-typing-guard", "worker@test",
      "--mode", "draft-aware", "--reason", "draft", flag, value]).then(() => undefined));
    expect(result.exitCode).toBe(1); expect(paths).toEqual([]);
  });

  it.each(["true", "false"])("keeps --enabled %s compatible with the existing endpoint", async enabled => {
    const paths: string[] = [], bodies: unknown[] = [];
    const deps = makeDeps({ status: 200, data: {} }, paths, bodies);
    await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "set-typing-guard", "worker@test",
      "--enabled", enabled, "--reason", "existing workflow"]).then(() => undefined));
    expect(paths).toEqual(["/api/seat/set-typing-guard/worker%40test"]);
    expect(bodies).toEqual([{ enabled: enabled === "true", reason: "existing workflow" }]);
  });

  it.each([{ selectors: [] }, { selectors: ["--mode", "hold", "--enabled", "true"] }])("requires exactly one selector: $selectors", async ({ selectors }) => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: {} }, paths);
    const result = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "set-typing-guard", "worker@test",
      "--reason", "draft", ...selectors]).then(() => undefined));
    expect(result.exitCode).toBe(1); expect(paths).toEqual([]);
  });

  it("prints requested/effective activation and immediate send behavior in seat status", async () => {
    const paths: string[] = [];
    const typingGuard = { desired: true, effective: false, desiredMode: "hold", effectiveMode: "draft-aware", pending: true, heldCount: 1 };
    const deps = makeDeps({ status: 200, data: { ...STATUS, typingGuard } }, paths);
    const status = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "worker@test"]).then(() => undefined));
    expect(status.logs.join("\n")).toContain("Typing guard: draft-aware (activation pending; requested hold)");
    expect(status.logs.join("\n")).toContain("Draft-aware sends return immediately");
    expect(paths.at(-1)).toBe("/api/seat/status/worker%40test");
  });
});

const HANDOVER_PLAN = {
  ok: true,
  dryRun: true,
  willMutate: false,
  seat: {
    ref: "dev-impl@seat-rig",
    rigId: "rig-1",
    rigName: "seat-rig",
    logicalId: "dev.impl",
    podId: "pod-1",
    podNamespace: "dev",
    runtime: "codex",
  },
  source: { mode: "fresh", ref: null, raw: "fresh", defaulted: true },
  reason: "context-wall",
  operator: "orch-lead@seat-rig",
  currentOccupant: "dev-impl@seat-rig",
  currentStatus: {
    sessionStatus: "running",
    startupStatus: "ready",
    occupantLifecycle: "active",
    continuityOutcome: null,
    handoverResult: null,
    previousOccupant: null,
    handoverAt: null,
    restoreOutcome: "n-a",
  },
  phases: [
    {
      id: "prepare",
      title: "Phase A - prepare successor with seat binding unchanged",
      bindingUnchangedUntilComplete: true,
      steps: [
        { id: "validate-seat", title: "Validate seat", description: "Confirm the seat exists.", willMutate: false },
        { id: "create-successor", title: "Create successor occupant", description: "Would create successor.", willMutate: false },
      ],
    },
    {
      id: "commit",
      title: "Phase B - commit atomic seat rebind after successor readiness",
      bindingUnchangedUntilComplete: false,
      steps: [
        { id: "rebind-seat", title: "Rebind seat", description: "Would rebind seat.", willMutate: false },
        { id: "record-provenance", title: "Record provenance", description: "Would record provenance.", willMutate: false },
      ],
    },
  ],
};

const HANDOVER_RESULT = {
  ok: true,
  dryRun: false,
  mutated: true,
  continuityTransferred: false,
  seat: {
    ref: "dev-impl@seat-rig",
    rigId: "rig-1",
    rigName: "seat-rig",
    logicalId: "dev.impl",
    podId: "pod-1",
    podNamespace: "dev",
    runtime: "codex",
  },
  source: { mode: "discovered", ref: "disc-1", raw: "discovered:disc-1", defaulted: false },
  reason: "mvp-proof",
  operator: "orch-lead@seat-rig",
  previousOccupant: "dev-impl@seat-rig",
  currentOccupant: "successor-session",
  previousSessionIdsSuperseded: ["sess-old"],
  newSessionId: "sess-new",
  discovery: { id: "disc-1", status: "claimed", tmuxSession: "successor-session", tmuxPane: "%1" },
  currentStatus: {
    sessionStatus: "running",
    startupStatus: "ready",
    occupantLifecycle: "active",
    continuityOutcome: null,
    handoverResult: "complete",
    previousOccupant: "dev-impl@seat-rig",
    handoverAt: "2026-04-24T18:30:00.000Z",
    restoreOutcome: "n-a",
  },
  handoverAt: "2026-04-24T18:30:00.000Z",
  eventSeq: 42,
  sideEffects: {
    departingSessionKilled: false,
    departingProcess: "not-touched",
    startupContextDelivered: false,
    provenanceRecordWritten: true,
  },
};

const HANDOVER_RESULT_FRESH = {
  ...HANDOVER_RESULT,
  source: { mode: "fresh", ref: null, raw: "fresh", defaulted: true },
  currentOccupant: "dev-impl@seat-rig-h1SUCCID0",
  discovery: { id: "disc-fresh", status: "claimed", tmuxSession: "dev-impl@seat-rig-h1SUCCID0", tmuxPane: "%9" },
  sideEffects: {
    departingSessionKilled: false,
    departingProcess: "ended-graceful",
    startupContextDelivered: true,
    provenanceRecordWritten: true,
  },
};

const FRESH_LAUNCH_RESULT = {
  ok: true,
  seat: HANDOVER_PLAN.seat,
  status: "ready",
  sessionName: "dev-impl@seat-rig",
  sessionId: "sess-fresh",
  generation: "gen-fresh",
  model: "gpt-5.6-codex",
  startupPolicyHash: "policy-hash",
  supersededSessionIds: ["sess-old"],
};

describe("rig seat status", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prints stable JSON and URL-encodes canonical seat refs", async () => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: STATUS }, paths);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig", "--json"]);
    });

    expect(exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/status/dev-impl%40seat-rig"]);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      current_occupant: "dev-impl@seat-rig",
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: null,
      previous_occupant: null,
      handover_at: null,
    });
  });

  it("prints concise human output without claiming a handover happened", async () => {
    const deps = makeDeps({ status: 200, data: STATUS }, []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Occupant lifecycle: active");
    expect(output).toContain("Continuity outcome: unverified");
    expect(output).toContain("Handover result: none");
    expect(output).toContain("Previous occupant: none");
  });

  it("prints the planned permission account as planned, with its unknowns and the controls, in place of the old mode line", async () => {
    const account = {
      summary: "Next launch: --permission-mode acceptEdits, from OpenRig's team default (no policy or seat choice is recorded); OpenRig adds 2 allowances and asks before 1 lifecycle commands.",
      overrides: [], unknown: ["Whether the harness applies this is unverified until a launch."],
      openRigAdds: { claudeAllow: ["Read(./**)", "Bash(rig:*)"], claudeAsk: ["Bash(rig up:*)"], notes: ["A hook asks before the listed lifecycle commands."] },
      controls: ['rig seat set-permissions dev-impl@seat-rig --mode <mode> --reason "<why>"'],
    };
    const deps = makeDeps({ status: 200, data: { ...STATUS, permissions: { selectionState: "inherit", desired: null, lastLaunchArguments: { value: "--permission-mode acceptEdits" }, nativeEffect: "unverified", account } } }, []);

    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("Permissions, planned for the next fresh managed launch (not observed):");
    expect(output).toContain(`  ${account.summary}`);
    expect(output).toContain("  The exact allowance and ask lists are in --json, under permissions.account.openRigAdds.");
    expect(output).toContain("  Last launch arguments (observed): --permission-mode acceptEdits");
    expect(output).toContain("  Unknown: Whether the harness applies this is unverified until a launch.");
    expect(output).toContain('    rig seat set-permissions dev-impl@seat-rig --mode <mode> --reason "<why>"');
    expect(output).not.toContain("Permission mode for future launches");
  });

  it("prints the saved auto mode block against the last launch's, with its notes and warnings", async () => {
    const account = { summary: "Next launch: --permission-mode auto.", overrides: [], unknown: [], openRigAdds: { claudeAllow: [], claudeAsk: [], notes: [] }, controls: [] };
    const claudeAutoMode = {
      saved: { state: "recorded", block: { environment: ["$defaults", "x"], soft_deny: ["only"], classifyAllShell: true } },
      lastLaunch: { state: "unknown" }, matchesLastLaunch: null,
      notes: ["Claude adds these entries to your user and managed auto mode settings; OpenRig doesn't read or change those."],
      advisories: ['claude_auto_mode.soft_deny: without "$defaults", this list replaces Claude\'s built-in soft_deny entries'],
      inspect: "claude --settings '{}' auto-mode config",
    };
    const deps = makeDeps({ status: 200, data: { ...STATUS, permissions: { selectionState: "inherit", desired: null, lastLaunchArguments: null, nativeEffect: "unverified", account, claudeAutoMode } } }, []);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("  Claude auto mode block (saved): environment 2 (with $defaults), soft_deny 1, classifyAllShell true");
    expect(output).toContain("  Claude auto mode block (last launch, observed): unknown; unknown whether it matches saved");
    expect(output).toContain(`  ${claudeAutoMode.notes[0]}`);
    expect(output).toContain(`  Warning: ${claudeAutoMode.advisories[0]}`);
    expect(output).toContain("  Effective lists where you run it: claude --settings '{}' auto-mode config");
  });

  it("prints a saved auto mode block that can't be read as unavailable, with an unknown comparison", async () => {
    const claudeAutoMode = { saved: { state: "unavailable", error: "Seat n1: the saved claude_auto_mode can't be read" },
      lastLaunch: { state: "none" }, matchesLastLaunch: null, notes: [], advisories: [] };
    const deps = makeDeps({ status: 200, data: { ...STATUS, permissions: { selectionState: "inherit", desired: null, lastLaunchArguments: null, nativeEffect: "unverified", claudeAutoMode } } }, []);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("  Claude auto mode block (saved): unavailable: Seat n1: the saved claude_auto_mode can't be read");
    expect(output).toContain("  Claude auto mode block (last launch, observed): none; unknown whether it matches saved");
  });

  it("prints a launch that read --settings from a file as unknown, with nothing saved", async () => {
    const claudeAutoMode = { saved: { state: "none" }, lastLaunch: { state: "unknown", reason: "settings_file" }, matchesLastLaunch: null, notes: [], advisories: [] };
    const deps = makeDeps({ status: 200, data: { ...STATUS, permissions: { selectionState: "inherit", desired: null, lastLaunchArguments: null, nativeEffect: "unverified", claudeAutoMode } } }, []);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });
    expect(logs.join("\n")).toContain("  Claude auto mode block (last launch, observed): unknown (that launch read --settings from a file OpenRig can't check); unknown whether it matches saved");
  });

  it("prints each advisory the account carries, after the summary", async () => {
    const advisory = 'Claude Code answers plan-mode turns with Sonnet when the model is the alias "haiku". To keep Haiku, set a full Haiku model id: '
      + 'rig seat set-model dev-impl@seat-rig --model <full Haiku id> --reason "<why>".';
    const account = { summary: "Next launch: --permission-mode plan, from this seat's own choice (person@host: careful review).",
      overrides: [], unknown: [], openRigAdds: { claudeAllow: [], claudeAsk: [], notes: [] }, controls: [], advisories: [advisory] };
    const deps = makeDeps({ status: 200, data: { ...STATUS, permissions: { selectionState: "explicit", desired: null, lastLaunchArguments: null, nativeEffect: "unverified", account } } }, []);

    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });

    const lines = logs.join("\n").split("\n");
    const summaryAt = lines.indexOf(`  ${account.summary}`);
    expect(summaryAt).toBeGreaterThan(-1);
    expect(lines[summaryAt + 1]).toBe(`  ${advisory}`);
  });

  it.each([
    ["session_missing", "tmux session missing; restore or relaunch the seat"],
    ["session_missing_tmux_unavailable", "tmux session last observed missing; latest tmux reading unavailable; restore or relaunch the seat"],
  ])("explains a confirmed missing tmux session: %s", async (reason, explanation) => {
    const deps = makeDeps({
      status: 200,
      data: { ...STATUS, session_status: "detached", session_reason: reason },
    }, []);

    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });

    expect(logs.join("\n")).toContain(`Reason: ${explanation}`);
  });

  // #3185 (C14 native): a bare shell's session record stayed running, so seat status said running while rig ps said att.
  it.each([
    [{ lifecycle_state: "attention_required" }, "Session: needs attention (its session record is running; rig ps shows it as att)"],
    [{ lifecycle_state: "running" }, "Session: running"],
    [{}, "Session: running"],
  ])("says a seat rig ps shows as att needs attention, never running (case %#)", async (extra, expected) => {
    const deps = makeDeps({ status: 200, data: { ...STATUS, ...extra } }, []);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "dev-impl@seat-rig"]);
    });
    expect(logs).toContain(expected);
  });

  it("returns a nonzero status for an unknown seat", async () => {
    const deps = makeDeps({
      status: 404,
      data: {
        ok: false,
        code: "seat_not_found",
        message: "Seat \"missing@seat-rig\" not found",
        guidance: "List seats with: rig ps --nodes",
      },
    }, []);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "status", "missing@seat-rig"]);
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Seat \"missing@seat-rig\" not found");
    expect(errors.join("\n")).toContain("List seats with: rig ps --nodes");
  });

  it("launch --fresh posts the explicit no-continuity contract and prints stable JSON", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const deps = makeDeps({ status: 200, data: FRESH_LAUNCH_RESULT }, paths, bodies);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "launch", "dev-impl@seat-rig",
        "--fresh", "--stop", "--reason", "deliberate blank restart",
        "--operator", "orch-lead@seat-rig", "--json",
      ]);
    });

    expect(exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/launch/dev-impl%40seat-rig"]);
    expect(bodies).toEqual([{
      fresh: true,
      reason: "deliberate blank restart",
      stop: true,
      operator: "orch-lead@seat-rig",
    }]);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      status: "ready",
      generation: "gen-fresh",
      startupPolicyHash: "policy-hash",
    });
  });

  it("launch requires --fresh before contacting the daemon", async () => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: FRESH_LAUNCH_RESULT }, paths);
    let refusal: unknown;

    await captureLogs(async () => {
      const command = makeCommand(deps);
      const seat = command.commands.find((candidate) => candidate.name() === "seat")!;
      seat.commands.find((candidate) => candidate.name() === "launch")!.exitOverride();
      try {
        await command.parseAsync([
          "node", "rig", "seat", "launch", "dev-impl@seat-rig",
          "--reason", "deliberate blank restart",
        ]);
      } catch (error) {
        refusal = error;
      }
    });

    expect(paths).toEqual([]);
    expect(refusal).toMatchObject({
      code: "commander.missingMandatoryOptionValue",
      message: expect.stringContaining("required option '--fresh' not specified"),
    });
  });

  it("launch human output states fresh identity and preserved durable work", async () => {
    const deps = makeDeps({ status: 200, data: FRESH_LAUNCH_RESULT }, []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "launch", "dev-impl@seat-rig",
        "--fresh", "--reason", "deliberate blank restart",
      ]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Fresh occupant ready: dev.impl@seat-rig (dev-impl@seat-rig)");
    expect(output).toContain("Generation: gen-fresh; model: gpt-5.6-codex");
    expect(output).toContain("No continuity source was used; siblings and durable work were preserved.");
  });

  it("launch waits for a ready response beyond the default five-second timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(FRESH_LAUNCH_RESULT)), 6_000);
      init!.signal!.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init!.signal!.reason);
      }, { once: true });
    }));
    const deps = makeDeps({ status: 200, data: FRESH_LAUNCH_RESULT }, []);
    deps.clientFactory = url => new DaemonClient(url, { fetchImpl });
    const result = captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "launch", "dev-impl@seat-rig",
      "--fresh", "--stop", "--reason", "deliberate blank restart", "--json",
    ]).then(() => undefined)).catch(error => ({ error }));

    await vi.advanceTimersByTimeAsync(6_000);

    const output = await result;
    expect(output).toMatchObject({ errors: [], exitCode: undefined });
    if (!("logs" in output)) throw output.error;
    expect(JSON.parse(output.logs.join("\n"))).toMatchObject({ status: "ready", generation: "gen-fresh" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([false, true].flatMap(json => [false, true].map(plan => ({ json, plan }))))("launch reports an unknown outcome without retrying on timeout (%j)", async ({ json, plan }) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const deps = makeDeps({ status: 200, data: FRESH_LAUNCH_RESULT }, []);
    deps.clientFactory = url => new DaemonClient(url, { fetchImpl });
    const result = captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "launch", "dev-impl@seat-rig",
      "--fresh", "--stop", "--reason", "deliberate blank restart", ...(json ? ["--json"] : []), ...(plan ? ["--plan"] : []),
    ]).then(() => undefined)).catch(error => ({ error }));

    await vi.advanceTimersByTimeAsync(120_000);

    const output = await result;
    expect(output).toMatchObject({ exitCode: 1 });
    if (!("logs" in output)) throw output.error;
    if (json) {
      expect(output.errors).toEqual([]);
      expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
        status: "unknown",
        code: plan ? "launch_plan_timeout" : "launch_outcome_unknown",
        guidance: expect.stringContaining(plan ? "Retry the preview" : "rig seat status dev-impl@seat-rig"),
      });
    } else {
      expect(output.logs).toEqual([]);
      expect(output.errors.join("\n")).toContain(plan ? "no launch was requested" : "may still be in progress");
      expect(output.errors.join("\n")).toContain(plan ? "Retry the preview" : "rig seat status dev-impl@seat-rig");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("default-path continue reports an unknown outcome without retrying on timeout (json=%s)", async json => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const deps = makeDeps({ status: 200, data: FRESH_LAUNCH_RESULT }, []);
    deps.clientFactory = url => new DaemonClient(url, { fetchImpl });
    const result = captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "continue", "dev-impl@seat-rig", ...(json ? ["--json"] : []),
    ]).then(() => undefined)).catch(error => ({ error }));

    await vi.advanceTimersByTimeAsync(120_000);

    const output = await result;
    expect(output).toMatchObject({ exitCode: 1 });
    if (!("logs" in output)) throw output.error;
    if (json) {
      expect(output.errors).toEqual([]);
      expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
        status: "unknown",
        code: "continue_outcome_unknown",
        guidance: expect.stringContaining("rig seat status dev-impl@seat-rig"),
      });
    } else {
      expect(output.logs).toEqual([]);
      expect(output.errors.join("\n")).toContain("may still be in progress");
      expect(output.errors.join("\n")).toContain("rig seat status dev-impl@seat-rig");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("handover --dry-run --json prints the stable planner shape", async () => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: HANDOVER_PLAN }, paths);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--reason", "context-wall",
        "--operator", "orch-lead@seat-rig",
        "--dry-run",
        "--json",
      ]);
    });

    expect(exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/handover/dev-impl%40seat-rig"]);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toMatchObject({
      ok: true,
      dryRun: true,
      willMutate: false,
      source: { mode: "fresh", ref: null, defaulted: true },
      reason: "context-wall",
      operator: "orch-lead@seat-rig",
      currentOccupant: "dev-impl@seat-rig",
      currentStatus: { sessionStatus: "running", startupStatus: "ready" },
    });
    expect(parsed.phases.map((phase: { id: string }) => phase.id)).toEqual(["prepare", "commit"]);
  });

  it("handover human dry-run output says no changes were made", async () => {
    const deps = makeDeps({ status: 200, data: HANDOVER_PLAN }, []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--reason", "context-wall",
        "--dry-run",
      ]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Seat handover dry run: dev-impl@seat-rig");
    expect(output).toContain("Phase A - prepare successor");
    expect(output).toContain("Phase B - commit atomic seat rebind");
    expect(output).toContain("No changes were made.");
  });

  it("handover requires --reason before contacting the daemon", async () => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: HANDOVER_PLAN }, paths);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--dry-run"]);
    });

    expect(exitCode).toBe(2);
    expect(paths).toEqual([]);
    expect(errors.join("\n")).toContain("Missing required option: --reason <reason>");
  });

  it("handover unknown seat prints inventory guidance", async () => {
    const deps = makeDeps({
      status: 404,
      data: {
        ok: false,
        code: "seat_not_found",
        message: "Seat \"missing@seat-rig\" not found",
        guidance: "List seats with: rig ps --nodes",
      },
    }, []);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "missing@seat-rig",
        "--reason", "context-wall",
        "--dry-run",
      ]);
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Seat \"missing@seat-rig\" not found");
    expect(errors.join("\n")).toContain("List seats with: rig ps --nodes");
  });

  it("#3253: a plain handover successor_create_failed names the process-limit notice once", async () => {
    const deps = makeDeps({
      status: 500,
      data: {
        ok: false,
        code: "successor_create_failed",
        message: "Handover failed at step \"create-successor\": harness not interactive",
        guidance: "The seat's registry binding is unchanged.",
        processLimits: { state: "not_applied", kind: "unverified", reason: "the user manager timed out", retryable: true,
          requested: { tasksMax: 256 } },
      },
    }, []);
    const { errors } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "impl@seat-rig", "--reason", "context-wall"]);
    });
    const out = errors.join("\n");
    expect(out.match(/the user manager timed out/g)).toHaveLength(1);
    expect(out).toContain("Process limits: tasks_max 256: requested, not applied");
  });

  it("#3253: a plain handover failure after a recovery launch without the limit names the process-limit notice", async () => {
    const deps = makeDeps({
      status: 500,
      data: {
        ok: false,
        code: "context_delivery_failed",
        message: "Handover failed at step \"deliver-restore-packet\": the pane did not accept the packet",
        guidance: "The successor candidate was unwound and the seat's binding is unchanged.",
        processLimits: { state: "not_applied", kind: "unverified", reason: "the user manager timed out", retryable: true,
          requested: { tasksMax: 256 } },
      },
    }, []);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "impl@seat-rig", "--reason", "context-wall"]);
    });

    expect(exitCode).toBeGreaterThan(0);
    const out = errors.join("\n");
    expect(out).toContain("Handover failed at step");
    expect(out).toContain("Process limits: tasks_max 256: requested, not applied");
    expect(out).toContain("unverified: the user manager timed out");
  });

  it("#3253: a handover failure names a memory_max request in the process-limit notice", async () => {
    const deps = makeDeps({
      status: 500,
      data: {
        ok: false,
        code: "successor_create_failed",
        message: "Handover failed at step \"create-successor\": harness not interactive",
        guidance: "The seat's registry binding is unchanged.",
        processLimits: { state: "not_applied", kind: "unsupported", limit: "memory_max", retryable: false,
          reason: "a throwaway seat scope has no memory.max: the memory controller is not delegated to the user manager",
          requested: { tasksMax: 256, memoryMax: 4294967296 } },
      },
    }, []);
    const { errors } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "impl@seat-rig", "--reason", "context-wall"]);
    });
    expect(errors.join("\n")).toContain("Process limits: tasks_max 256, memory_max 4G: requested, not applied");
  });

  it("handover non-dry-run JSON prints mutation result for discovered source", async () => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: HANDOVER_RESULT }, paths);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--source", "discovered:disc-1",
        "--reason", "mvp-proof",
        "--operator", "orch-lead@seat-rig",
        "--json",
      ]);
    });

    expect(exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/handover/dev-impl%40seat-rig"]);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toMatchObject({
      ok: true,
      dryRun: false,
      mutated: true,
      continuityTransferred: false,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "successor-session",
      currentStatus: { handoverResult: "complete" },
      sideEffects: {
        departingSessionKilled: false,
        departingProcess: "not-touched",
        startupContextDelivered: false,
        provenanceRecordWritten: true,
      },
    });
  });

  it.each([false, true])("shows an unverified rebuild permission fallback (json=%s)", async json => {
    const permissions = { state: "unverified", detail: "No complete native policy was observed; existing launch behaviour was used. Permissions were not verified or carried." };
    const response = { ...HANDOVER_RESULT, source: { mode: "rebuild", raw: "rebuild" },
      sourceOutcome: { mode: "rebuild", primedArtifacts: [], gaps: [], permissions } };
    const deps = makeDeps({ status: 200, data: response }, []);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--source", "rebuild", "--reason", "rebuild", ...(json ? ["--json"] : [])]);
    });
    expect(exitCode).toBeUndefined();
    if (json) expect(JSON.parse(logs.join("\n")).sourceOutcome.permissions).toEqual(permissions);
    else expect(logs.join("\n")).toContain(`Codex rebuild permissions: unverified. ${permissions.detail}`);
  });

  it.each([[false, "chosen-model"], [false, null], [true, "chosen-model"], [true, null]] as const)(
    "reports rebuild model selection without a native comparison (json=%s, model=%s)", async (json, requested) => {
      const model = { requested, predecessorCompared: false };
      const response = { ...HANDOVER_RESULT, source: { mode: "rebuild", raw: "rebuild" },
        sourceOutcome: { mode: "rebuild", primedArtifacts: [], gaps: [], model } };
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCommand(makeDeps({ status: 200, data: response }, [])).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig",
          "--source", "rebuild", "--reason", "context wall", ...(json ? ["--json"] : [])]);
      });
      expect(exitCode).toBeUndefined();
      if (json) expect(JSON.parse(logs.join("\n")).sourceOutcome.model).toEqual(model);
      else {
        expect(logs.join("\n")).toContain("Rebuild starts a new conversation; durable artifacts carry its context, not a native resume.");
        expect(logs.join("\n")).toContain(requested ? `Codex rebuild model: requested ${requested}` : "Codex rebuild model: runtime configuration/default");
        expect(logs.join("\n")).toContain("The predecessor's in-pane model was not compared or carried.");
      }
    });

  it("handover --recover posts to the recovery route with the reason and prints the adoption (#2985)", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const recovered = { ...HANDOVER_RESULT, source: { mode: "rebuild", ref: null, raw: "rebuild", defaulted: false },
      recoveredFrom: { attemptId: "a1", failedStep: "start_agent", failureCode: "successor_not_ready", failedAt: "2026-11-10T16:21:34.000Z" },
      sideEffects: { ...HANDOVER_RESULT.sideEffects, departingProcess: "ended-graceful", startupContextDelivered: false } };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(makeDeps({ status: 200, data: recovered }, paths, bodies)).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig", "--recover", "--reason", "adopt the running successor"]);
    });
    expect(exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/handover/dev-impl%40seat-rig/recover"]);
    expect(bodies).toEqual([{ reason: "adopt the running successor", operator: undefined }]);
    const output = logs.join("\n");
    expect(output).toContain('Adopted the running successor of the handover that failed at "start_agent" (successor_not_ready, 2026-11-10T16:21:34.000Z); its conversation was kept and nothing was typed into its pane.');
    expect(output).toContain("The context packet that handover didn't deliver was not delivered now either");
    expect(output).not.toContain("OpenRig delivered no startup context and carried no conversation: the discovered successor was already running.");
  });

  it("handover --recover takes no --source or --dry-run and does not contact the daemon", async () => {
    for (const extra of [["--source", "rebuild"], ["--dry-run"]]) {
      const paths: string[] = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCommand(makeDeps({ status: 200, data: HANDOVER_RESULT }, paths)).parseAsync([
          "node", "rig", "seat", "handover", "dev-impl@seat-rig", "--recover", "--reason", "adopt", ...extra, "--json"]);
      });
      expect(exitCode).toBe(2);
      expect(paths).toEqual([]);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: false, code: "invalid_options" });
    }
  });

  it("handover non-dry-run human output avoids continuity claims (discovered, no context delivery)", async () => {
    const deps = makeDeps({ status: 200, data: HANDOVER_RESULT }, []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--source", "discovered:disc-1",
        "--reason", "mvp-proof",
      ]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Seat handover complete: dev-impl@seat-rig");
    expect(output).toContain("Source: discovered:disc-1");
    expect(output).toContain("Previous occupant: dev-impl@seat-rig");
    expect(output).toContain("Current occupant: successor-session");
    expect(output).toContain("Seat binding and inventory provenance were updated.");
    // The receipt's side effects, as they happened: the lineage record written, the old process left alone.
    expect(output).toContain("The handover's lineage record (occupant tenure) was written.");
    expect(output).toContain("The previous occupant's process wasn't touched: the successor was an existing session.");
    // startupContextDelivered:false — the output says nothing was delivered or carried...
    expect(output).toContain("OpenRig delivered no startup context and carried no conversation: the discovered successor was already running.");
    // ...and must NOT falsely claim a delivery happened.
    expect(output).not.toContain("restore packet) was delivered");
  });

  it("handover human output says when the lineage record wasn't written, and that the old process was killed (rebuild)", async () => {
    const deps = makeDeps({ status: 200, data: { ...HANDOVER_RESULT, source: { mode: "rebuild", raw: "rebuild" },
      sourceOutcome: { mode: "rebuild", primedArtifacts: [], gaps: [] },
      sideEffects: { departingSessionKilled: false, departingProcess: "ended-forced", startupContextDelivered: true, provenanceRecordWritten: false } } }, []);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "rebuild", "--reason", "context wall"]);
    });
    const output = logs.join("\n");
    expect(exitCode).toBeUndefined(); // the handover itself completed
    expect(output).toContain("The handover's lineage record (occupant tenure) was NOT written; check the daemon log, which names the first such failure since the daemon started. The seat is already bound to the successor, so don't run the handover again.");
    expect(output).toContain("The previous occupant was stopped by a signal: it didn't exit through its own shutdown, or that couldn't be confirmed. Its tmux session was kept, and the successor runs in the same pane.");
    expect(output).toContain("No conversation continuity was carried: the successor started a fresh conversation.");
    expect(output).not.toContain("session stop");
  });

  it("#3901: handover human output says how the previous occupant ended, in the daemon's words", async () => {
    const deps = makeDeps({ status: 200, data: { ...HANDOVER_RESULT, source: { mode: "rebuild", raw: "rebuild" },
      sourceOutcome: { mode: "rebuild", primedArtifacts: [], gaps: [] },
      sideEffects: { departingSessionKilled: false, departingProcess: "ended-graceful", departingProcessDetail: "Claude Code exited on TERM in 0.4 s.",
        startupContextDelivered: true, provenanceRecordWritten: true } } }, []);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "rebuild", "--reason", "context wall"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("The previous occupant wasn't forced to stop: it exited through its own shutdown, or had already exited. Its tmux session was kept, and the successor runs in the same pane.\nClaude Code exited on TERM in 0.4 s.");
  });

  // #3044: a recovered successor on its fork parent's or the retiring occupant's conversation.
  describe("a recovered successor on a conversation that is not its own", () => {
    const resumedStatus = { ...HANDOVER_RESULT.currentStatus, continuityOutcome: "resumed" };
    const run = async (data: Record<string, unknown>, source: string) => {
      const deps = makeDeps({ status: 200, data: { ...HANDOVER_RESULT, ...data } }, []);
      const { logs } = await captureLogs(async () => {
        await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", source, "--reason", "adopt"]);
      });
      return logs.join("\n");
    };
    it("a fork on its parent's conversation prints no distinct fork, not a native fork", async () => {
      const output = await run({ source: { mode: "fork", ref: "dev-parent@seat-rig", raw: "fork:dev-parent@seat-rig" },
        sourceOutcome: { mode: "fork", forkedFrom: "dev-parent@seat-rig", forkId: "none", limit: "No distinct fork was recovered: the parent's." },
        currentStatus: resumedStatus }, "fork:dev-parent@seat-rig");
      expect(output).toContain("Fork of dev-parent@seat-rig: no distinct fork. No distinct fork was recovered: the parent's.");
      expect(output).not.toContain("Native fork of");
      expect(output).not.toContain("No packet delivery");
    });
    it("a captured fork whose parent couldn't be checked prints its limit", async () => {
      const output = await run({ source: { mode: "fork", ref: "dev-parent@seat-rig", raw: "fork:dev-parent@seat-rig" },
        sourceOutcome: { mode: "fork", forkedFrom: "dev-parent@seat-rig", forkId: "captured", limit: "It was not checked." } }, "fork:dev-parent@seat-rig");
      expect(output).toContain("Native fork of dev-parent@seat-rig");
      expect(output).toContain("It was not checked.");
    });
    it.each([
      ["delivered", { startupContextDelivered: true }, undefined],
      ["unconfirmed", { startupContextDelivered: false }, { status: "unconfirmed", reason: "the prompt still looked staged in the input box" }],
    ])("a resumed rebuild (%s packet) doesn't say it started a new or fresh conversation", async (_name, side, restorePacket) => {
      const output = await run({ source: { mode: "rebuild", raw: "rebuild" }, sourceOutcome: { mode: "rebuild", primedArtifacts: [], gaps: [] },
        sideEffects: { ...HANDOVER_RESULT.sideEffects, ...side }, currentStatus: resumedStatus, ...(restorePacket ? { restorePacket } : {}) }, "rebuild");
      expect(output).not.toContain("Rebuild starts a new conversation");
      expect(output).not.toContain("No conversation continuity was carried");
    });
  });

  it("handover human output from an older daemon, whose receipt has no departingProcess, claims neither side effect", async () => {
    const older = { departingSessionKilled: false, startupContextDelivered: false, provenanceRecordWritten: false };
    const deps = makeDeps({ status: 200, data: { ...HANDOVER_RESULT, sideEffects: older } }, []);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "discovered:disc-1", "--reason", "mvp-proof"]);
    });
    expect(logs.join("\n")).not.toMatch(/lineage record|previous occupant's process/);
  });

  it("handover fresh human output HONESTLY reports the delivered startup context (B2)", async () => {
    const deps = makeDeps({ status: 200, data: HANDOVER_RESULT_FRESH }, []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--source", "fresh",
        "--reason", "context-wall",
      ]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    // Source rendered honestly from result.source (not always discovered:<id>).
    expect(output).toContain("Source: fresh");
    expect(output).toContain("Current occupant: dev-impl@seat-rig-h1SUCCID0");
    // The fresh path DID deliver context — the surface must say so, not deny it.
    expect(output).toContain("The captured startup context (restore packet) was delivered to the successor.");
    expect(output).not.toContain("OpenRig delivered no startup context");
  });

  it("handover fresh human output says an accepted packet was typed and submitted, not that it was delivered", async () => {
    const reason = "codex's input box isn't read, so the packet was typed and submitted but not seen consumed";
    const deps = makeDeps({ status: 200, data: {
      ...HANDOVER_RESULT_FRESH,
      restorePacket: { status: "accepted", reason },
      sideEffects: { ...HANDOVER_RESULT_FRESH.sideEffects, startupContextDelivered: true },
    } }, []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "fresh", "--reason", "context-wall"]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain(`The captured startup context (restore packet) was typed and submitted to the successor; ${reason}.`);
    expect(output).not.toContain("restore packet) was delivered");
  });

  it("handover fresh human output says an unconfirmed restore packet was sent, not that nothing was delivered", async () => {
    const reason = "the input box could not be observed";
    const deps = makeDeps({ status: 200, data: {
      ...HANDOVER_RESULT_FRESH,
      restorePacket: { status: "unconfirmed", reason },
      sideEffects: { ...HANDOVER_RESULT_FRESH.sideEffects, startupContextDelivered: false },
    } }, []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "fresh", "--reason", "context-wall"]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined(); // the handover still succeeded
    expect(output).toContain("Seat handover complete: dev-impl@seat-rig");
    expect(output).toContain(`its submission is unconfirmed: ${reason}.`);
    expect(output).toContain("Check the successor's screen before sending the context again");
    expect(output).not.toContain("OpenRig delivered no startup context");
    expect(output).not.toContain("restore packet) was delivered");
  });

  it.each(["the input box could not be observed", "the prompt still looked staged in the input box"])(
    "handover rebuild output preserves the unconfirmed receipt and safe guidance (%s)", async reason => {
    const staged = reason === "the prompt still looked staged in the input box";
    const notice = "1 held message was kept for this seat and not delivered: read it with rig seat held-messages dev-impl@seat-rig.";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const receipt = {
      ...HANDOVER_RESULT_FRESH,
      ...(staged ? { seat: { ...HANDOVER_RESULT_FRESH.seat, runtime: "claude-code" } } : {}),
      source: { mode: "rebuild", raw: "rebuild" },
      sourceOutcome: { mode: "rebuild", primedArtifacts: staged ? [{ address: "/fixture-seat/RECAP.md", label: "authored recap" }] : [], gaps: [] },
      restorePacket: { status: "unconfirmed", reason },
      sideEffects: { ...HANDOVER_RESULT_FRESH.sideEffects, startupContextDelivered: false },
      ...(staged ? { warnings: [notice] } : {}),
    };
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: receipt }, paths);
    const json = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "rebuild", "--reason", "context-wall", "--json",
    ]).then(() => undefined));
    expect(json.exitCode).toBeUndefined();
    expect(json.errors).toEqual([]);
    expect(JSON.parse(json.logs.join(""))).toEqual(receipt);

    const human = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "rebuild", "--reason", "context-wall",
    ]).then(() => undefined));
    const output = human.logs.join("\n");
    console.info("ISSUE1544_REBUILD_CLI", JSON.stringify({ output, json: JSON.parse(json.logs.join("")), paths }));
    expect(human.exitCode).toBeUndefined();
    expect(human.errors).toEqual([]);
    expect(output).toContain("Seat handover complete: dev-impl@seat-rig");
    expect(output).toContain(`The rebuild priming packet was sent to the successor, but its submission is unconfirmed: ${reason}.`);
    if (staged) {
      expect.soft(output).toMatch(/successor.*(?:runs|running)/i);
      expect.soft(output).toMatch(/(?:inspect|check).*screen/i);
      expect.soft(output).toMatch(/(?:exact|same).*packet.*still.*staged/i);
      expect.soft(output).toMatch(/(?:submit|press Enter).*existing packet.*once/i);
      expect.soft(output).toMatch(/do not.*(?:resend|send).*blindly/i);
      expect.soft(output).toMatch(/do not.*(?:rerun|repeat).*handover/i);
      expect.soft(output).not.toMatch(/unwound|rollback|\bprimed\b|(?:packet|context) (?:was|is|has been) consumed|rig send/i);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`Warning: ${notice}`);
    } else {
      expect(output).toContain("Check the successor's screen before sending the priming packet again; it may already be working on it.");
      expect(warn).not.toHaveBeenCalled();
    }
    expect(output).toContain("No conversation continuity was carried: the successor started a fresh conversation.");
    expect(output).not.toMatch(/captured startup context|restore packet|was delivered/);
  });

  it("handover human output says the successor started without a required file, not a plain complete (#2456)", async () => {
    const missing = "/project/spec/culture.md";
    const deps = makeDeps({ status: 200, data: { ...HANDOVER_RESULT_FRESH, startedWithoutRequired: [missing] } }, []);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig", "--source", "fresh", "--reason", "context-wall"]);
    });
    const output = logs.join("\n");
    expect(exitCode).toBeUndefined(); // the successor is running, so the handover itself completed
    expect(logs[0]).toBe("Seat handover complete, degraded: dev-impl@seat-rig");
    expect(output).toContain(`The successor started without required file ${missing}.`);
    expect(output).not.toContain("Seat handover complete: dev-impl@seat-rig");
  });

  it("handover surfaces a loud step-named failure (successor_create_failed)", async () => {
    const deps = makeDeps({
      status: 500,
      data: {
        ok: false,
        code: "successor_create_failed",
        message: "Handover failed at step \"create_successor\": duplicate session",
        guidance: "No successor was created and the original seat/binding is untouched. Inspect tmux/daemon logs and retry.",
      },
    }, []);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--source", "fresh",
        "--reason", "context-wall",
      ]);
    });

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("create_successor");
    expect(errors.join("\n")).toContain("original seat/binding is untouched");
  });

  it("top-level `rig handover` posts to the same route and requires --reason", async () => {
    const paths: string[] = [];
    const deps = makeDeps({ status: 200, data: HANDOVER_RESULT }, paths);

    const { exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "handover", "dev-impl@seat-rig",
        "--source", "fresh",
        "--reason", "context-wall",
        "--json",
      ]);
    });

    expect(exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/handover/dev-impl%40seat-rig"]);

    // --reason is enforced before any daemon contact.
    const paths2: string[] = [];
    const deps2 = makeDeps({ status: 200, data: HANDOVER_RESULT }, paths2);
    const { exitCode: exit2, errors } = await captureLogs(async () => {
      await makeCommand(deps2).parseAsync(["node", "rig", "handover", "dev-impl@seat-rig"]);
    });
    expect(exit2).toBe(2);
    expect(paths2).toEqual([]);
    expect(errors.join("\n")).toContain("Missing required option: --reason <reason>");
  });

  it("`rig seat handover` help describes the mutation and documents --dry-run for planning", () => {
    const seatCmd = seatCommand();
    const handoverSubcmd = seatCmd.commands.find((c) => c.name() === "handover");
    expect(handoverSubcmd).toBeDefined();
    expect(handoverSubcmd!.description()).toContain("Hand a seat to a successor");
    expect(handoverSubcmd!.description()).toContain("--dry-run");
    expect(handoverSubcmd!.description()).not.toBe("Plan a safe two-phase seat handover");
  });
});

// OPR.0.4.3.26 — seat-recovery switch-client VIEW retarget.
const SWITCH_CLIENT_OK = {
  seat_ref: "dev-impl@seat-rig",
  session: "dev-impl@seat-rig",
  window: 0,
  target: "dev-impl@seat-rig:0",
  client: "/dev/ttys003",
  mutated: false,
  retargeted: true,
};

function makeDepsCapturingBody(
  response: { status: number; data: unknown },
  paths: string[],
  bodies: unknown[],
): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => { paths.push(path); return response; }),
      post: vi.fn(async (path: string, body?: unknown) => { paths.push(path); bodies.push(body); return response; }),
    }) as unknown as StatusDeps["clientFactory"] extends (url: string) => infer T ? T : never,
  };
}

describe("rig seat switch-client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the URL-encoded switch-client route and prints a view-only success", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const deps = makeDepsCapturingBody({ status: 200, data: SWITCH_CLIENT_OK }, paths, bodies);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "switch-client", "dev-impl@seat-rig"]);
    });

    expect(exitCode).toBeUndefined();
    expect(paths).toEqual(["/api/seat/switch-client/dev-impl%40seat-rig"]);
    const output = logs.join("\n");
    expect(output).toContain("Retargeted client /dev/ttys003 -> dev-impl@seat-rig:0");
    expect(output).toContain("View only");
    expect(output).not.toContain("routing changed");
  });

  it("passes --client and parsed --to-window in the request body", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const deps = makeDepsCapturingBody({ status: 200, data: { ...SWITCH_CLIENT_OK, window: 1, target: "dev-impl@seat-rig:1" } }, paths, bodies);

    await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "switch-client", "dev-impl@seat-rig",
        "--client", "/dev/ttys003", "--to-window", "1",
      ]);
    });

    expect(bodies).toEqual([{ client: "/dev/ttys003", toWindow: 1 }]);
  });

  it("prints stable JSON and sets no error exit on success", async () => {
    const deps = makeDepsCapturingBody({ status: 200, data: SWITCH_CLIENT_OK }, [], []);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "switch-client", "dev-impl@seat-rig", "--json",
      ]);
    });

    expect(exitCode).toBeUndefined();
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ mutated: false, retargeted: true, target: "dev-impl@seat-rig:0" });
  });

  it("rejects a non-integer --to-window before contacting the daemon", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const deps = makeDepsCapturingBody({ status: 200, data: SWITCH_CLIENT_OK }, paths, bodies);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "switch-client", "dev-impl@seat-rig", "--to-window", "abc",
      ]);
    });

    expect(exitCode).toBe(2);
    expect(paths).toEqual([]);
    expect(errors.join("\n")).toContain("Invalid --to-window");
  });

  it("surfaces the ambiguous-client list on a 409 and exits nonzero", async () => {
    const deps = makeDepsCapturingBody({
      status: 409,
      data: {
        ok: false,
        code: "ambiguous_client",
        message: "Multiple attached clients; specify one with --client <name>.",
        clients: [
          { name: "/dev/ttys003", session: "a" },
          { name: "/dev/ttys007", session: "b" },
        ],
      },
    }, [], []);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "switch-client", "dev-impl@seat-rig"]);
    });

    expect(exitCode).toBe(1);
    const out = errors.join("\n");
    expect(out).toContain("Multiple attached clients");
    expect(out).toContain("/dev/ttys003");
    expect(out).toContain("/dev/ttys007");
  });

  it("maps a 502 switch failure to exit code 2", async () => {
    const deps = makeDepsCapturingBody({
      status: 502,
      data: { ok: false, code: "switch_failed", message: "tmux switch-client failed: gone" },
    }, [], []);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "switch-client", "dev-impl@seat-rig"]);
    });

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("tmux switch-client failed");
  });
});

// #260: the daemon may hold a dynamic Claude permission request for up to 5 s while it
// queries `claude --help`; a mutating handover launches and readies a successor. These
// bind the per-call request deadlines with fake timers (no wall-clock bound).
describe("seat request deadlines (#260)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const QUERY_REFUSAL = {
    ok: false,
    code: "permission_selection_refused",
    message: "Claude managed capability query failed; no fallback was selected.",
  };

  function slowClient(respondAfterMs: number | null, response: () => Response) {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = respondAfterMs === null ? undefined : setTimeout(() => resolve(response()), respondAfterMs);
      init!.signal!.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
        reject(init!.signal!.reason);
      }, { once: true });
    }));
    const deps = makeDeps({ status: 200, data: {} }, []);
    deps.clientFactory = url => new DaemonClient(url, { fetchImpl });
    return { deps, fetchImpl };
  }

  async function run(deps: StatusDeps, argv: string[], advanceMs: number) {
    const result = captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", ...argv]).then(() => undefined))
      .catch(error => ({ error: error as Error }));
    await vi.advanceTimersByTimeAsync(advanceMs);
    return result;
  }

  const SET_PERMISSIONS = ["seat", "set-permissions", "dev-impl@seat-rig", "--mode", "auto", "--reason", "slow help", "--json"];
  const HANDOVER = ["seat", "handover", "dev-impl@seat-rig", "--reason", "context-wall", "--json"];

  it("set-permissions receives the daemon's capability-query refusal after the 5 s default would have aborted", async () => {
    vi.useFakeTimers();
    const { deps, fetchImpl } = slowClient(5_010, () => Response.json(QUERY_REFUSAL, { status: 409 }));
    const output = await run(deps, SET_PERMISSIONS, 5_010);
    if (!("logs" in output)) throw output.error;
    expect(JSON.parse(output.logs.join("\n"))).toMatchObject(QUERY_REFUSAL);
    expect(output.exitCode).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("set-permissions is still bounded, at 10 s", async () => {
    vi.useFakeTimers();
    const { deps, fetchImpl } = slowClient(null, () => Response.json({}));
    const output = await run(deps, SET_PERMISSIONS, 10_000);
    expect(output).toHaveProperty("error");
    expect((output as { error: Error }).error.message).toContain("timed out after 10000ms");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // #198: reaching the 120 s launch window leaves a mutating handover's outcome unknown; the daemon
  // may still be working. Both aliases share runSeatHandover. One request, no retry.
  it.each([["seat", "handover"], ["handover"]].flatMap(alias => [false, true].map(json => [alias, json] as const)))(
    "a mutating handover (%j) reports an unknown outcome at the 120 s bound with one request (json=%s)", async (alias, json) => {
      vi.useFakeTimers();
      const { deps, fetchImpl } = slowClient(null, () => Response.json({}));
      const argv = [...alias, "dev-impl@seat-rig", "--reason", "context-wall", ...(json ? ["--json"] : [])];
      const result = captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", ...argv]).then(() => undefined))
        .catch(error => ({ error: error as Error }));
      await vi.advanceTimersByTimeAsync(119_999);
      const signal = (fetchImpl.mock.calls[0]![1] as RequestInit).signal!;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      const output = await result;
      if (!("logs" in output)) throw output.error;
      expect(output.exitCode).toBe(1);
      const text = json ? output.logs.join("\n") : output.errors.join("\n");
      if (json) {
        expect(output.errors).toEqual([]);
        expect(JSON.parse(text)).toMatchObject({
          ok: false,
          code: "handover_outcome_unknown",
          status: "unknown",
          guidance: expect.stringContaining("rig seat status dev-impl@seat-rig"),
        });
      } else {
        expect(output.logs).toEqual([]);
        expect(text).toContain("handover outcome is unknown");
        expect(text).toContain("rig seat status dev-impl@seat-rig");
      }
      expect(text).toContain("may still be working");
      expect(text).not.toMatch(/cancel|handover failed|safe to retry/i);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  // #3044 CodeRabbit: the recovery's proof can wait for the seat's lifecycle lease and, when a first sample can't prove
  // the successor, sleeps 3 s before a second one that can still commit, so the 5 s default could abort a recovery the
  // daemon still commits. It gets 60 s, and reaching them is an unknown outcome. One request.
  it.each([false, true])("handover --recover outlasts the 5 s default and reports an unknown outcome at 60 s (json=%s)", async json => {
    vi.useFakeTimers();
    const { deps, fetchImpl } = slowClient(null, () => Response.json({}));
    const result = captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", "seat", "handover", "dev-impl@seat-rig",
      "--recover", "--reason", "adopt the running successor", ...(json ? ["--json"] : [])]).then(() => undefined))
      .catch(error => ({ error: error as Error }));
    await vi.advanceTimersByTimeAsync(59_999);
    const signal = (fetchImpl.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    const output = await result;
    if (!("logs" in output)) throw output.error;
    expect(output.exitCode).toBe(1);
    const text = json ? output.logs.join("\n") : output.errors.join("\n");
    if (json) {
      expect(output.errors).toEqual([]);
      expect(JSON.parse(text)).toMatchObject({ ok: false, code: "handover_outcome_unknown", status: "unknown",
        guidance: expect.stringContaining("rig seat status dev-impl@seat-rig") });
    } else {
      expect(output.logs).toEqual([]);
      expect(text).toContain("outcome of the handover recovery is unknown");
    }
    expect(text).toContain("may still be working");
    expect(text).not.toMatch(/recovery failed|timed out after/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toContain("/api/seat/handover/dev-impl%40seat-rig/recover");
  });

  it("a mutating handover's connection failure stays a transport error, not an unknown outcome", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const deps = makeDeps({ status: 200, data: {} }, []);
    deps.clientFactory = url => new DaemonClient(url, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const output = await captureLogs(() => makeCommand(deps).parseAsync(["node", "rig", ...HANDOVER]).then(() => undefined))
      .catch(error => ({ error: error as Error }));
    expect(output).toHaveProperty("error");
    expect((output as { error: Error }).error.name).toBe("DaemonConnectionError");
    expect((output as { error: Error }).error.message).not.toContain("outcome is unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a mutating handover receives a response that arrives after five seconds", async () => {
    vi.useFakeTimers();
    const { deps } = slowClient(6_000, () => Response.json({ ok: false, code: "handover_refused", message: "synthetic slow refusal" }, { status: 409 }));
    const output = await run(deps, HANDOVER, 6_000);
    if (!("logs" in output)) throw output.error;
    expect(JSON.parse(output.logs.join("\n"))).toMatchObject({ code: "handover_refused" });
  });

  it.each([
    ["dry-run handover", [...HANDOVER, "--dry-run"]],
    ["set-model", ["seat", "set-model", "dev-impl@seat-rig", "--model", "m", "--reason", "r", "--json"]],
  ])("%s keeps the 5 s default deadline", async (_name, argv) => {
    vi.useFakeTimers();
    const { deps } = slowClient(null, () => Response.json({}));
    const output = await run(deps, argv as string[], 5_000);
    expect(output).toHaveProperty("error");
    expect((output as { error: Error }).error.message).toContain("timed out after 5000ms");
  });
});
