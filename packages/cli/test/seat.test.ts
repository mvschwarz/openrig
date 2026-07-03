import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
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

function makeDeps(response: { status: number; data: unknown }, paths: string[]): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => {
        paths.push(path);
        return response;
      }),
      post: vi.fn(async (path: string) => {
        paths.push(path);
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
    startupContextDelivered: false,
    provenanceRecordWritten: false,
  },
};

const HANDOVER_RESULT_FRESH = {
  ...HANDOVER_RESULT,
  source: { mode: "fresh", ref: null, raw: "fresh", defaulted: true },
  currentOccupant: "dev-impl@seat-rig-h1SUCCID0",
  discovery: { id: "disc-fresh", status: "claimed", tmuxSession: "dev-impl@seat-rig-h1SUCCID0", tmuxPane: "%9" },
  sideEffects: {
    departingSessionKilled: false,
    startupContextDelivered: true,
    provenanceRecordWritten: false,
  },
};

describe("rig seat status", () => {
  afterEach(() => {
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
    expect(output).toContain("Continuity outcome: unknown");
    expect(output).toContain("Handover result: none");
    expect(output).toContain("Previous occupant: none");
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
        startupContextDelivered: false,
        provenanceRecordWritten: false,
      },
    });
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
    // startupContextDelivered:false — the message must include "startup context delivery" in the NOT-performed list.
    expect(output).toContain("No conversation continuity, startup context delivery, provenance markdown, or session stop was performed.");
    // ...and must NOT falsely claim a delivery happened.
    expect(output).not.toContain("restore packet) was delivered");
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
    expect(output).not.toContain("No conversation continuity, startup context delivery,");
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
