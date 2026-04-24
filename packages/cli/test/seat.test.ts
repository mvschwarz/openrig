import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { seatCommand } from "../src/commands/seat.js";
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

  it("handover non-dry-run human output avoids continuity claims", async () => {
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
    expect(output).toContain("Previous occupant: dev-impl@seat-rig");
    expect(output).toContain("Current occupant: successor-session");
    expect(output).toContain("Seat binding and inventory provenance were updated.");
    expect(output).toContain("No conversation continuity");
    expect(output).toContain("session stop");
  });

  it("handover without --dry-run refuses unsupported successor creation sources", async () => {
    const deps = makeDeps({
      status: 501,
      data: {
        ok: false,
        code: "successor_creation_not_implemented",
        message: "Seat handover mutation for source \"fresh\" is not implemented in this slice.",
        guidance: "For live mutation in this slice, provide an already-created successor with --source discovered:<id>.",
      },
    }, []);

    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync([
        "node", "rig", "seat", "handover", "dev-impl@seat-rig",
        "--reason", "context-wall",
      ]);
    });

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("not implemented in this slice");
    expect(errors.join("\n")).toContain("--source discovered:<id>");
  });
});
