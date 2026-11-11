import { describe, expect, it } from "vitest";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

function fixture(runtime: "pi" | "omp" = "pi") {
  const rpc: Record<string, unknown>[] = [];
  const states: PiRunnerState[] = [];
  const activity: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const io: RunnerIo = {
    sendRpc: cmd => { rpc.push(cmd); }, writeSidecar: state => { states.push(state); },
    postActivity: beat => { activity.push(beat); }, mirrorLine: line => { lines.push(line); },
    mirrorAppend: () => {}, now: () => "2026-11-11T10:00:01.000Z",
  };
  const core = new RunnerCore(io, { sessionName: "pi@test" }, { runtime });
  const reply = (data: Record<string, unknown>) => core.handlePiLine(JSON.stringify(data));
  core.start();
  reply({ type: "response", id: "pi-runner-get-state", data: { sessionFile: "/synthetic/session" } });
  return { core, rpc, states, activity, lines, reply };
}

describe("Pi live-state control", () => {
  it("dispatches exact control input under a distinct id without model activity", () => {
    // Given a ready runner.
    const f = fixture();
    const beats = f.activity.length;
    const lines = f.lines.length;
    // When control input arrives.
    f.core.handleUserBlock("/openrig-state probe-a");
    // Then only a distinct RPC request is emitted.
    expect(f.rpc.at(-1)).toEqual({ type: "get_state", id: "pi-runner-control-state:probe-a" });
    expect(f.activity).toHaveLength(beats);
    expect(f.lines).toHaveLength(lines);
  });

  it("writes live flags without changing readiness or identity", () => {
    // Given a ready runner and its identity.
    const f = fixture();
    const prior = f.states.at(-1);
    const beats = f.activity.length;
    // When the control reply carries a different identity.
    f.core.handleUserBlock("/openrig-state probe-a");
    f.reply({ type: "response", id: "pi-runner-control-state:probe-a", success: true,
      data: { isStreaming: false, isCompacting: true, sessionFile: "/wrong" } });
    // Then only the live-state projection changes.
    expect(f.states.at(-1)).toMatchObject({ ...prior,
      liveState: { probeId: "probe-a", isStreaming: false, isCompacting: true, updatedAt: "2026-11-11T10:00:01.000Z" } });
    expect(f.core.isReady()).toBe(true);
    expect(f.activity).toHaveLength(beats);
  });

  it.each([{ success: false, error: "Unknown command: get_state" }, { success: true, data: { isStreaming: false } }])(
    "keeps readiness unchanged and does not publish ambiguous control replies %j", response => {
      // Given a ready runner.
      const f = fixture();
      const writes = f.states.length;
      // When the probe fails or omits a flag.
      f.core.handleUserBlock("/openrig-state probe-a");
      f.reply({ type: "response", id: "pi-runner-control-state:probe-a", ...response });
      // Then neither readiness nor a fresh live-state record is produced.
      expect(f.core.isReady()).toBe(true);
      expect(f.states).toHaveLength(writes);
    });

  it.each([" /openrig-state", "/openrig-state ", "/openrig-state\ntext"])("keeps collision %j as prompt input", block => {
    // Given a Pi runner.
    const f = fixture();
    // When input is not the exact token.
    f.core.handleUserBlock(block);
    // Then normal prompt dispatch applies.
    expect(f.rpc.at(-1)).toMatchObject({ type: "prompt", message: block });
  });

  it("leaves OMP input unchanged", () => {
    // Given an OMP runner.
    const f = fixture("omp");
    // When the Pi token is entered.
    f.core.handleUserBlock("/openrig-state");
    // Then it remains ordinary OMP model input.
    expect(f.rpc.at(-1)).toMatchObject({ type: "prompt", message: "/openrig-state" });
  });
});
