import { describe, expect, it } from "vitest";
import { buildPiChildArgs, buildPiChildEnv, buildPiRunnerCommand, piChildSpawnOptions } from "../src/adapters/pi-runner-protocol.js";

const sessionsDir = "/state/worker/sessions";
const sessionFile = "/state/worker/sessions/session.jsonl";
const commonChild = {
  runtime: "omp" as const,
  sessionsDir,
  sessionName: "worker@rig",
  model: "anthropic/claude-sonnet",
  trust: "approve" as const,
  sessionFile,
};

const commonRunner = {
  runtime: "omp" as const,
  runnerEntryPath: "/daemon/pi-runner.js",
  sessionName: "worker@rig",
  stateRoot: "/state",
  cwd: "/work",
  model: "anthropic/claude-sonnet",
  trust: "approve" as const,
  launchId: "attempt-1",
  sessionFile,
};

describe("OMP native TUI launch arguments", () => {
  it("keeps child args and runner command byte-identical in mirror mode", () => {
    const expectedChild = [
      "--mode", "rpc",
      "--session-dir", sessionsDir,
      "--approval-mode", "yolo",
      "--model", "anthropic/claude-sonnet",
      "--session", sessionFile,
    ];
    const expectedCommand = "node '/daemon/pi-runner.js' --session-name 'worker@rig' --state-root '/state' --cwd '/work' --launch-id 'attempt-1' --runtime omp --approval-mode yolo --model 'anthropic/claude-sonnet' --session '/state/worker/sessions/session.jsonl'";

    expect(buildPiChildArgs(commonChild)).toEqual(expectedChild);
    expect(buildPiChildArgs({ ...commonChild, ui: "mirror" })).toEqual(expectedChild);
    expect(buildPiRunnerCommand(commonRunner)).toBe(expectedCommand);
    expect(buildPiRunnerCommand({ ...commonRunner, ui: "mirror" })).toBe(expectedCommand);
  });

  it("uses interactive child args and retains model and session in native mode", () => {
    const args = buildPiChildArgs({
      ...commonChild,
      ui: "native",
      bridgeExtensionPath: "/extensions/openrig-bridge.js",
    });

    expect(args).not.toContain("--mode");
    expect(args).not.toContain("rpc");
    expect(args).toEqual([
      "--session-dir", sessionsDir,
      "--approval-mode", "yolo",
      "--trusted-extension", "/extensions/openrig-bridge.js",
      "--model", "anthropic/claude-sonnet",
      "--session", sessionFile,
    ]);
  });

  it("adds native UI flag to runner command", () => {
    expect(buildPiRunnerCommand({ ...commonRunner, ui: "native" })).toBe(
      "node '/daemon/pi-runner.js' --session-name 'worker@rig' --state-root '/state' --cwd '/work' --launch-id 'attempt-1' --runtime omp --approval-mode yolo --ui native --model 'anthropic/claude-sonnet' --session '/state/worker/sessions/session.jsonl'",
    );
  });

  it("sets bridge socket env only when path is provided", () => {
    const base = { runtime: "omp" as const, agentDir: "/state/worker/agent", sessionsDir };
    const withoutSocket = buildPiChildEnv({}, base);
    expect(withoutSocket).not.toHaveProperty("OPENRIG_OMP_BRIDGE_SOCKET");

    expect(buildPiChildEnv({}, { ...base, bridgeSocketPath: "/state/worker/omp-bridge.sock" }))
      .toHaveProperty("OPENRIG_OMP_BRIDGE_SOCKET", "/state/worker/omp-bridge.sock");
  });
});

describe("the native TUI child's spawn wiring", () => {
  it("hands the pane's terminal to the native child and keeps the pipes in mirror mode", () => {
    const env = { PATH: "/bin", HOME: "/state/worker" };
    const native = piChildSpawnOptions("native", { cwd: "/work", env });

    // A piped stdin leaves the child's pty at 0x0 with no SIGWINCH, so the
    // TUI could neither size itself nor reflow when the pane was resized.
    expect(native.stdio[0]).toBe("inherit");
    expect(native.stdio[1]).toBe("inherit");
    // The child's stderr stays a pipe: the runner still reads the startup
    // error tail out of it.
    expect(native.stdio[2]).toBe("pipe");
    expect(native.cwd).toBe("/work");
    expect(native.env).toEqual(env);

    // Mirror mode keeps the pipes: there the runner owns the child's input
    // and output.
    expect(piChildSpawnOptions("mirror", { cwd: "/work", env }).stdio).toEqual(["pipe", "pipe", "pipe"]);
  });
});
