import { describe, expect, it, vi } from "vitest";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { parsePiRunnerState, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const seat = { nodeId: "node", sessionName: "pi@test", runtime: "pi" };
const start = Date.parse("2026-11-11T10:00:00Z");
function fixture(inspections?: readonly ("empty" | "matched" | "busy" | "unknown")[]) {
  let time = start;
  let state: PiRunnerState | null = { ready: true, launchId: "launch", updatedAt: new Date(time).toISOString() };
  const inputs: string[] = [];
  const targets: string[] = [];
  let onProbe = () => {};
  let inspectionIndex = 0;
  let enters = 0;
  const service = new PiCompactionService({
    readSidecar: () => state,
    resolveTarget: () => "%7",
    inspectComposer: async () => {
      const index = inspectionIndex++;
      return inspections ? inspections[index] ?? "unknown" : index % 2 === 0 ? "empty" : "matched";
    },
    tmux: {
      sendText: async (target, text) => { targets.push(target); inputs.push(text); return { ok: true }; },
      sendKeys: async () => { enters++; if (inputs.at(-1)?.startsWith("/openrig-state")) onProbe(); return { ok: true }; },
    },
    now: () => time, sleep: async ms => { time += ms; },
  });
  const update = (patch: Partial<PiRunnerState>) => {
    state = { ready: true, launchId: "launch", updatedAt: new Date(time + 1).toISOString(), ...patch };
  };
  return { service, inputs, targets, update, elapsed: () => time - start, enters: () => enters,
    probe: (fn: () => void) => { onProbe = fn; },
    live: (flags = { isStreaming: false, isCompacting: false }, at = start + 1) => update({
      liveState: { probeId: inputs.at(-1)?.split(" ")[1] ?? "", ...flags, updatedAt: new Date(at).toISOString() },
    }),
  };
}

describe("PiCompactionService", () => {
  it.each([
    { inspections: ["busy"], reason: "draft_input_busy", sent: 0, entered: 0 },
    { inspections: ["unknown"], reason: "draft_input_unknown", sent: 0, entered: 0 },
    { inspections: ["empty", "busy"], reason: "draft_input_changed", sent: 1, entered: 0 },
    { inspections: ["empty", "unknown"], reason: "draft_input_unknown", sent: 1, entered: 0 },
    { inspections: ["empty", "matched", "busy"], reason: "draft_input_busy", sent: 1, entered: 1 },
    { inspections: ["empty", "matched", "empty", "busy"], reason: "draft_input_changed", sent: 2, entered: 1 },
  ] as const)("refuses composer guard $reason at $inspections", async ({ inspections, reason, sent, entered }) => {
    // Given a draft or unprovable editor at a control-input boundary.
    const f = fixture(inspections);
    f.probe(() => f.live());
    // When the service tries to compact.
    const result = await f.service.trigger(seat);
    // Then the refusal is explicit and no unsafe submission occurs.
    expect(result).toEqual({ triggered: false, reason });
    expect(f.inputs).toHaveLength(sent);
    expect(f.enters()).toBe(entered);
  });
  it("refuses a delayed idle reply from a timed-out attempt during retry", async () => {
    // Given probe A times out without an answer.
    const f = fixture();
    await f.service.trigger(seat);
    const probeA = f.inputs[0]?.split(" ")[1];
    f.probe(() => f.update({ liveState: { probeId: probeA ?? "", isStreaming: false,
      isCompacting: false, updatedAt: new Date(start + 2001).toISOString() } }));
    // When probe B receives A's delayed answer with an otherwise fresh timestamp.
    const result = await f.service.trigger(seat);
    // Then correlation, not arrival time, prevents compaction.
    expect(result).toEqual({ triggered: false, reason: "live_state_unavailable" });
    expect(f.inputs[1]).not.toBe(f.inputs[0]);
    expect(f.inputs).not.toContain("/openrig-compact");
  });
  it("submits only after fresh idle state through the bound pane", async () => {
    // Given a fresh idle reply to the probe.
    const f = fixture();
    f.probe(() => f.live());
    // When compaction is requested.
    const result = await f.service.trigger(seat);
    // Then submission is truthful, not completion.
    expect(result).toEqual({ triggered: true, stage: "submitted_unconfirmed" });
    expect(f.inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/), "/openrig-compact"]);
    expect(f.targets).toEqual(["%7", "%7"]);
  });

  it.each([{ isStreaming: true, isCompacting: false }, { isStreaming: false, isCompacting: true }])(
    "refuses live busy flags %j despite an idle pre-existing sidecar", async flags => {
      // Given a live busy reply.
      const f = fixture();
      f.probe(() => f.live(flags));
      // When compaction is requested.
      const result = await f.service.trigger(seat);
      // Then compact input is never submitted.
      expect(result).toMatchObject({ triggered: false, reason: "mid_work" });
      expect(f.inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/)]);
    });

  it.each([start - 1, start, -1])("refuses non-newer live timestamp %s within two seconds", async at => {
    // Given an old or equal idle sample.
    const f = fixture();
    f.probe(() => f.live(undefined, at));
    // When compaction is requested.
    const result = await f.service.trigger(seat);
    // Then the sample never proves idle.
    expect(result).toMatchObject({ triggered: false, reason: "live_state_unavailable" });
    expect(f.elapsed()).toBe(2000);
    expect(f.inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/)]);
  });

  it("ignores a concurrent unrelated sidecar write for freshness", async () => {
    // Given old live state followed by a newer outer sidecar timestamp.
    const f = fixture();
    f.live(undefined, start - 1);
    f.probe(() => f.update({ updatedAt: new Date(start + 100).toISOString(),
      liveState: { probeId: f.inputs.at(-1)?.split(" ")[1] ?? "", isStreaming: false, isCompacting: false, updatedAt: new Date(start - 1).toISOString() } }));
    // When compaction is requested.
    const result = await f.service.trigger(seat);
    // Then only liveState freshness counts.
    expect(result).toMatchObject({ triggered: false, reason: "live_state_unavailable" });
    expect(f.inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/)]);
  });

  it("uses the pre-existing sidecar only to refuse an in-progress compaction", async () => {
    // Given an unfinished compaction.
    const f = fixture();
    f.update({ compaction: { reason: "manual", startedAt: new Date(start).toISOString() } });
    // When another request arrives.
    const result = await f.service.trigger(seat);
    // Then no input is sent.
    expect(result).toMatchObject({ triggered: false, reason: "already_in_progress" });
    expect(f.inputs).toEqual([]);
  });

  it("refuses ambiguous fresh flags instead of treating missing flags as idle", async () => {
    // Given a malformed but freshly timestamped sidecar from the file boundary.
    const f = fixture();
    f.probe(() => f.update(parsePiRunnerState(JSON.stringify({ ready: true, updatedAt: new Date(start + 1).toISOString(),
      liveState: { isStreaming: false, updatedAt: new Date(start + 1).toISOString() },
    })) ?? {}));
    // When compaction is requested.
    const result = await f.service.trigger(seat);
    // Then no compact input is sent.
    expect(result).toMatchObject({ triggered: false, reason: "live_state_unavailable" });
    expect(f.inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/)]);
  });

  it("refuses when compaction starts alongside an idle control reply", async () => {
    // Given a fresh idle sample followed by an independent compaction start.
    const f = fixture();
    f.probe(() => f.update({ liveState: { probeId: f.inputs.at(-1)?.split(" ")[1] ?? "", isStreaming: false, isCompacting: false, updatedAt: new Date(start + 1).toISOString() },
      compaction: { startedAt: new Date(start + 2).toISOString(), reason: "threshold" } }));
    // When compaction is requested.
    const result = await f.service.trigger(seat);
    // Then the newer durable in-progress record refuses submission.
    expect(result).toMatchObject({ triggered: false, reason: "already_in_progress" });
    expect(f.inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/)]);
  });

  it("bounds a hung tmux probe to two seconds and never submits late Enter", async () => {
    // Given a tmux paste that remains pending past the deadline.
    vi.useFakeTimers();
    let release: ((result: { ok: true }) => void) | undefined;
    const keys = vi.fn(async () => ({ ok: true as const }));
    const service = new PiCompactionService({ readSidecar: () => null, resolveTarget: () => "%7",
      inspectComposer: async () => "empty",
      tmux: { sendText: () => new Promise(resolve => { release = resolve; }), sendKeys: keys } });
    try {
      // When the two-second deadline elapses before paste completes.
      const pending = service.trigger(seat);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      release?.({ ok: true });
      await Promise.resolve();
      // Then refusal is bounded and no late Enter is emitted.
      expect(result).toMatchObject({ triggered: false, reason: "live_state_unavailable" });
      expect(keys).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["omp", "claude-code", "codex"])("rejects runtime %s before any input", async runtime => {
    // Given a non-Pi target.
    const f = fixture();
    // When it reaches this service.
    const result = await f.service.trigger({ ...seat, runtime });
    // Then no Pi control input leaks to another runtime.
    expect(result).toMatchObject({ triggered: false, reason: "runtime_filter" });
    expect(f.inputs).toEqual([]);
  });

  it("fails closed when a runner cannot answer the probe", async () => {
    // Given only a ready sidecar, as with an older runner.
    const f = fixture();
    // When no fresh response arrives.
    const result = await f.service.trigger(seat);
    // Then it times out without compaction.
    expect(result).toMatchObject({ triggered: false, reason: "live_state_unavailable" });
    expect(f.elapsed()).toBe(2000);
    expect(f.inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/)]);
  });

  it("reports unsupported compact RPC from the authoritative sidecar and refuses retry", async () => {
    // Given a durable unknown-command error from Pi.
    const f = fixture();
    f.update({ compaction: { reason: "manual", endedAt: new Date(start).toISOString(), errorMessage: "Unknown command: compact" } });
    // When state and a new request are read.
    const state = f.service.getState(seat.sessionName);
    const result = await f.service.trigger(seat);
    // Then unsupported is explicit and no retry is sent.
    expect(state).toMatchObject({ status: "unsupported" });
    expect(result).toMatchObject({ triggered: false, reason: "unsupported" });
    expect(f.inputs).toEqual([]);
  });

  it.each(["req-1", undefined])("reads completion solely from sidecar with identity %s", requestId => {
    // Given a terminal sidecar with optional request identity and no activity delivery.
    const f = fixture();
    f.update({ compaction: { requestId, reason: "manual", endedAt: new Date(start).toISOString(), aborted: false } });
    // When state is read.
    const state = f.service.getState(seat.sessionName);
    // Then terminal state and identity come from the producer.
    expect(state).toMatchObject({ status: "completed", compaction: { reason: "manual", endedAt: new Date(start).toISOString() },
      completionKey: requestId ?? `manual:${new Date(start).toISOString()}` });
    expect(f.inputs).toEqual([]);
  });
});
