import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_RUNTIMES } from "../src/domain/built-in-runtimes.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { OmpTuiRuntimeAdapter } from "../src/adapters/omp-tui-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { buildPiRunnerCommand, piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { resumeTypeForRuntime, validateResumeToken } from "../src/domain/resume-token-validation.js";

const seat = "omp-worker@rig";
const runnerEntryPath = "/daemon/pi-runner.js";
const cwd = "/work";
const model = "openrouter/example";
const launchId = "attempt-1";

function fakeSeat(stateRoot: string, sessionFile: string) {
  const paths = piSeatPaths(stateRoot, seat);
  const files: Record<string, string> = { [sessionFile]: "session" };
  const fs = {
    readFile: (path: string) => files[path]!,
    writeFile: (path: string, content: string) => { files[path] = content; },
    exists: (path: string) => path in files,
    mkdirp: () => {},
  };
  const sendShellCommand = vi.fn(async (_session: string, command: string) => {
    const id = /--launch-id '([^']+)'/.exec(command)?.[1];
    files[paths.runnerStatePath] = JSON.stringify({ ready: true, launchId: id, sessionFile, updatedAt: "t" });
    return { ok: true as const };
  });
  const tmux = {
    sendShellCommand,
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: vi.fn(async () => ""),
  } as unknown as TmuxAdapter;
  return { fs, tmux, sendShellCommand };
}
describe("omp-tui runtime adapter", () => {
  it("is a built-in runtime with its own daemon-side identity", () => {
    expect(BUILT_IN_RUNTIMES.has("omp-tui")).toBe(true);
    const { fs, tmux } = fakeSeat("/openrig/state/omp", "/openrig/state/omp/seat/sessions/session.jsonl");
    const adapter = new OmpTuiRuntimeAdapter({ tmux, fsOps: fs, stateRoot: "/openrig/state/omp", runnerEntryPath, sleep: async () => {} });
    expect(adapter.runtime).toBe("omp-tui");
  });

  it("launches OMP native TUI, keeps OMP mirror command unchanged, and leaves Pi command unchanged", async () => {
    const ompRoot = "/openrig/state/omp";
    const ompSession = `${ompRoot}/${seat}/sessions/current.jsonl`;
    const tuiFixture = fakeSeat(ompRoot, ompSession);
    const tuiAdapter = new OmpTuiRuntimeAdapter({ tmux: tuiFixture.tmux, fsOps: tuiFixture.fs, stateRoot: ompRoot, runnerEntryPath, sleep: async () => {}, newLaunchId: () => launchId });
    const tuiResult = await tuiAdapter.launchHarness(
      { tmuxSession: seat, cwd, model, launchPosture: "floor" } as never,
      { name: seat },
    );
    expect(tuiResult.ok).toBe(true);
    const tuiCommand = tuiFixture.sendShellCommand.mock.calls[0]?.[1];
    expect(tuiCommand).toContain("--runtime omp");
    expect(tuiCommand).toContain("--ui native");

    const ompFixture = fakeSeat(ompRoot, ompSession);
    const ompAdapter = new OmpRuntimeAdapter({ tmux: ompFixture.tmux, fsOps: ompFixture.fs, stateRoot: ompRoot, runnerEntryPath, sleep: async () => {}, newLaunchId: () => launchId });
    const ompResult = await ompAdapter.launchHarness(
      { tmuxSession: seat, cwd, model, launchPosture: "floor" } as never,
      { name: seat },
    );
    expect(ompResult.ok).toBe(true);
    const ompCommand = ompFixture.sendShellCommand.mock.calls[0]?.[1] ?? "";
    expect(ompCommand).toContain("--runtime omp");
    expect(ompCommand).not.toContain("--ui");

    const piRoot = "/openrig/state/pi";
    const piSession = `${piRoot}/${seat}/sessions/current.jsonl`;
    const piFixture = fakeSeat(piRoot, piSession);
    const piAdapter = new PiRuntimeAdapter({ tmux: piFixture.tmux, fsOps: piFixture.fs, stateRoot: piRoot, runnerEntryPath, sleep: async () => {}, newLaunchId: () => launchId });
    const piResult = await piAdapter.launchHarness(
      { tmuxSession: seat, cwd, model, launchPosture: "floor" } as never,
      { name: seat },
    );
    expect(piResult.ok).toBe(true);
    expect(piFixture.sendShellCommand.mock.calls[0]?.[1]).toBe(buildPiRunnerCommand({
      runnerEntryPath,
      sessionName: seat,
      stateRoot: piRoot,
      cwd,
      model,
      trust: "no-approve",
      launchId,
    }));
  });

  it("resumes an omp-tui session file using the OMP runtime and native UI", async () => {
    const stateRoot = "/openrig/state/omp";
    const sessionFile = `${stateRoot}/${seat}/sessions/current.jsonl`;
    const fixture = fakeSeat(stateRoot, sessionFile);
    const adapter = new OmpResumeAdapter(
      fixture.tmux,
      fixture.fs,
      { stateRoot, runnerEntryPath },
      { pollMs: 1, maxWaitMs: 1, sleep: async () => {}, newLaunchId: () => launchId },
    );
    expect(adapter.canResume("omp-tui_session_file", sessionFile)).toBe(true);
    const result = await adapter.resume(seat, "omp-tui_session_file", sessionFile, cwd, model, "floor");
    expect(result.ok).toBe(true);
    const command = fixture.sendShellCommand.mock.calls[0]?.[1] ?? "";
    expect(command).toContain("--runtime omp");
    expect(command).toContain("--ui native");
    expect(command).toContain(`--session '${sessionFile}'`);
  });
  it("keeps OMP resumes on mirror UI", async () => {
    const stateRoot = "/openrig/state/omp";
    const sessionFile = `${stateRoot}/${seat}/sessions/current.jsonl`;
    const fixture = fakeSeat(stateRoot, sessionFile);
    const adapter = new OmpResumeAdapter(
      fixture.tmux,
      fixture.fs,
      { stateRoot, runnerEntryPath },
      { pollMs: 1, maxWaitMs: 1, sleep: async () => {}, newLaunchId: () => launchId },
    );
    const result = await adapter.resume(seat, "omp_session_file", sessionFile, cwd, model, "floor");
    expect(result.ok).toBe(true);
    expect(fixture.sendShellCommand.mock.calls[0]?.[1]).not.toContain("--ui");
  });
  it("validates and captures OMP-TUI tokens from the OMP runner sidecar while preserving OMP tokens", async () => {
    const sessionFile = `/openrig/state/omp/${seat}/sessions/current.jsonl`;
    const readSessionFile = vi.fn(() => ({ ok: true as const, sessionFile }));
    expect(resumeTypeForRuntime("omp-tui")).toBe("omp-tui_session_file");
    expect(validateResumeToken("omp-tui", sessionFile)).toEqual({
      ok: true,
      resumeType: "omp-tui_session_file",
      token: sessionFile,
    });
    expect(await deriveResumeToken(
      { runtime: "omp-tui", sessionName: seat },
      { ompRunnerStateStore: { readSessionFile } },
    )).toEqual({ outcome: "captured", resumeType: "omp-tui_session_file", token: sessionFile });
    expect(readSessionFile).toHaveBeenCalledWith(seat);

    expect(await deriveResumeToken(
      { runtime: "omp", sessionName: seat },
      { ompRunnerStateStore: { readSessionFile } },
    )).toEqual({ outcome: "captured", resumeType: "omp_session_file", token: sessionFile });
    expect(readSessionFile).toHaveBeenCalledTimes(2);
  });
});
