import { describe, it, expect, vi } from "vitest";
import {
  followInstance,
  outcomeExitCode,
  EXIT_WORKFLOW_FAILED,
  type FollowIo,
} from "../src/commands/workflow-follow.js";
import type { DaemonClient } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

/**
 * OPR.0.4.6.WF3 FR-1 — follow-engine pins (commit 1).
 *
 * Everything here runs against injected IO + stubbed streams: no
 * daemon, no network, no timers (sleep is injected). The live legs
 * (real SSE, real daemon) are the VM proof walk's job, not this
 * file's.
 */

function sseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

/** A stream that emits nothing and closes — the drop shape. */
function droppedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

interface HarnessOpts {
  traceResponses: Array<{ status: number; data: unknown }>;
  streams: Array<ReadableStream<Uint8Array> | null>;
}

function makeHarness(opts: HarnessOpts) {
  const outLines: string[] = [];
  const errLines: string[] = [];
  let traceCall = 0;
  let streamCall = 0;
  const client = {
    baseUrl: "http://localhost:7433",
    get: async (_path: string) => {
      const res = opts.traceResponses[Math.min(traceCall, opts.traceResponses.length - 1)];
      traceCall += 1;
      return res;
    },
  } as unknown as DaemonClient;
  const io: FollowIo = {
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    sleep: async () => {},
    fetchImpl: (async () => {
      const body = opts.streams[Math.min(streamCall, opts.streams.length - 1)];
      streamCall += 1;
      if (body === null) throw new Error("connect refused");
      return { ok: true, body } as unknown as Response;
    }) as unknown as typeof fetch,
  };
  return { client, io, outLines, errLines };
}

const ACTIVE_SNAPSHOT = {
  status: 200,
  data: {
    instance: {
      instanceId: "WF1",
      workflowName: "conveyor",
      status: "active",
      currentStepId: "build",
      currentFrontier: ["Q2"],
    },
    trail: [
      {
        stepId: "plan",
        closureReason: "handoff",
        actorSession: "a@r",
        nextQitemId: "Q2",
        priorQitemId: "Q1",
      },
    ],
  },
};

