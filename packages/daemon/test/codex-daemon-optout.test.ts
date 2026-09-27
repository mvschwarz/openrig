import { mockShellCommand } from "./helpers/shell-command-mock.js";
import fs from "node:fs";
import nodePath from "node:path";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { buildCodexResumeCore } from "../src/domain/native-resume-probe.js";
import { codexDaemonSupportProbe, probeCodexDaemonSupport, type CodexDaemonSupport, type CodexDaemonSupportDetector } from "../src/domain/codex-daemon-support.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #69 — Codex versions using a shared app-server daemon can run tool shells there, so a seat's tools
// can inherit another seat's OpenRig identity. Supported binaries must launch with
// --no-daemon on every path; a positively legacy binary keeps its current invocation;
// an undeterminable binary must not be launched as if it were isolated.

const SUPPORTED_HELP = [
  "Codex CLI",
  "",
  "Usage: codex [OPTIONS] [PROMPT]",
  "       codex [OPTIONS] <COMMAND> [ARGS]",
  "",
  "Options:",
  "      --no-alt-screen  Disable alternate screen mode",
  "      --no-daemon      Run without the shared background server, even if it is already running",
  "",
].join("\n");
const LEGACY_HELP = SUPPORTED_HELP.split("\n").filter((line) => !line.includes("--no-daemon")).join("\n");

const supported: CodexDaemonSupport = { kind: "supported" };
const legacy: CodexDaemonSupport = { kind: "legacy" };
const unknown: CodexDaemonSupport = { kind: "unknown", detail: "codex --help failed: spawn codex ENOENT" };

// Every process seam is fake. No real Codex, shell, tmux, startup or database runs here.
const processMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execSync: vi.fn<() => string>(() => { throw new Error("Unexpected synchronous process execution"); }),
}));
vi.mock("node:child_process", () => processMocks);
beforeEach(() => {
  processMocks.execFile.mockReset();
  processMocks.execSync.mockReset().mockImplementation(() => { throw new Error("Unexpected synchronous process execution"); });
});

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter);
}

const mockFs = (): CodexAdapterFsOps => ({
  readFile: () => { throw new Error("not found"); },
  writeFile: () => {},
  exists: () => false,
  mkdirp: () => {},
  listFiles: () => [],
});

const binding = (): NodeBinding => ({
  id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project dir", model: "gpt-5.5",
});

const sentCommands = (tmux: TmuxAdapter) =>
  (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1]));

type LaunchKind = "fresh" | "fork" | "resume";
async function launch(kind: LaunchKind, support: CodexDaemonSupport | undefined) {
  const tmux = mockTmux();
  const detectDaemonSupport = vi.fn<CodexDaemonSupportDetector>(async () => support!);
  const adapter = new CodexRuntimeAdapter({
    tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {},
    ...(support ? { detectDaemonSupport } : {}),
  });
  const opts = kind === "fork"
    ? { name: "dev-qa@test-rig", forkSource: { kind: "native_id" as const, value: "parent thread" } }
    : kind === "resume"
      ? { name: "dev-qa@test-rig", resumeToken: "sess 456" }
      : { name: "dev-qa@test-rig" };
  const result = await adapter.launchHarness(binding(), opts);
  return { result, commands: sentCommands(tmux), detectDaemonSupport };
}

describe("#69 probeCodexDaemonSupport", () => {
  it("classifies one help run: flag listed, flag absent, failure, non-Codex output", async () => {
    const runHelp = vi.fn(async () => SUPPORTED_HELP);
    expect(await probeCodexDaemonSupport(runHelp)).toEqual({ kind: "supported" });
    expect(runHelp).toHaveBeenCalledTimes(1);

    expect(await probeCodexDaemonSupport(async () => LEGACY_HELP)).toEqual({ kind: "legacy" });

    const failed = await probeCodexDaemonSupport(async () => { throw new Error("spawn codex ENOENT"); });
    expect(failed.kind).toBe("unknown");
    expect(failed.kind === "unknown" && failed.detail).toMatch(/ENOENT/);

    const odd = await probeCodexDaemonSupport(async () => "zsh: command not found: codex");
    expect(odd.kind).toBe("unknown");
  });

  it("another CLI's help that lists --no-daemon is unknown, not supported", async () => {
    const other = "Other CLI\n\nUsage: other [OPTIONS]\n\nOptions:\n      --no-daemon  Run in the foreground\n";
    expect((await probeCodexDaemonSupport(async () => other)).kind).toBe("unknown");
    expect((await probeCodexDaemonSupport(async () => other.replace("Usage: other", "Usage: codex-other"))).kind).toBe("unknown");
  });

  it("does not mistake --no-daemon inside other text for the option", async () => {
    const mention = `${LEGACY_HELP}\n  agents  Browse sessions (use codex --no-daemon-free mode)\n`;
    expect(await probeCodexDaemonSupport(async () => mention)).toEqual({ kind: "legacy" });
    expect(await probeCodexDaemonSupport(async () => `${LEGACY_HELP}\n --no-daemon-free`)).toEqual({ kind: "legacy" });
    expect(await probeCodexDaemonSupport(async () => `${LEGACY_HELP}\n --no-daemon`)).toEqual({ kind: "supported" });
  });
});

