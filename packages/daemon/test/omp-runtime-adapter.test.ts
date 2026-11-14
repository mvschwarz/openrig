import { describe, expect, it, vi } from "vitest";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RunnerGrantIssuer } from "../src/domain/runner-grant-launch.js";

const stateRoot = "/openrig/state/omp";
const seat = "omp-worker@rig";
const parentFile = "/openrig/state/omp/parent/sessions/parent.jsonl";
const currentFile = `/openrig/state/omp/${seat}/sessions/current.jsonl`;
const paths = piSeatPaths(stateRoot, seat);

function fakeSeat(files: Record<string, string>) {
  const fs = {
    readFile: (path: string) => files[path]!,
    writeFile: (path: string, content: string) => { files[path] = content; },
    exists: (path: string) => path in files,
    mkdirp: () => {},
  };
  const tmux = {
    // Pi-family launches go through the staged shell-command path.
    sendShellCommand: vi.fn(async (_session: string, command: string) => {
      const launchId = /--launch-id '([^']+)'/.exec(command)?.[1];
      files[paths.runnerStatePath] = JSON.stringify({ ready: true, launchId, sessionFile: currentFile, updatedAt: "t" });
      return { ok: true };
    }),
    sendKeys: vi.fn(async () => ({ ok: true })),
    capturePaneContent: vi.fn(async () => ""),
  } as unknown as TmuxAdapter;
  return { fs, tmux };
}

