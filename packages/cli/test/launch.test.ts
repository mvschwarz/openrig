// OPR.0.3.4.11 — CLI rig launch --seats tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { launchCommand } from "../src/commands/launch.js";

function mockClient(responses: Record<string, { status: number; data: unknown }>) {
  return {
    post: vi.fn(async (url: string, body: unknown) => {
      for (const [pattern, resp] of Object.entries(responses)) {
        if (url.includes(pattern)) return resp;
      }
      return { status: 404, data: { ok: false, error: "not found" } };
    }),
    get: vi.fn(async () => ({ status: 200, data: {} })),
  };
}

function makeDeps(clientResponses: Record<string, { status: number; data: unknown }>) {
  const client = mockClient(clientResponses);
  return {
    lifecycleDeps: {
      spawn: vi.fn(),
      fetch: vi.fn(async () => ({ ok: true })),
      kill: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "t.sqlite", startedAt: new Date().toISOString() })),
      writeFile: vi.fn(),
      removeFile: vi.fn(),
      exists: vi.fn(() => true),
      mkdirp: vi.fn(),
      openForAppend: vi.fn(() => 1),
      isProcessAlive: vi.fn(() => true),
    },
    clientFactory: () => client,
    _client: client,
  };
}

describe("rig launch --seats", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
    // OPR.0.4.3.28 — non-blocking launch warnings print via console.warn (stderr).
    vi.spyOn(console, "warn").mockImplementation((...args) => { errors.push(args.join(" ")); });
    process.exitCode = undefined;
  });

  it("posts to launch-subset with seats array and holdReason", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [
            { nodeId: "n1", logicalId: "dev.driver", status: "fresh" },
            { nodeId: "n2", logicalId: "dev.guard", status: "fresh" },
          ],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard", "--hold-reason", "codex auth expired"]);

    expect(deps._client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/nodes/launch-subset",
      { seats: ["dev.driver", "dev.guard"], holdReason: "codex auth expired" },
    );
    expect(logs.some((l) => l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("dev.guard"))).toBe(true);
  });

  it("reports held and failedTargets honestly in human output", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [{ nodeId: "n2", logicalId: "dev.guard", reason: "codex auth expired" }],
          alreadyRunning: [],
          failedTargets: [{ nodeId: "n3", logicalId: "dev.reviewer", reason: "tmux_probe_error" }],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard,dev.reviewer"]);

    expect(logs.some((l) => l.includes("Launched") && l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("Held") && l.includes("dev.guard") && l.includes("codex auth expired"))).toBe(true);
    expect(errors.some((l) => l.includes("Failed") && l.includes("dev.reviewer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("FR-7: a --seats awaiting-decision restore is NOT printed as Launched and exits non-zero", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 409,
        data: {
          ok: false,
          launched: [
            { nodeId: "n1", logicalId: "dev.driver", status: "fresh" },
            { nodeId: "n2", logicalId: "dev.guard", status: "awaiting-decision", error: "Original session unresumable: resume requested but runtime continuity could not be verified. Re-run with --fresh dev.guard ..." },
          ],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
        },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard"]);
    // The running seat is Launched; the awaiting-decision seat is NOT reported as launched.
    expect(logs.some((l) => l.includes("Launched") && l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("Launched") && l.includes("dev.guard"))).toBe(false);
    // The awaiting-decision seat is surfaced honestly on stderr + the run exits non-zero.
    expect(errors.some((l) => l.includes("dev.guard") && l.includes("awaiting-decision"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("FR-7: a single-node launch that lands awaiting-decision exits non-zero, not Launched", async () => {
    const deps = makeDeps({
      "dev.driver/launch": {
        status: 409,
        data: { ok: false, logicalId: "dev.driver", code: "awaiting-decision", status: "awaiting-decision", error: "Original session unresumable: resume requested but no token available. Re-run with --fresh dev.driver ..." },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "dev.driver"]);
    expect(logs.some((l) => l.includes("Launched node"))).toBe(false);
    expect(errors.some((l) => l.includes("--fresh"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("requires nodeRef or --seats", async () => {
    const deps = makeDeps({});
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1"]);

    expect(errors.some((l) => l.includes("--seats"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("single-target already_running prints honest message, not Launched", async () => {
    const deps = makeDeps({
      "/launch": {
        status: 200,
        data: {
          ok: true,
          rigId: "rig-1",
          nodeId: "n1",
          logicalId: "dev.driver",
          code: "already_running",
          alreadyRunning: [{ nodeId: "n1", logicalId: "dev.driver" }],
          launched: [],
          held: [],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "dev.driver"]);

    expect(logs.some((l) => l.includes("already running"))).toBe(true);
    expect(logs.some((l) => l.includes("Launched"))).toBe(false);
  });

  // OPR.0.4.3.28 correction — the liveness_probe_unknown warning is a non-blocking
  // proceed-with-warning: it prints on human output and does NOT set a non-zero exit.
  it("prints liveness warnings in --seats human output with exit 0 (proceed-with-warning)", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
          warnings: ["liveness_probe_unknown: launched 'dev.driver' despite a failed tmux liveness probe — verify no live seat was squatted"],
        },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver"]);
    expect(errors.some((l) => l.includes("Warning") && l.includes("liveness_probe_unknown") && l.includes("dev.driver"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints liveness warnings in single-target human output with exit 0 (proceed-with-warning)", async () => {
    const deps = makeDeps({
      "dev.driver/launch": {
        status: 201,
        data: {
          ok: true,
          rigId: "rig-1",
          nodeId: "n1",
          logicalId: "dev.driver",
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [],
          alreadyRunning: [],
          warnings: ["liveness_probe_unknown: launched 'dev.driver' despite a failed tmux liveness probe — verify no live seat was squatted"],
        },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "dev.driver"]);
    expect(logs.some((l) => l.includes("Launched node") && l.includes("dev.driver"))).toBe(true);
    expect(errors.some((l) => l.includes("Warning") && l.includes("liveness_probe_unknown"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports unmatchedIds in --seats mode", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
          unmatchedIds: ["typo.seat"],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,typo.seat"]);

    expect(errors.some((l) => l.includes("Unmatched") && l.includes("typo.seat"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
