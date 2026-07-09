// OPR.0.4.6.PI1 — hermetic tests for the Pi runtime adapter, the resume
// adapter, and the runner protocol builders. No live Pi: launch/resume/fork
// COMMAND CONSTRUCTION, sidecar-driven token capture, trust-flag posture, and
// the deny-by-default env allowlist (BR-3) are all pure/fake-backed. The live
// legs are the VM proof contract.

import nodePath from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import {
  piSeatPaths, buildPiRunnerCommand, buildPiChildArgs, buildPiChildEnv,
  providerFromModel, parsePiRunnerState, buildPendingRunnerState, PI_RUNNER_READY_MARKER,
} from "../src/adapters/pi-runner-protocol.js";

const STATE_ROOT = "/openrig-home/state/pi";
const RUNNER = "/daemon-dist/adapters/pi-runner.js";
const SESSION = "devpi-a@some-rig";
const SESSION_FILE = `${STATE_ROOT}/${SESSION}/sessions/2026-07-06T10-00-00_0197a2f0.jsonl`;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
  hasSession?: (target: string) => Promise<boolean>;
  getPaneCommand?: (target: string) => Promise<string | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    hasSession: overrides?.hasSession ?? vi.fn(async () => true),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "node"),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
  } as unknown as TmuxAdapter;
}

/** Extract the --launch-id value the adapter typed into the pane (the runner
 *  would stamp this into its sidecar writes). */
function launchIdFrom(cmd: string): string {
  const m = /--launch-id '([^']+)'/.exec(cmd);
  if (!m) throw new Error("typed command carries no --launch-id");
  return m[1]!;
}

/** In-memory fs. `files` maps absolute path -> content. */
function memFs(files: Record<string, string> = {}): PiAdapterFsOps & { files: Record<string, string>; dirs: Set<string> } {
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: () => [],
  };
}

function readyState(sessionFile: string = SESSION_FILE, launchId?: string): string {
  return JSON.stringify({ ready: true, launchId, sessionFile, sessionId: "0197a2f0", updatedAt: "2026-07-06T10:00:01Z" });
}

function adapterWith(fs: PiAdapterFsOps, tmux: TmuxAdapter, trust?: "approve" | "no-approve") {
  return new PiRuntimeAdapter({
    tmux, fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER,
    trustPosture: trust, sleep: async () => {},
  });
}

// ── protocol builders ─────────────────────────────────────────────────────────