describe("#69 CodexRuntimeAdapter.launchHarness opts out of the shared daemon when supported", () => {
  for (const kind of ["fresh", "fork", "resume"] as const) {
    it(`${kind}: supported adds --no-daemon right after codex; legacy is unchanged; one probe per launch`, async () => {
      const baseline = await launch(kind, undefined);
      const legacyRun = await launch(kind, legacy);
      const supportedRun = await launch(kind, supported);

      expect(baseline.commands).toHaveLength(1);
      expect(baseline.commands[0]).toMatch(/^codex /);
      expect(legacyRun.commands).toEqual(baseline.commands);
      expect(supportedRun.commands).toEqual([baseline.commands[0]!.replace(/^codex /, "codex --no-daemon ")]);
      expect(supportedRun.detectDaemonSupport).toHaveBeenCalledTimes(1);
      expect(supportedRun.detectDaemonSupport).toHaveBeenCalledWith("/project dir");
      expect(legacyRun.detectDaemonSupport).toHaveBeenCalledTimes(1);
    });

    it(`${kind}: unknown support fails with an actionable message and sends nothing`, async () => {
      const run = await launch(kind, unknown);
      expect(run.result.ok).toBe(false);
      expect(!run.result.ok && run.result.error).toMatch(/--no-daemon/);
      expect(!run.result.ok && run.result.error).toMatch(/ENOENT/);
      expect(run.commands).toEqual([]);
    });
  }
});

describe("#69 CodexResumeAdapter (legacy restore path)", () => {
  async function resume(support: CodexDaemonSupport | undefined) {
    const tmux = mockTmux();
    const detectDaemonSupport = vi.fn<CodexDaemonSupportDetector>(async () => support!);
    const adapter = new CodexResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 0, ...(support ? { detectDaemonSupport } : {}) });
    const result = await adapter.resume("r01-qa", "codex_id", "sess 456", "/project", null, undefined, "gpt-5.5");
    return { result, commands: sentCommands(tmux), detectDaemonSupport };
  }

  it("supported adds --no-daemon, legacy is unchanged, unknown fails without sending", async () => {
    const baseline = await resume(undefined);
    const legacyRun = await resume(legacy);
    const supportedRun = await resume(supported);
    const unknownRun = await resume(unknown);

    expect(baseline.commands).toHaveLength(1);
    expect(legacyRun.commands).toEqual(baseline.commands);
    expect(supportedRun.commands).toEqual([baseline.commands[0]!.replace(/^codex /, "codex --no-daemon ")]);
    expect(supportedRun.detectDaemonSupport).toHaveBeenCalledTimes(1);
    expect(supportedRun.detectDaemonSupport).toHaveBeenCalledWith("/project");
    expect(unknownRun.result).toMatchObject({ ok: false, code: "resume_failed" });
    expect(!unknownRun.result.ok && unknownRun.result.message).toMatch(/--no-daemon/);
    expect(unknownRun.commands).toEqual([]);
  });
});

describe("#69 buildCodexResumeCore", () => {
  it("adds the opt-out only when asked; the default (display commands) is byte-identical", () => {
    const plain = buildCodexResumeCore("tok", null);
    expect(plain).toBe("codex -s workspace-write resume 'tok'");
    expect(buildCodexResumeCore("tok", null, false, undefined, undefined, undefined, undefined, true))
      .toBe("codex --no-daemon -s workspace-write resume 'tok'");
  });
});

describe("#69 production wiring", () => {
  it("startup wires the real daemon-support probe into both Codex launch adapters", () => {
    const source = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    const resumeLine = source.split("\n").find((line) => line.includes("new CodexResumeAdapter("))!;
    const runtimeLine = source.split("\n").find((line) => line.includes("new CodexRuntimeAdapter("))!;
    expect(resumeLine).toContain("detectDaemonSupport");
    expect(runtimeLine).toContain("detectDaemonSupport");
  });
});