describe("OMP runtime adapter exact session tokens", () => {
  it.each([true, false])("binds fresh OMP authority to builtin0 and finishes exact grant, ready=%s", async ready => {
      const { fs, tmux } = fakeSeat({});
      const finish = vi.fn(async (_ok: boolean) => {}), dispatched = vi.fn();
      const runnerGrants = vi.fn<RunnerGrantIssuer>(async (_binding, runtime, runId, runner) => {
        expect([runtime, runId, runner]).toEqual(["omp", "omp-fresh", 0]);
        return { grantId: "omp-grant", generation: "generation", wrap: (command: string) => `private-omp ${command}`, dispatched, finish };
      });
      if (!ready) vi.mocked(tmux.sendShellCommand).mockResolvedValue({ ok: false, code: "error", message: "dispatch refused" });
      const adapter = new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", runnerGrants,
        newLaunchId: () => "omp-fresh", sleep: async () => {} });
      const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "floor" } as never, { name: seat });
      expect(result.ok).toBe(ready);
      expect(runnerGrants).toHaveBeenCalledOnce();
      expect(vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1]).toContain("private-omp");
      expect(finish).toHaveBeenCalledExactlyOnceWith(ready);
      expect(dispatched).toHaveBeenCalledTimes(ready ? 1 : 0);
      // OMP can be ready before its first persisted turn creates the native file.
      if (result.ok) {
        expect(result.activityGrantId).toBe("omp-grant");
        expect(result.resumeToken).toBeUndefined();
      }
  });

  it.each(["launch", "resume"] as const)("%s revokes only its issued authority on readiness mismatch", async owner => {
    const requested = `/openrig/state/omp/${seat}/sessions/requested.jsonl`;
    const { fs, tmux } = fakeSeat({ [requested]: "history", [currentFile]: "other history" });
    const finish = vi.fn(async (_ok: boolean) => {}), dispatched = vi.fn();
    const begin = async () => ({ grantId: "own-omp-grant", generation: "generation", wrap: (command: string) => command, dispatched, finish });
    const result = owner === "launch"
      ? await new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", runnerGrants: begin, sleep: async () => {} })
        .launchHarness({ tmuxSession: seat, cwd: "/work" } as never, { name: seat, resumeToken: requested })
      : await new OmpResumeAdapter(tmux, fs, { stateRoot, runnerEntryPath: "/daemon/pi-runner.js" }, { runnerGrant: begin, sleep: async () => {} })
        .resume(seat, "omp_session_file", requested, "/work");
    expect(result.ok).toBe(false);
    expect(dispatched).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([true, false])("binds direct OMP resume once and preserves unbound fallback on missing authority=%s", async unavailable => {
      const { fs, tmux } = fakeSeat({ [currentFile]: "history" });
      const finish = vi.fn(async (_ok: boolean) => {}), dispatched = vi.fn();
      const runnerGrant = vi.fn(async () => {
        if (unavailable) throw new Error("missing Core binding");
        return { grantId: "omp-resume-grant", generation: "generation", wrap: (command: string) => `private-omp ${command}`, dispatched, finish };
      });
      const adapter = new OmpResumeAdapter(tmux, fs, { stateRoot, runnerEntryPath: "/daemon/pi-runner.js" },
        { runnerGrant, newLaunchId: () => "omp-resume", sleep: async () => {} });
      const result = await adapter.resume(seat, "omp_session_file", currentFile, "/work", "openrouter/example", "floor");
      expect(result.ok).toBe(true);
      expect(runnerGrant).toHaveBeenCalledExactlyOnceWith(seat, "omp-resume", "/work");
      expect(vi.mocked(tmux.sendShellCommand)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1].includes("private-omp")).toBe(!unavailable);
      if (result.ok && unavailable) expect(result.warnings?.join(" ")).toContain("unbound install-token");
      expect(finish).toHaveBeenCalledTimes(unavailable ? 0 : 1);
      if (!unavailable) expect(finish).toHaveBeenCalledWith(true);
  });

  it.each(["issue", "activation"] as const)("keeps fresh OMP's lazy session success and warning after optional %s failure", async phase => {
    const { fs, tmux } = fakeSeat({});
    const finish = vi.fn(async (_ok: boolean) => {});
    const dispatched = vi.fn(() => { throw new Error("activation unavailable"); });
    const runnerGrants = vi.fn<RunnerGrantIssuer>(async () => {
      if (phase === "issue") throw new Error("binding unavailable");
      return { grantId: "own-omp", generation: "g", wrap: (command: string) => command, dispatched, finish };
    });
    const result = await new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", runnerGrants,
      newLaunchId: () => "optional-omp", sleep: async () => {} })
      .launchHarness({ tmuxSession: seat, cwd: "/work" } as never, { name: seat });
    expect(result.ok).toBe(true);
    expect(runnerGrants).toHaveBeenCalledOnce();
    expect(tmux.sendShellCommand).toHaveBeenCalledOnce();
    if (result.ok) {
      expect(result.resumeToken).toBeUndefined();
      expect(result.activityGrantId).toBeUndefined();
      expect(result.warnings?.join(" ")).toContain(phase === "issue" ? "unbound install-token" : "nothing was replayed");
    }
    expect(dispatched).toHaveBeenCalledTimes(phase === "activation" ? 1 : 0);
    expect(finish).toHaveBeenCalledTimes(phase === "activation" ? 1 : 0);
    if (phase === "activation") expect(finish).toHaveBeenCalledWith(false);
  });

  it("resumes only the OMP token, and returns the same validated session file", async () => {
    const { fs, tmux } = fakeSeat({ [currentFile]: "session" });
    const adapter = new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", sleep: async () => {} });
    const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "floor" } as never, { name: seat, resumeToken: currentFile });
    expect(result).toEqual({ ok: true, resumeToken: currentFile, resumeType: "omp_session_file", appliedLaunch: { runtime: "omp", axis: "permission", state: "observed", value: "always-ask" } });
    expect(vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1]).toContain(`--runtime omp --approval-mode always-ask --model 'openrouter/example' --session '${currentFile}'`);
  });

  it("fails an exact resume when the runner comes up on a different session file", async () => {
    const requested = `/openrig/state/omp/${seat}/sessions/requested.jsonl`;
    const { fs, tmux } = fakeSeat({ [requested]: "history", [currentFile]: "other session" });
    const adapter = new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", sleep: async () => {} });
    const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "floor" } as never, { name: seat, resumeToken: requested });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/does not report the requested session file/) });
  });

  it("forks a parent exact file and captures a distinct child token", async () => {
    const { fs, tmux } = fakeSeat({ [parentFile]: "session", [currentFile]: "forked session" });
    const adapter = new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", sleep: async () => {} });
    const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "full_bypass" } as never, { name: seat, forkSource: { kind: "native_id", value: parentFile } });
    expect(result).toMatchObject({ ok: true, resumeToken: currentFile, resumeType: "omp_session_file", appliedLaunch: { runtime: "omp", axis: "permission", value: "yolo" } });
    expect(vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1]).toContain(`--runtime omp --approval-mode yolo --model 'openrouter/example' --fork '${parentFile}'`);
  });

  it("reports a ready fresh seat without claiming an unwritten resume token", async () => {
    const { fs, tmux } = fakeSeat({});
    const adapter = new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", sleep: async () => {} });
    const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "floor" } as never, { name: seat });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("launch failed");
    expect(result.resumeToken).toBeUndefined();
    expect(adapter.readSessionFile(seat)).toEqual({ ok: false, reason: "missing_sidecar" });
    fs.writeFile(currentFile, "persisted first turn");
    expect(adapter.readSessionFile(seat)).toEqual({ ok: true, sessionFile: currentFile });
  });

  it("resume adapter refuses Pi tokens and proves the requested file via sidecar", async () => {
    const { fs, tmux } = fakeSeat({ [currentFile]: "session" });
    const adapter = new OmpResumeAdapter(tmux, fs, { stateRoot, runnerEntryPath: "/daemon/pi-runner.js" }, { pollMs: 1, maxWaitMs: 1, sleep: async () => {} });
    expect(adapter.canResume("pi_session_file", currentFile)).toBe(false);
    const result = await adapter.resume(seat, "omp_session_file", currentFile, "/work", "openrouter/example", "floor");
    expect(result).toMatchObject({ ok: true, appliedLaunch: { runtime: "omp", axis: "permission", value: "always-ask" } });
    expect(vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1]).toContain(`--runtime omp --approval-mode always-ask --model 'openrouter/example' --session '${currentFile}'`);
  });
});