describe("workflow-follow (WF3 FR-1)", () => {
  it("outcome exit codes: completed=0, failed=3, distinct from 1/2", () => {
    expect(outcomeExitCode("completed")).toBe(0);
    expect(outcomeExitCode("failed")).toBe(EXIT_WORKFLOW_FAILED);
    expect(EXIT_WORKFLOW_FAILED).toBe(3);
  });

  it("streams to completion and returns 0", async () => {
    const h = makeHarness({
      traceResponses: [ACTIVE_SNAPSHOT],
      streams: [
        sseStream([
          { type: "workflow.step_closed", instanceId: "WF1", stepId: "build", closureReason: "handoff", actorSession: "b@r", priorQitemId: "Q2" },
          { type: "workflow.completed", instanceId: "WF1" },
        ]),
      ],
    });
    const code = await followInstance(h.client, "WF1", { json: false, io: h.io });
    expect(code).toBe(0);
    expect(h.outLines.join("\n")).toContain("workflow completed");
  });

  it("a failed workflow exits 3 with the failing step visible", async () => {
    const h = makeHarness({
      traceResponses: [ACTIVE_SNAPSHOT],
      streams: [
        sseStream([
          { type: "workflow.step_closed", instanceId: "WF1", stepId: "build", closureReason: "failed", actorSession: "b@r", priorQitemId: "Q2" },
          { type: "workflow.failed", instanceId: "WF1", reason: "boom" },
        ]),
      ],
    });
    const code = await followInstance(h.client, "WF1", { json: false, io: h.io });
    expect(code).toBe(EXIT_WORKFLOW_FAILED);
    const text = h.outLines.join("\n");
    expect(text).toContain("✖ build");
    expect(text).toContain("FAILED: boom");
  });

  it("snapshot-first dedup: a step already in the snapshot trail renders exactly once (arch R2)", async () => {
    const h = makeHarness({
      traceResponses: [ACTIVE_SNAPSHOT],
      streams: [
        sseStream([
          // Replay of the closure the snapshot already carries (priorQitemId Q1).
          { type: "workflow.step_closed", instanceId: "WF1", stepId: "plan", closureReason: "handoff", actorSession: "a@r", priorQitemId: "Q1" },
          { type: "workflow.completed", instanceId: "WF1" },
        ]),
      ],
    });
    await followInstance(h.client, "WF1", { json: false, io: h.io });
    const planRows = h.outLines.filter((l) => l.includes("plan") && l.includes("handoff"));
    expect(planRows).toHaveLength(1);
  });

  it("filters events from other instances", async () => {
    const h = makeHarness({
      traceResponses: [ACTIVE_SNAPSHOT],
      streams: [
        sseStream([
          { type: "workflow.step_closed", instanceId: "OTHER", stepId: "x", closureReason: "handoff", actorSession: "z@r", priorQitemId: "QX" },
          { type: "workflow.completed", instanceId: "OTHER" },
          { type: "workflow.completed", instanceId: "WF1" },
        ]),
      ],
    });
    const code = await followInstance(h.client, "WF1", { json: false, io: h.io });
    expect(code).toBe(0);
    expect(h.outLines.join("\n")).not.toContain("OTHER");
  });

  it("attach to an already-terminal instance resolves immediately from the snapshot", async () => {
    const h = makeHarness({
      traceResponses: [
        { status: 200, data: { instance: { instanceId: "WF1", status: "failed" }, trail: [] } },
      ],
      streams: [droppedStream()],
    });
    const code = await followInstance(h.client, "WF1", { json: false, io: h.io });
    expect(code).toBe(EXIT_WORKFLOW_FAILED);
  });

  it("drop → announced reconnect; exhausted reconnects → announced poll fallback that resolves the outcome", async () => {
    const h = makeHarness({
      traceResponses: [
        ACTIVE_SNAPSHOT,
        {
          status: 200,
          data: {
            instance: { instanceId: "WF1", status: "completed" },
            trail: [
              ...(ACTIVE_SNAPSHOT.data.trail as unknown[]),
              { stepId: "build", closureReason: "done", actorSession: "b@r", nextQitemId: null, priorQitemId: "Q2" },
            ],
          },
        },
      ],
      streams: [droppedStream(), droppedStream()],
    });
    const code = await followInstance(h.client, "WF1", {
      json: false,
      io: h.io,
      maxReconnects: 1,
      pollIntervalMs: 1,
    });
    expect(code).toBe(0);
    const err = h.errLines.join("\n");
    expect(err).toContain("reconnecting");
    expect(err).toContain("poll fallback");
    // The poll rendered the new trail row exactly once, never silently frozen.
    expect(h.outLines.filter((l) => l.includes("build") && l.includes("done"))).toHaveLength(1);
  });

  it("--json emits machine lines (snapshot + events), no human table", async () => {
    const h = makeHarness({
      traceResponses: [ACTIVE_SNAPSHOT],
      streams: [sseStream([{ type: "workflow.completed", instanceId: "WF1" }])],
    });
    const code = await followInstance(h.client, "WF1", { json: true, io: h.io });
    expect(code).toBe(0);
    for (const line of h.outLines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(h.outLines[0]).type).toBe("snapshot");
  });

  it("trace 404 maps to transport exit 1, not an outcome code", async () => {
    const h = makeHarness({
      traceResponses: [{ status: 404, data: { error: "instance_not_found" } }],
      streams: [droppedStream()],
    });
    const code = await followInstance(h.client, "WF1", { json: false, io: h.io });
    expect(code).toBe(1);
  });
});

describe("run proceeds to follow on the daemon's NESTED instantiate shape (walk-caught regression)", () => {
  it("run with {instance:{instanceId}} response follows (fetches trace) instead of print-and-exit", async () => {
    const { createProgram } = await import("../src/index.js");
    const calls: string[] = [];
    const deps = {
      lifecycleDeps: {} as never,
      clientFactory: () =>
        ({
          baseUrl: "http://127.0.0.1:1", // SSE fetch fails fast; snapshot resolves terminally
          post: async (path: string) => {
            calls.push(`POST ${path}`);
            // The REAL daemon shape: nested InstantiateResult.
            return { status: 201, data: { instance: { instanceId: "WF-NEST" }, entryQitemId: "Q1" } };
          },
          get: async (path: string) => {
            calls.push(`GET ${path}`);
            return { status: 200, data: { instance: { instanceId: "WF-NEST", status: "completed" }, trail: [] } };
          },
        }) as never,
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({ workflowDeps: deps as never });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "workflow", "run", "spec.yaml",
      "--root-objective", "x", "--created-by", "a@r",
    ]);
    logSpy.mockRestore();
    // The regression: with the nested shape, run must REACH the follow
    // phase (trace snapshot fetched), never print-and-return exit 0.
    expect(calls).toContain("GET /api/workflow/WF-NEST/trace");
  });
});

describe("run/watch verb honesty (BR-1)", () => {
  it("help text matches wire behavior: run runs, watch watches, neither advances", async () => {
    const { workflowCommand } = await import("../src/commands/workflow.js");
    const cmd = workflowCommand();
    const run = cmd.commands.find((c) => c.name() === "run");
    const watch = cmd.commands.find((c) => c.name() === "watch");
    expect(run?.description()).toContain("follow");
    expect(watch?.description()).toContain("read-only");
    expect(run?.description()).not.toContain("advance");
    expect(watch?.description()).not.toContain("advance");
  });
});