describe("pi-runner-protocol", () => {
  it("derives the seat state layout from stateRoot + sessionName", () => {
    const p = piSeatPaths(STATE_ROOT, SESSION);
    expect(p.agentDir).toBe(nodePath.join(STATE_ROOT, SESSION, "agent"));
    expect(p.sessionsDir).toBe(nodePath.join(STATE_ROOT, SESSION, "sessions"));
    expect(p.runnerStatePath).toBe(nodePath.join(STATE_ROOT, SESSION, "runner-state.json"));
  });

  it("builds the pane command with an EXPLICIT trust flag (BR-5) and no @file args", () => {
    const cmd = buildPiRunnerCommand({
      runnerEntryPath: RUNNER, sessionName: SESSION, stateRoot: STATE_ROOT,
      cwd: "/work", trust: "no-approve", model: "zai/glm-5.2", launchId: "launch-1",
    });
    expect(cmd).toContain(`node '${RUNNER}'`);
    expect(cmd).toContain("--launch-id 'launch-1'");
    expect(cmd).toContain("--no-approve");
    expect(cmd).toContain("--model 'zai/glm-5.2'");
    // No ARG starts with "@" (Pi's @file form). "@" INSIDE a value is fine —
    // the canonical session name (pod-member@rig) always carries one.
    expect(cmd).not.toMatch(/ '@| @/);
  });

  it("passes --session for resume and --fork for fork, never both", () => {
    const resume = buildPiRunnerCommand({
      runnerEntryPath: RUNNER, sessionName: SESSION, stateRoot: STATE_ROOT,
      cwd: "/work", trust: "approve", sessionFile: SESSION_FILE, launchId: "launch-1",
    });
    expect(resume).toContain(`--session '${SESSION_FILE}'`);
    expect(resume).not.toContain("--fork");
    expect(resume).not.toContain("--resume"); // the picker is forbidden in managed paths

    const fork = buildPiRunnerCommand({
      runnerEntryPath: RUNNER, sessionName: SESSION, stateRoot: STATE_ROOT,
      cwd: "/work", trust: "approve", forkRef: SESSION_FILE, launchId: "launch-1",
    });
    expect(fork).toContain(`--fork '${SESSION_FILE}'`);
    expect(fork).not.toContain("--session ");
  });

  it("builds pi child argv with rpc mode, explicit --session-dir, --name, and trust", () => {
    const args = buildPiChildArgs({
      sessionsDir: "/seat/sessions", sessionName: SESSION, trust: "no-approve", model: "kimi-coding/k2p7",
    });
    expect(args).toEqual([
      "--mode", "rpc",
      "--session-dir", "/seat/sessions",
      "--name", SESSION,
      "--no-approve",
      "--model", "kimi-coding/k2p7",
    ]);
  });

  it("prefers --session over --fork in child argv (mutual exclusion upstream)", () => {
    const args = buildPiChildArgs({
      sessionsDir: "/s", sessionName: SESSION, trust: "approve",
      sessionFile: "/a.jsonl", forkRef: "/b.jsonl",
    });
    expect(args).toContain("--session");
    expect(args).not.toContain("--fork");
  });

  it("parses provider from provider/id model declarations", () => {
    expect(providerFromModel("zai/glm-5.2")).toBe("zai");
    expect(providerFromModel("kimi-coding/k2p7")).toBe("kimi-coding");
    expect(providerFromModel("glm-5.2")).toBeNull();
    expect(providerFromModel(undefined)).toBeNull();
  });

  it("rejects malformed runner-state JSON honestly", () => {
    expect(parsePiRunnerState("not json")).toBeNull();
    expect(parsePiRunnerState("[]")).toBeNull();
    expect(parsePiRunnerState(JSON.stringify({ ready: "yes", updatedAt: "t" }))).toBeNull();
    expect(parsePiRunnerState(readyState())).toMatchObject({ ready: true, sessionFile: SESSION_FILE });
  });
});

describe("buildPiChildEnv — deny-by-default allowlist (BR-3)", () => {
  const source = {
    PATH: "/usr/bin", HOME: "/home/seat", TERM: "xterm",
    AWS_SECRET_ACCESS_KEY: "leak-me", OPENRIG_ACTIVITY_HOOK_TOKEN: "secret",
    GITHUB_TOKEN: "leak-me-too", ZAI_API_KEY: "zai-key", KIMI_API_KEY: "kimi-key",
    OPENROUTER_API_KEY: "or-key",
  };

  it("passes baseline vars + seat isolation roots, and NOTHING else", () => {
    const env = buildPiChildEnv(source, { agentDir: "/seat/agent", sessionsDir: "/seat/sessions" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PI_CODING_AGENT_DIR).toBe("/seat/agent");
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe("/seat/sessions");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("OPENRIG_ACTIVITY_HOOK_TOKEN");
    // No declared provider — neither key crosses the boundary.
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
  });

  it("passes ONLY the declared provider's key var", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "zai/glm-5.2" });
    expect(env.ZAI_API_KEY).toBe("zai-key");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");

    const kimi = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "kimi-coding/k2p7" });
    expect(kimi.KIMI_API_KEY).toBe("kimi-key");
    expect(kimi).not.toHaveProperty("ZAI_API_KEY");
  });

  it("openrouter (the preferred one-key path, founder ruling 2026-07-06) passes only OPENROUTER_API_KEY", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "openrouter/z-ai/glm-4.6" });
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
  });

  it("unknown/custom providers get no ambient key passthrough (models.json is their path)", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "ollama/qwen2.5-coder" });
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
  });
});

