import { describe, expect, it } from "vitest";
import { RunnerCore, parseRunnerArgs, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const sessionName = "omp-tui-worker@rig";
const sessionFile = "/openrig/state/omp/omp-tui-worker@rig/sessions/2026_1.jsonl";

function core(opts: { bridgeUi?: boolean } = {}) {
  const rpc: Record<string, unknown>[] = [];
  const activity: Record<string, unknown>[] = [];
  const sidecars: PiRunnerState[] = [];
  const mirror: string[] = [];
  const stops: number[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => { rpc.push(cmd); },
    mirrorLine: (line) => { mirror.push(line); },
    mirrorAppend: (text) => { mirror.push(text); },
    postActivity: (payload) => { activity.push(payload); },
    writeSidecar: (state) => { sidecars.push(state); },
    stopChild: (code) => { stops.push(code); },
    sessionFileExists: () => true,
    now: () => "2026-10-21T12:00:00Z",
  };
  const runner = new RunnerCore(io, { sessionName, nodeId: "node-1", launchId: "attempt-1" }, { runtime: "omp", bridgeUi: opts.bridgeUi });
  return { runner, rpc, activity, mirror, sidecars, stops };
}

describe("the runner's native-UI mode", () => {
  it("is an explicit OMP-only option", () => {
    const ompArgs = parseRunnerArgs([
      "--runtime", "omp", "--approval-mode", "yolo",
      "--session-name", sessionName, "--state-root", "/state", "--cwd", "/work", "--launch-id", "attempt-1",
      "--ui", "native",
    ]);
    expect(ompArgs.ui).toBe("native");
    // Pi keeps its own shape: TUI-native is never a hidden mode there.
    expect(() => parseRunnerArgs([
      "--approve", "--session-name", sessionName, "--state-root", "/state", "--cwd", "/work", "--launch-id", "attempt-1",
      "--ui", "native",
    ])).toThrow(/requires --runtime omp/);
    expect(() => parseRunnerArgs([
      "--runtime", "omp", "--approval-mode", "yolo",
      "--session-name", sessionName, "--state-root", "/state", "--cwd", "/work", "--launch-id", "attempt-1",
      "--ui", "hologram",
    ])).toThrow(/unsupported UI mode/);
  });

  it("leaves approvals to OMP's own TUI instead of cancelling them", () => {
    const { runner, rpc, activity, mirror } = core({ bridgeUi: true });
    runner.handlePiLine(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm" }));
    expect(rpc.filter((cmd) => cmd.type === "extension_ui_response")).toHaveLength(0);
    expect(activity.filter((payload) => payload.subtype === "permission_prompt")).toHaveLength(0);
    expect(mirror.join("\n")).not.toMatch(/cancelled/i);
  });

  it("becomes ready from the bridge's session identity", () => {
    const { runner, sidecars, activity, mirror } = core({ bridgeUi: true });
    expect(runner.isReady()).toBe(false);
    runner.adoptSessionIdentity({ sessionId: "session-1", sessionFile });
    expect(runner.isReady()).toBe(true);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, sessionFile });
    expect(activity.at(-1)).toMatchObject({ eventFamily: "session_identity", sessionId: "session-1", sessionFile });
    expect(mirror.join("\n")).toMatch(/READY/);
  });

  it("clears readiness on bridge disconnect and restores it after reconnect", () => {
    const { runner, sidecars, mirror } = core({ bridgeUi: true });
    runner.adoptSessionIdentity({ sessionId: "session-1", sessionFile });
    expect(runner.isReady()).toBe(true);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, sessionFile });

    runner.markBridgeDisconnected();
    expect(runner.isReady()).toBe(false);
    expect(sidecars.at(-1)).toMatchObject({ ready: false, sessionFile });
    expect(mirror.join("\n")).toContain("[omp-runner] NOT READY bridge disconnected");

    runner.adoptSessionIdentity({ sessionId: "session-1", sessionFile });
    expect(runner.isReady()).toBe(true);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, sessionFile });
  });

  it("waits for the identity instead of stopping the seat when the state reply has none", () => {
    const { runner, rpc, stops, mirror } = core({ bridgeUi: true });
    runner.start();
    const stateRequest = rpc.find((cmd) => cmd.type === "get_state");
    expect(stateRequest).toBeTruthy();
    runner.handlePiLine(JSON.stringify({ type: "response", id: stateRequest!.id, success: true, data: {} }));
    expect(stops).toHaveLength(0);
    expect(runner.isReady()).toBe(false);
    // The identity arrives right after; the seat becomes ready without a relaunch.
    runner.adoptSessionIdentity({ sessionId: "session-1", sessionFile });
    expect(runner.isReady()).toBe(true);
    expect(stops).toHaveLength(0);
    expect(mirror.join("\n")).not.toMatch(/no session file/);
  });

  it("still fails an RPC seat that cannot produce a resume token", () => {
    const { runner, rpc, stops } = core();
    runner.start();
    const stateRequest = rpc.find((cmd) => cmd.type === "get_state");
    runner.handlePiLine(JSON.stringify({ type: "response", id: stateRequest!.id, success: true, data: {} }));
    expect(stops).toHaveLength(1);
    expect(runner.isReady()).toBe(false);
  });
});
