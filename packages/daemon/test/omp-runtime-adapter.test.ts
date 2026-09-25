import { describe, expect, it, vi } from "vitest";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

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
    sendText: vi.fn(async (_session: string, command: string) => {
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
  it("resumes only the OMP token, and returns the same validated session file", async () => {
    const { fs, tmux } = fakeSeat({ [currentFile]: "session" });
    const adapter = new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", sleep: async () => {} });
    const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "floor" } as never, { name: seat, resumeToken: currentFile });
    expect(result).toEqual({ ok: true, resumeToken: currentFile, resumeType: "omp_session_file", appliedLaunch: { runtime: "omp", axis: "permission", state: "observed", value: "always-ask" } });
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).toContain(`--runtime omp --approval-mode always-ask --model 'openrouter/example' --session '${currentFile}'`);
  });

  it("forks a parent exact file and captures a distinct child token", async () => {
    const { fs, tmux } = fakeSeat({ [parentFile]: "session", [currentFile]: "forked session" });
    const adapter = new OmpRuntimeAdapter({ fsOps: fs, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", sleep: async () => {} });
    const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "full_bypass" } as never, { name: seat, forkSource: { kind: "native_id", value: parentFile } });
    expect(result).toMatchObject({ ok: true, resumeToken: currentFile, resumeType: "omp_session_file", appliedLaunch: { runtime: "omp", axis: "permission", value: "yolo" } });
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).toContain(`--runtime omp --approval-mode yolo --model 'openrouter/example' --fork '${parentFile}'`);
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
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).toContain(`--runtime omp --approval-mode always-ask --model 'openrouter/example' --session '${currentFile}'`);
  });
});
