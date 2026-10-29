// Prime-agent runner contract tests (pure, no live runner). Mirrors the
// pure-contract style of test/omp-runner.test.ts + test/pi-runner.test.ts.
// Written to the target contract; source changes land in parallel (seats A/B).

import { describe, it, expect } from "vitest";
import { buildPiRunnerCommand, buildPiChildArgs, type RunnerRuntime } from "../src/adapters/pi-runner-protocol.js";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";

// Compile-time contract: RunnerRuntime accepts "prime-agent".
const primeAgentRuntime: RunnerRuntime = "prime-agent";

const launch = {
  runtime: primeAgentRuntime,
  runnerEntryPath: "/daemon/prime-agent-runner.js",
  sessionName: "prime-worker@rig",
  stateRoot: "/openrig/state/prime",
  cwd: "/work",
  launchId: "attempt-1",
  trust: "no-approve" as const,
  model: "x/y",
};

describe("prime-agent runner command", () => {
  it("declares the prime-agent runtime without OMP approval-mode or --name", () => {
    const cmd = buildPiRunnerCommand(launch);
    expect(cmd).toContain("--runtime prime-agent");
    expect(cmd).not.toContain("--approval-mode");
    expect(cmd).not.toContain("--name");
    expect(cmd).toContain("--model");
  });
});

describe("prime-agent child args", () => {
  it("runs rpc mode against the pinned session dir with exact-file resume", () => {
    const argv = buildPiChildArgs({
      runtime: primeAgentRuntime,
      sessionsDir: "/openrig/state/prime/sessions",
      sessionName: "prime-worker@rig",
      trust: "no-approve",
      sessionFile: "/abs/s.json",
      model: "x/y",
      thinking: "low",
    });
    expect(argv).toEqual(expect.arrayContaining(["--mode", "rpc"]));
    expect(argv).toContain("--session-dir");
    expect(argv[argv.indexOf("--session-dir") + 1]).toBe("/openrig/state/prime/sessions");
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("/abs/s.json");
    expect(argv).toEqual(expect.arrayContaining(["--thinking", "low"]));
    expect(argv).not.toContain("--name");
    expect(argv).not.toContain("--approve");
  });
});

describe("prime-agent resume tokens", () => {
  it("maps the runtime to the prime_agent_session_file resume type", () => {
    expect(resumeTypeForRuntime("prime-agent")).toBe("prime_agent_session_file");
  });

  it("accepts an absolute session-file path and rejects empty tokens", () => {
    const ok = validateResumeToken("prime-agent", "/abs/session.jsonl");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.resumeType).toBe("prime_agent_session_file");
    const bad = validateResumeToken("prime-agent", "");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain("token value");
  });
});