// ── PiRuntimeAdapter ─────────────────────────────────────────────────────────

describe("PiRuntimeAdapter.launchHarness", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work", model: "zai/glm-5.2" } as never;

  it("fresh launch: types the runner command, then captures the session file from the sidecar", async () => {
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      // The runner "starts" and writes its launch-stamped sidecar before the
      // adapter polls.
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      expect(text).toContain("--no-approve"); // default trust posture, explicit
      expect(text).toContain("--model 'zai/glm-5.2'");
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));

    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: SESSION_FILE, resumeType: "pi_session_file" });
    // Seat isolation dirs were created.
    expect(fs.dirs.has(piSeatPaths(STATE_ROOT, SESSION).agentDir)).toBe(true);
    expect(fs.dirs.has(piSeatPaths(STATE_ROOT, SESSION).sessionsDir)).toBe(true);
  });

  it("explicit approve posture is honored end-to-end", async () => {
    const fs = memFs();
    let cmd = "";
    const sendText = vi.fn(async (_t: string, text: string) => {
      cmd = text;
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }), "approve");
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
    expect(cmd).toContain("--approve");
    expect(cmd).not.toContain("--no-approve");
  });

  it("refuses resumeToken + forkSource together", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, {
      name: SESSION, resumeToken: SESSION_FILE, forkSource: { kind: "native_id", value: "/x.jsonl" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mutually exclusive/);
  });

  it("resume: validates the token shape, requires the file to exist, and returns the SAME token", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--session '${SESSION_FILE}'`);
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_FILE });
    expect(result).toEqual({ ok: true, resumeToken: SESSION_FILE, resumeType: "pi_session_file" });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("resume with a malformed token fails validation BEFORE touching the pane", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: "relative/path.jsonl" });
    expect(result.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("resume with a missing session file returns retry_fresh (the awaiting-decision path)", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_FILE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recovery).toBe("retry_fresh");
  });

  it("fork: uses --fork and returns the NEW child session file, never the parent", async () => {
    const parent = "/somewhere/parent_0196.jsonl";
    const child = `${STATE_ROOT}/${SESSION}/sessions/child_0197.jsonl`;
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--fork '${parent}'`);
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(child, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: parent },
    });
    expect(result).toEqual({ ok: true, resumeToken: child, resumeType: "pi_session_file" });
  });

  it("fork FAILS if the runner reports the parent file as the session (post-fork token rule)", async () => {
    const parent = `${STATE_ROOT}/${SESSION}/sessions/parent_0196.jsonl`;
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(parent, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: parent },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/parent session file/);
  });

  it("fork refuses non-native_id ref kinds in v1", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "artifact_path", value: "/x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/native_id/);
  });

  it("reports attention_required with pane evidence when the runner exits before ready", async () => {
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = JSON.stringify({
        ready: false, launchId: launchIdFrom(text), updatedAt: "t", exited: { code: 1, at: "t" },
      });
      return { ok: true as const };
    });
    const capturePaneContent = vi.fn(async () => "[pi-runner] ERROR pi exited: bad provider config");
    const adapter = adapterWith(fs, mockTmux({ sendText, capturePaneContent }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.evidence).toContain("bad provider config");
    }
  });
});

