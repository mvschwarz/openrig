import { describe, it, expect, vi, afterEach } from "vitest";
import { describeDaemonRejection, formatThreePart } from "../src/commands/workflow-errors.js";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

/**
 * OPR.0.4.6.WF3 FR-5 — error-UX pins (commit 4). Every named daemon
 * rejection renders the 3-part what/why/fix in human mode with the
 * correct fix pointer; --json stays the raw body byte-identically;
 * exit codes unchanged.
 */

describe("describeDaemonRejection (WF3 FR-5)", () => {
  it("packet_not_on_frontier → explains the moved frontier, points at trace", () => {
    const rej = describeDaemonRejection({ error: "packet_not_on_frontier", instanceId: "WF1" });
    expect(rej?.fact).toContain("not on the instance frontier");
    expect(rej?.consequence).toContain("frontier has moved");
    expect(rej?.action).toContain("rig workflow trace WF1");
  });

  it("instance_not_active → names the actual state; fix pointer names ONLY shipped verbs (BR-1 — flipped at WF-5: resume is real now)", () => {
    const rej = describeDaemonRejection({ error: "instance_not_active", message: "failed", instanceId: "WF1" });
    expect(rej?.fact).toContain("failed");
    expect(rej?.action).toContain("rig workflow show WF1");
    // OPR.0.4.6.WF5 FR-4: the WF-3-era negative asserted NO resume
    // pointer because the verb did not ship yet (BR-1: never point at
    // a verb that does not exist). WF-5 shipped it, and the pointer
    // upgraded exactly as the WF-3 comment promised — same BR-1
    // principle, inverted assertion.
    expect(rej?.action).toContain("rig workflow resume");
  });

  it("instance_version_conflict → names expected/actual, says whole-rollback, fix = re-read + retry", () => {
    const rej = describeDaemonRejection({ error: "instance_version_conflict", expectedVersion: 4, actualVersion: 5 });
    expect(rej?.fact).toContain("expected version 4");
    expect(rej?.fact).toContain("actual 5");
    expect(rej?.consequence).toContain("rolled back whole");
    expect(rej?.action).toContain("retry");
  });

  it("exit_not_allowed → lists allowed exits when the body carries them", () => {
    const rej = describeDaemonRejection({ error: "exit_not_allowed", allowedExits: ["handoff", "failed"] });
    expect(rej?.action).toBe("Use one of: handoff | failed.");
  });

  it("no_next_step / next_owner_unresolved / instance_not_found all render with fixes", () => {
    expect(describeDaemonRejection({ error: "no_next_step" })?.action).toContain("--exit done | failed");
    expect(describeDaemonRejection({ error: "next_owner_unresolved" })?.action).toContain("--next-owner");
    expect(describeDaemonRejection({ error: "instance_not_found" })?.action).toContain("rig workflow list");
  });

  it("unrecognized bodies return null (raw-JSON fallback preserved)", () => {
    expect(describeDaemonRejection({ error: "something_new" })).toBeNull();
    expect(describeDaemonRejection({ message: "no error code" })).toBeNull();
    expect(describeDaemonRejection("string body")).toBeNull();
    expect(describeDaemonRejection(null)).toBeNull();
  });

  it("formatThreePart renders the emit3PartError shape", () => {
    const lines = formatThreePart({ fact: "f", consequence: "c", action: "a" });
    expect(lines).toEqual(["Error: f", "c", "a"]);
  });
});

describe("wire-level FR-5 behavior", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeDeps(routes: Record<string, { status: number; data: unknown }>): WorkflowDeps {
    return {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: async (path: string) => routes[`GET ${path}`] ?? { status: 200, data: {} },
          post: async (path: string, _body: unknown) => routes[`POST ${path}`] ?? { status: 200, data: {} },
        }) as never,
    };
  }

  const CONFLICT = {
    status: 409,
    data: { error: "instance_version_conflict", message: "conflict", expectedVersion: 1, actualVersion: 2 },
  };

  it("human mode: named 409 renders 3-part on stderr, exit code stays 1", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "POST /api/workflow/project": CONFLICT }),
    });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync([
      "node", "rig", "workflow", "project",
      "--instance", "WF1", "--current-packet", "Q1", "--exit", "handoff", "--actor-session", "a@r",
    ]);
    const stderrText = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("Error: A concurrent writer advanced the instance first");
    // The raw JSON blob is NOT dumped in human mode for a named rejection.
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("")).not.toContain("instance_version_conflict");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("--json: the raw daemon error body passes through byte-identically", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "POST /api/workflow/project": CONFLICT }),
    });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync([
      "node", "rig", "workflow", "project",
      "--instance", "WF1", "--current-packet", "Q1", "--exit", "handoff", "--actor-session", "a@r", "--json",
    ]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(CONFLICT.data));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("human mode: unrecognized 500 keeps the raw-JSON fallback and exit 2", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({
        "GET /api/workflow/WF1": { status: 500, data: { error: "internal_error", message: "boom" } },
      }),
    });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync(["node", "rig", "workflow", "show", "WF1"]);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("internal_error");
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });
});