describe("#69 production detector with a fake executor", () => {
  type HelpCallback = (error: Error | null, stdout: string) => void;
  const launchPath = "./bin:/usr/bin:/bin";
  const cwd = "/seat space's";
  const kinds = ["fresh", "fork", "resume", "restore", "last"] as const;

  function fixture(kind: typeof kinds[number], detectDaemonSupport?: CodexDaemonSupportDetector,
    posture: "floor" | "full_bypass" = "floor", profile?: string) {
    const tmux = mockTmux();
    const model = "model's name";
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {},
      launchPath, detectDaemonSupport, verifyProfilePreflight: async () => ({ ok: true }),
    });
    const restore = new CodexResumeAdapter(tmux, {
      launchPath, detectDaemonSupport, sleep: async () => {}, maxWaitMs: 0, exec: async () => "",
    });
    const run = () => kind === "restore" || kind === "last"
      ? restore.resume("r01-qa", kind === "last" ? "codex_last" : "codex_id", "thread's id", cwd, profile, posture, model)
      : adapter.launchHarness({ ...binding(), cwd, model, launchPosture: posture, codexConfigProfile: profile }, {
          name: "dev-qa@test-rig",
          ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent's id" } }
            : kind === "resume" ? { resumeToken: "thread's id" } : {}),
        });
    return { run, commands: () => sentCommands(tmux) };
  }

  for (const kind of kinds) {
    for (const posture of ["floor", "full_bypass"] as const) {
      it(`${kind}/${posture}: cwd/PATH parity, one probe, legacy bytes, model and profile survive`, async () => {
        let help = LEGACY_HELP;
        processMocks.execFile.mockImplementation((file, args, options, callback: HelpCallback) => {
          expect(file).toBe("codex");
          expect(args).toEqual(["--help"]);
          expect(options.cwd).toBe(cwd);
          expect(options.env.PATH).toBe(launchPath);
          expect(nodePath.resolve(options.cwd, options.env.PATH.split(":")[0], file)).toBe("/seat space's/bin/codex");
          expect(options.timeout).toBe(10_000);
          expect(options.killSignal).toBe("SIGKILL");
          callback(null, help);
        });
        const baseline = fixture(kind, undefined, posture, "profile's name");
        await baseline.run();
        const actual = fixture(kind, codexDaemonSupportProbe(launchPath), posture, "profile's name");
        await actual.run();
        expect(actual.commands()).toEqual(baseline.commands());
        expect(processMocks.execFile).toHaveBeenCalledTimes(1);
        help = SUPPORTED_HELP;
        await actual.run(); // Same adapter, same PATH: an upgrade is evaluated afresh.
        expect(processMocks.execFile).toHaveBeenCalledTimes(2);
        expect(actual.commands()[1]).toBe(baseline.commands()[0]!.replace(" codex ", " codex --no-daemon "));
        expect(actual.commands()[1]).toContain("env PATH='./bin:/usr/bin:/bin'");
        expect(processMocks.execSync).not.toHaveBeenCalled();
      });
    }

    it(`${kind}: production timeout refuses before any launch send`, async () => {
      processMocks.execFile.mockImplementation((_file, _args, options, callback: HelpCallback) => {
        expect(options.timeout).toBe(200);
        callback(Object.assign(new Error("killed"), { killed: true }), "");
      });
      const actual = fixture(kind, codexDaemonSupportProbe(launchPath, 200));
      const result = await actual.run();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("timed out after 200 ms");
      expect(actual.commands()).toEqual([]);
      expect(processMocks.execFile).toHaveBeenCalledTimes(1);
    });
  }

  it("lets an unrelated timer run while the help executor is still pending", async () => {
    let complete: HelpCallback | undefined;
    let settled = false;
    // A red run against the old implementation returns only after this controlled stall.
    processMocks.execSync.mockImplementationOnce(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      return LEGACY_HELP;
    });
    processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => { complete = callback; });
    const pending = codexDaemonSupportProbe(launchPath)(cwd).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(complete).toBeTypeOf("function");
    complete!(null, LEGACY_HELP);
    expect(await pending).toEqual({ kind: "legacy" });
    expect(processMocks.execSync).not.toHaveBeenCalled();
  });

  it("refuses at the deadline without waiting for the callback or accepting late help", async () => {
    vi.useFakeTimers();
    try {
      let complete: HelpCallback | undefined;
      processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => { complete = callback; });
      let observed: CodexDaemonSupport | undefined;
      const pending = codexDaemonSupportProbe(launchPath, 200)(cwd).then((value) => { observed = value; return value; });
      await vi.advanceTimersByTimeAsync(199);
      expect(complete).toBeTypeOf("function");
      expect(observed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(observed).toEqual({ kind: "unknown", detail: "codex --help failed: timed out after 200 ms" });
      complete!(null, SUPPORTED_HELP);
      expect(await pending).toEqual(observed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["success", "error", "throw"])("clears its deadline after early %s", async (outcome) => {
    vi.useFakeTimers();
    try {
      processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => {
        if (outcome === "throw") throw new Error("invalid spawn");
        callback(outcome === "error" ? new Error("not available") : null, SUPPORTED_HELP);
      });
      const result = await codexDaemonSupportProbe(launchPath, 200)(cwd);
      expect(result.kind).toBe(outcome === "success" ? "supported" : "unknown");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports missing executable errors as unknown", async () => {
    processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => {
      callback(new Error("spawn codex ENOENT"), "");
    });
    expect(await codexDaemonSupportProbe(launchPath)(cwd)).toEqual({ kind: "unknown", detail: "codex --help failed: spawn codex ENOENT" });
  });
});