describe("PiRuntimeAdapter.checkReady / readSessionFile", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work" } as never;

  it("ready when the sidecar says ready", async () => {
    const fs = memFs({ [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: readyState() });
    const adapter = adapterWith(fs, mockTmux());
    expect(await adapter.checkReady(binding)).toEqual({ ready: true });
  });

  it("ready via the runner's own pane marker when the sidecar is absent", async () => {
    const capturePaneContent = vi.fn(async () => `banner\n${PI_RUNNER_READY_MARKER} session=x\n`);
    const adapter = adapterWith(memFs(), mockTmux({ capturePaneContent }));
    expect((await adapter.checkReady(binding)).ready).toBe(true);
  });

  it("not ready + runner_exited when the sidecar records an exit", async () => {
    const fs = memFs({
      [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: JSON.stringify({ ready: false, updatedAt: "t", exited: { code: 2, at: "t" } }),
    });
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });

  it("exposes the sidecar as the resume-token capture store (piRunnerStateStore shape)", () => {
    const fs = memFs({ [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: readyState() });
    const adapter = adapterWith(fs, mockTmux());
    expect(adapter.readSessionFile(SESSION)).toEqual({ ok: true, sessionFile: SESSION_FILE });
    expect(adapter.readSessionFile("missing@rig")).toEqual({ ok: false, reason: "missing_sidecar" });
  });

  it("reports parse_error for a corrupt sidecar", () => {
    const fs = memFs({ [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: "corrupt{" });
    const adapter = adapterWith(fs, mockTmux());
    expect(adapter.readSessionFile(SESSION)).toEqual({ ok: false, reason: "parse_error" });
  });
});

// ── PiResumeAdapter ──────────────────────────────────────────────────────────

describe("PiResumeAdapter", () => {
  function resumeAdapter(fs: ReturnType<typeof memFs>, tmux: TmuxAdapter) {
    return new PiResumeAdapter(tmux, fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {},
    });
  }

  it("canResume: pi_session_file + token only", () => {
    const a = resumeAdapter(memFs(), mockTmux());
    expect(a.canResume("pi_session_file", SESSION_FILE)).toBe(true);
    expect(a.canResume("pi_session_file", null)).toBe(false);
    expect(a.canResume("codex_id", SESSION_FILE)).toBe(false);
  });

  it("missing session file -> retry_fresh (maps to awaiting-decision, never silent fresh)", async () => {
    const a = resumeAdapter(memFs(), mockTmux());
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("retry_fresh");
  });

  it("resumes: types the runner --session command and confirms via the sidecar", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--session '${SESSION_FILE}'`);
      expect(text).not.toContain("--resume");
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true });
  });

  it("fails honestly when the runner reports a DIFFERENT session file than requested", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState("/other/file.jsonl", launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/does not report the requested session file/);
  });

  it("cleans the typed command with C-c when Enter fails (mirrors codex-resume)", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendKeys = vi.fn(async (_t: string, keys: string[]): Promise<TmuxResult> =>
      keys[0] === "Enter"
        ? { ok: false as const, code: "send_failed", message: "enter failed" }
        : { ok: true as const });
    const a = resumeAdapter(fs, mockTmux({ sendKeys }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    expect(sendKeys.mock.calls.some((c) => c[1]?.[0] === "C-c")).toBe(true);
  });
});

// ── stale-artifact scoping (guard fold, code-review qitem-20260707011908) ────
// Durable runner-state.json and pane READY/EXIT scrollback survive stop/crash;
// launch/resume/readiness must never consume a PRIOR instance's artifacts.

describe("launch-attempt scoping — stale artifacts never count", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work" } as never;
  const OLD_FILE = `${STATE_ROOT}/${SESSION}/sessions/OLD_0100.jsonl`;
  const NEW_FILE = `${STATE_ROOT}/${SESSION}/sessions/NEW_0200.jsonl`;
  const statePath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;

  it("fresh launch ignores a PRE-EXISTING ready sidecar and returns the NEW launch's token", async () => {
    const fs = memFs({ [statePath]: readyState(OLD_FILE, "stale-launch") });
    const sendText = vi.fn(async (_t: string, text: string) => {
      // Pre-launch reset must already have replaced the stale record with a
      // pending one stamped for THIS attempt.
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text) });
      // Then the "runner" reports ready for THIS attempt with the NEW file.
      fs.files[statePath] = readyState(NEW_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: NEW_FILE, resumeType: "pi_session_file" });
  });

  it("fresh launch ignores a PRE-EXISTING exited sidecar (no instant attention_required)", async () => {
    const fs = memFs({
      [statePath]: JSON.stringify({ ready: false, launchId: "stale-launch", updatedAt: "t", exited: { code: 1, at: "t" } }),
    });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = readyState(NEW_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
  });

  it("a ready sidecar WITHOUT this attempt's launchId never completes the launch", async () => {
    // The "runner" writes a ready record stamped with a DIFFERENT launch id
    // (e.g. a racing older instance) — the poll must time out, not accept it.
    const fs = memFs();
    const sendText = vi.fn(async () => {
      fs.files[statePath] = readyState(OLD_FILE, "some-other-launch");
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/);
  });

  it("checkReady: stale ready sidecar + pane back at a shell -> runner_exited, never ready", async () => {
    const fs = memFs({ [statePath]: readyState(SESSION_FILE, "stale-launch") });
    const adapter = adapterWith(fs, mockTmux({ getPaneCommand: vi.fn(async () => "zsh") }));
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });

  it("checkReady: stale READY scrollback + pane at a shell -> runner_exited, never ready", async () => {
    const adapter = adapterWith(memFs(), mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => `old output\n${PI_RUNNER_READY_MARKER} session=${SESSION_FILE}\n$ `),
    }));
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });
});

describe("PiResumeAdapter — stale-artifact scoping", () => {
  const statePath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;

  function resumeAdapter(fs: ReturnType<typeof memFs>, tmux: TmuxAdapter) {
    return new PiResumeAdapter(tmux, fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {},
    });
  }

  it("a PRE-EXISTING ready sidecar (even naming the requested file) never false-greens resume", async () => {
    // Stale record from the seat's PREVIOUS run of the SAME session file.
    const fs = memFs({ [SESSION_FILE]: "jsonl", [statePath]: readyState(SESSION_FILE, "stale-launch") });
    const sendText = vi.fn(async () => ({ ok: true as const })); // new runner never reports
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/timed out/);
    // And the stale record was overwritten with a pending one before typing.
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("a stale READY pane marker (same file) is never consulted", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const capturePaneContent = vi.fn(async () => `${PI_RUNNER_READY_MARKER} session=${SESSION_FILE}`);
    const a = resumeAdapter(fs, mockTmux({ capturePaneContent }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
  });

  it("resumes only when THIS attempt's sidecar is ready AND names the requested file", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true });
  });

  it("this attempt's sidecar ready WITHOUT a sessionFile is not proof (no optional match)", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = JSON.stringify({ ready: true, launchId: launchIdFrom(text), updatedAt: "t" });
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/does not report the requested session file/);
  });
});

// ── FR-5 durable cursor survives the launch-scoped reset (guard re-verdict,
// qitem-20260707013815) ──────────────────────────────────────────────────────

describe("durable catch-up cursor survives launch-attempt resets", () => {
  const statePath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;
  const priorWithCursor = JSON.stringify({
    ready: true, launchId: "stale-launch", sessionFile: SESSION_FILE,
    lastEntryId: "entry-42", updatedAt: "t",
  });

  it("buildPendingRunnerState carries ONLY the cursor forward (everything else reset)", () => {
    const prior = parsePiRunnerState(priorWithCursor)!;
    const pending = buildPendingRunnerState("launch-2", "t2", prior);
    expect(pending).toEqual({ ready: false, launchId: "launch-2", lastEntryId: "entry-42", updatedAt: "t2" });
    expect(buildPendingRunnerState("launch-2", "t2", null).lastEntryId).toBeUndefined();
  });

  it("adapter resume pre-write preserves lastEntryId through the pending reset", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl", [statePath]: priorWithCursor });
    const sendText = vi.fn(async (_t: string, text: string) => {
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text), lastEntryId: "entry-42" });
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(
      { tmuxSession: SESSION, cwd: "/work" } as never,
      { name: SESSION, resumeToken: SESSION_FILE },
    );
    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("PiResumeAdapter pre-write preserves lastEntryId through the pending reset", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl", [statePath]: priorWithCursor });
    const sendText = vi.fn(async (_t: string, text: string) => {
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text), lastEntryId: "entry-42" });
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = new PiResumeAdapter(mockTmux({ sendText }), fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {},
    });
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledOnce();
  });
});
