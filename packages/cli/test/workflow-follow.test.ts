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

  it("a resume row in the trail renders as ↻ with the owner and whether it was named or resolved", async () => {
    const resumeRow = (ownerSource: string) => ({
      stepId: "build", closureReason: "resumed", actorSession: "orch@r", nextQitemId: "Q3", priorQitemId: "Q2",
      closureEvidence: { resume: { ownerSession: "builder-slot-2@r", ownerSource } },
    });
    for (const ownerSource of ["named", "resolved"]) {
      const snapshot = {
        status: 200,
        data: { ...ACTIVE_SNAPSHOT.data, trail: [...ACTIVE_SNAPSHOT.data.trail, resumeRow(ownerSource)] },
      };
      const h = makeHarness({
        traceResponses: [snapshot],
        streams: [sseStream([{ type: "workflow.completed", instanceId: "WF1" }])],
      });
      await followInstance(h.client, "WF1", { json: false, io: h.io });
      const row = h.outLines.find((l) => l.includes("build") && l.includes("resumed"));
      expect(row).toContain("↻ build");
      expect(row).not.toContain("✔");
      expect(row).toContain(`owner builder-slot-2@r (${ownerSource})`);
    }
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

  it("attaches to an aborted instance with the same failure outcome as a live abort", async () => {
    const h = makeHarness({
      traceResponses: [{ status: 200, data: { instance: { instanceId: "WF1", status: "aborted" }, trail: [] } }],
      streams: [droppedStream()],
    });
    let streamSignal: AbortSignal | undefined;
    const fetchImpl = h.io.fetchImpl;
    h.io.fetchImpl = ((input, init) => {
      streamSignal = init?.signal as AbortSignal;
      return fetchImpl(input, init);
    }) as typeof fetch;
    h.io.sleep = async () => { throw new Error("terminal snapshot must not wait"); };
    expect(await followInstance(h.client, "WF1", { json: false, io: h.io, maxReconnects: 0 })).toBe(EXIT_WORKFLOW_FAILED);
    expect(streamSignal?.aborted).toBe(true);
    expect(h.outLines[0]).toContain("status=aborted");
  });

  it("picks up a failure and its trail row missed during a stream disconnect", async () => {
    const failed = { stepId: "build", closureReason: "failed", actorSession: "b@r", priorQitemId: "Q2" };
    const h = makeHarness({
      traceResponses: [ACTIVE_SNAPSHOT, { status: 200, data: {
        instance: { instanceId: "WF1", status: "failed" }, trail: [...ACTIVE_SNAPSHOT.data.trail, failed],
      } }],
      streams: [droppedStream(), droppedStream()],
    });
    h.io.sleep = async () => { throw new Error("missed failure should be visible at reconnect"); };
    expect(await followInstance(h.client, "WF1", { json: false, io: h.io, maxReconnects: 1 })).toBe(EXIT_WORKFLOW_FAILED);
    expect(h.outLines.filter(line => line.includes("plan") && line.includes("handoff"))).toHaveLength(1);
    expect(h.outLines.filter(line => line.includes("build") && line.includes("failed"))).toHaveLength(1);
  });

  it("stops polling when an active workflow becomes aborted", async () => {
    const h = makeHarness({
      traceResponses: [ACTIVE_SNAPSHOT, { status: 200, data: { instance: { instanceId: "WF1", status: "aborted" }, trail: [] } }],
      streams: [droppedStream()],
    });
    let sleeps = 0;
    h.io.sleep = async () => {
      if (++sleeps > 1) throw new Error("aborted workflow must not poll again");
    };
    expect(await followInstance(h.client, "WF1", { json: true, io: h.io, maxReconnects: 0 })).toBe(EXIT_WORKFLOW_FAILED);
    expect(sleeps).toBe(1);
    expect(JSON.parse(h.outLines.at(-1)!).status).toBe("aborted");
  });

  it("drop → announced reconnect; exhausted reconnects → announced poll fallback that resolves the outcome", async () => {
    const h = makeHarness({
      traceResponses: [
        ACTIVE_SNAPSHOT,
        ACTIVE_SNAPSHOT, // Still running when the stream reconnects; it completes during polling.
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

  it("poll fallback skips rows by trailId: a resume row sharing the failed packet's id still prints, and a later closure of the redrive packet still prints", async () => {
    const failed = { trailId: "T1", stepId: "build", closureReason: "failed", actorSession: "b@r", nextQitemId: null, priorQitemId: "Q2" };
    const resumed = {
      trailId: "T2", stepId: "build", closureReason: "resumed", actorSession: "orch@r", nextQitemId: "Q3", priorQitemId: "Q2",
      closureEvidence: { resume: { ownerSession: "builder-slot-2@r", ownerSource: "named" } },
    };
    // Instance redrive with no recorded failed packet: the resume row carries the redrive's own id.
    const resumedNoClosed = { trailId: "T3", stepId: "build", closureReason: "resumed", actorSession: "orch@r", nextQitemId: "Q4", priorQitemId: "Q4" };
    const done = { trailId: "T4", stepId: "build", closureReason: "done", actorSession: "b2@r", nextQitemId: null, priorQitemId: "Q4" };
    const base = ACTIVE_SNAPSHOT.data;
    const h = makeHarness({
      traceResponses: [
        { status: 200, data: { ...base, trail: [...base.trail, failed] } },
        { status: 200, data: { ...base, trail: [...base.trail, failed, resumed, resumedNoClosed] } },
        { status: 200, data: { ...base, instance: { ...base.instance, status: "completed" }, trail: [...base.trail, failed, resumed, resumedNoClosed, done] } },
      ],
      streams: [droppedStream()],
    });
    const code = await followInstance(h.client, "WF1", { json: false, io: h.io, maxReconnects: 0, pollIntervalMs: 1 });
    expect(code).toBe(0);
    expect(h.outLines.filter((l) => l.includes("✖ build"))).toHaveLength(1);
    expect(h.outLines.filter((l) => l.includes("↻ build"))).toHaveLength(2);
    expect(h.outLines.some((l) => l.includes("owner builder-slot-2@r (named)"))).toBe(true);
    expect(h.outLines.filter((l) => l.includes("build") && l.includes("done"))).toHaveLength(1);
  });

  it("a resume row in the snapshot does not hide the stream's later closure of the redrive packet", async () => {
    const resumedNoClosed = { trailId: "T3", stepId: "build", closureReason: "resumed", actorSession: "orch@r", nextQitemId: "Q4", priorQitemId: "Q4" };
    const h = makeHarness({
      traceResponses: [{ status: 200, data: { ...ACTIVE_SNAPSHOT.data, trail: [...ACTIVE_SNAPSHOT.data.trail, resumedNoClosed] } }],
      streams: [
        sseStream([
          { type: "workflow.resumed", instanceId: "WF1", stepId: "build", resumedBy: "orch@r", ownerSession: "builder-slot-2@r", ownerSource: "named" },
          { type: "workflow.step_closed", instanceId: "WF1", stepId: "build", closureReason: "done", actorSession: "b2@r", priorQitemId: "Q4" },
          { type: "workflow.completed", instanceId: "WF1" },
        ]),
      ],
    });
    expect(await followInstance(h.client, "WF1", { json: false, io: h.io })).toBe(0);
    expect(h.outLines.filter((l) => l.includes("build") && l.includes("done"))).toHaveLength(1);
    // The snapshot already printed the resume row; the stream's workflow.resumed must not print it again.
    expect(h.outLines.filter((l) => l.includes("↻ build"))).toHaveLength(1);
  });

  it("a resume streamed before a drop prints exactly once when the poll then finds its trail row", async () => {
    const resumed = {
      trailId: "T2", stepId: "build", closureReason: "resumed", actorSession: "orch@r", nextQitemId: "Q3", priorQitemId: "Q2",
      closureEvidence: { resume: { ownerSession: "builder-slot-2@r", ownerSource: "named" } },
    };
    const base = ACTIVE_SNAPSHOT.data;
    const h = makeHarness({
      traceResponses: [
        { status: 200, data: base },
        { status: 200, data: { ...base, instance: { ...base.instance, status: "completed" }, trail: [...base.trail, resumed] } },
      ],
      streams: [
        sseStream([{ type: "workflow.resumed", instanceId: "WF1", stepId: "build", resumedBy: "orch@r", resumeCount: 1, ownerSession: "builder-slot-2@r", ownerSource: "named" }]),
      ],
    });
    expect(await followInstance(h.client, "WF1", { json: false, io: h.io, maxReconnects: 0, pollIntervalMs: 1 })).toBe(0);
    expect(h.outLines.filter((l) => l.includes("↻ build"))).toHaveLength(1);
    expect(h.outLines.some((l) => l.includes("owner builder-slot-2@r (named)"))).toBe(true);
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
