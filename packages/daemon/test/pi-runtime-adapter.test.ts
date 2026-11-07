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
import { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import {
  piSeatPaths, buildPiRunnerCommand, buildPiChildArgs, buildPiChildEnv,
  providerFromModel, parsePiRunnerState, buildPendingRunnerState, PI_RUNNER_READY_MARKER,
} from "../src/adapters/pi-runner-protocol.js";

const STATE_ROOT = "/openrig-home/state/pi";
const RUNNER = "/daemon-dist/adapters/pi-runner.js";
const SESSION = "devpi-a@some-rig";
const SESSION_FILE = `${STATE_ROOT}/${SESSION}/sessions/2026-07-06T10-00-00_0197a2f0.jsonl`;
const PI_FLOOR_EFFECT = {
  runtime: "pi",
  axis: "resource_trust",
  state: "observed",
  value: "no-approve",
} as const;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendShellCommand?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
  hasSession?: (target: string) => Promise<boolean>;
  getPaneCommand?: (target: string) => Promise<string | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: overrides?.sendShellCommand ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    hasSession: overrides?.hasSession ?? vi.fn(async () => true),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "node"),
    getSessionEnv: async (_session: string, key: string) => key === "OPENRIG_NODE_ID" ? "node-pi" : undefined,
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
    OPENROUTER_API_KEY: "or-key", MINIMAX_API_KEY: "minimax-key",
  };

  it("preserves managed identity and instance/context provenance, not ambient OpenRig settings", () => {
    const managed = {
      OPENRIG_NODE_ID: "node-17", OPENRIG_SESSION_NAME: SESSION,
      OPENRIG_HOME: "/private/instance", OPENRIG_URL: "http://127.0.0.1:17433",
      OPENRIG_HOST: "127.0.0.1", OPENRIG_PORT: "17433",
      OPENRIG_RUNTIME: "pi", OPENRIG_OCCUPANT_GENERATION: "generation-current",
      OPENRIG_SHARED_DOCS_ROOT: "/private/context",
    };
    const env = buildPiChildEnv({
      ...source, ...managed, OPENRIG_UNREVIEWED_SETTING: "exclude",
      OPENRIG_TERMINAL_BEARER_TOKEN: "exclude", OPENAI_API_KEY: "exclude",
      BASH_ENV: "/untrusted/startup", ENV: "/untrusted/startup", NODE_OPTIONS: "--inspect",
      TMUX: "/some/socket", TMUX_PANE: "%7", RIGGED_SESSION_NAME: "stale@other",
    }, { agentDir: "/seat/agent", sessionsDir: "/seat/sessions", model: "openrouter/example" });
    expect(env).toMatchObject(managed);
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    for (const name of ["OPENRIG_UNREVIEWED_SETTING", "OPENRIG_TERMINAL_BEARER_TOKEN",
      "OPENRIG_ACTIVITY_HOOK_TOKEN", "OPENAI_API_KEY", "ZAI_API_KEY", "KIMI_API_KEY",
      "MINIMAX_API_KEY",
      "BASH_ENV", "ENV", "NODE_OPTIONS", "TMUX", "TMUX_PANE", "RIGGED_SESSION_NAME"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("does not invent missing or empty managed identity", () => {
    const opts = { agentDir: "/seat/agent", sessionsDir: "/seat/sessions" };
    expect(buildPiChildEnv({}, opts)).not.toHaveProperty("OPENRIG_SESSION_NAME");
    expect(buildPiChildEnv({}, opts)).not.toHaveProperty("OPENRIG_NODE_ID");
    expect(buildPiChildEnv({ OPENRIG_SESSION_NAME: "" }, opts).OPENRIG_SESSION_NAME).toBe("");
  });

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
    expect(env).not.toHaveProperty("MINIMAX_API_KEY");

    const kimi = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "kimi-coding/k2p7" });
    expect(kimi.KIMI_API_KEY).toBe("kimi-key");
    expect(kimi).not.toHaveProperty("ZAI_API_KEY");
    expect(kimi).not.toHaveProperty("MINIMAX_API_KEY");

    const minimax = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "minimax/MiniMax-M3" });
    expect(minimax.MINIMAX_API_KEY).toBe("minimax-key");
    expect(minimax).not.toHaveProperty("ZAI_API_KEY");
    expect(minimax).not.toHaveProperty("KIMI_API_KEY");
    expect(minimax).not.toHaveProperty("OPENROUTER_API_KEY");
  });

  it("openrouter passes only OPENROUTER_API_KEY", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "openrouter/z-ai/glm-4.6" });
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
  });

  it("minimax passes only MINIMAX_API_KEY", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "minimax/MiniMax-M3" });
    expect(env.MINIMAX_API_KEY).toBe("minimax-key");
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      // The runner "starts" and writes its launch-stamped sidecar before the
      // adapter polls.
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      expect(text).toContain("--no-approve"); // default trust posture, explicit
      expect(text).toContain("--model 'zai/glm-5.2'");
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));

    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: SESSION_FILE, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
    // Seat isolation dirs were created.
    expect(fs.dirs.has(piSeatPaths(STATE_ROOT, SESSION).agentDir)).toBe(true);
    expect(fs.dirs.has(piSeatPaths(STATE_ROOT, SESSION).sessionsDir)).toBe(true);
  });

  it("passes the seat's effort as --thinking for Pi; no effort => no flag; OMP never", async () => {
    const run = async (Adapter: typeof PiRuntimeAdapter, effort?: string) => {
      const fs = memFs();
      const sendShellCommand = vi.fn(async (_t: string, text: string) => {
        fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
        return { ok: true as const };
      });
      const adapter = new Adapter({ tmux: mockTmux({ sendShellCommand }), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sleep: async () => {} });
      expect((await adapter.launchHarness({ ...(binding as object), effort } as never, { name: SESSION })).ok).toBe(true);
      return sendShellCommand.mock.calls[0]![1] as string;
    };
    expect(await run(PiRuntimeAdapter, "high")).toContain("--model 'zai/glm-5.2' --thinking 'high'");
    expect(await run(PiRuntimeAdapter)).not.toContain("--thinking");
    expect(await run(OmpRuntimeAdapter as never, "high")).not.toContain("--thinking");
  });

  it("OPR.0.7.0.2: --usage-facts only while usage.pi_cost_facts is on, read at each launch; off by default", async () => {
    let enabled = false;
    const commands: string[] = [];
    for (const deps of [{}, { usageFactsEnabled: () => enabled }, { usageFactsEnabled: () => enabled }]) {
      const fs = memFs();
      const sendShellCommand = vi.fn(async (_t: string, text: string) => {
        fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
        commands.push(text);
        return { ok: true as const };
      });
      const adapter = new PiRuntimeAdapter({ tmux: mockTmux({ sendShellCommand }), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sleep: async () => {}, ...deps });
      expect((await adapter.launchHarness(binding, { name: SESSION })).ok).toBe(true);
      enabled = commands.length >= 2; // switched on before the third launch, which reads it again
    }
    expect(commands.map((c) => c.includes("--usage-facts"))).toEqual([false, false, true]);
  });

  it("OPR.0.7.0.2 K4: --openrouter-charge only with usage facts on too, read at each launch; off by default", async () => {
    const settings = [{ facts: false, charge: true }, { facts: true, charge: false }, { facts: true, charge: true }];
    const commands: string[] = [];
    for (const deps of [{}, ...settings.map((x) => ({ usageFactsEnabled: () => x.facts, openRouterChargeEnabled: () => x.charge }))]) {
      const fs = memFs();
      const sendShellCommand = vi.fn(async (_t: string, text: string) => {
        fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
        commands.push(text);
        return { ok: true as const };
      });
      const adapter = new PiRuntimeAdapter({ tmux: mockTmux({ sendShellCommand }), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sleep: async () => {}, ...deps });
      expect((await adapter.launchHarness(binding, { name: SESSION })).ok).toBe(true);
    }
    expect(commands.map((c) => c.includes("--openrouter-charge"))).toEqual([false, false, false, true]);
  });

  it("explicit approve posture is honored end-to-end", async () => {
    const fs = memFs();
    let cmd = "";
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      cmd = text;
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }), "approve");
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--session '${SESSION_FILE}'`);
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_FILE });
    expect(result).toEqual({ ok: true, resumeToken: SESSION_FILE, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
    expect(sendShellCommand).toHaveBeenCalledOnce();
  });

  it("resume with a malformed token fails validation BEFORE touching the pane", async () => {
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: "relative/path.jsonl" });
    expect(result.ok).toBe(false);
    expect(sendShellCommand).not.toHaveBeenCalled();
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--fork '${parent}'`);
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(child, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: parent },
    });
    expect(result).toEqual({ ok: true, resumeToken: child, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("fork FAILS if the runner reports the parent file as the session (post-fork token rule)", async () => {
    const parent = `${STATE_ROOT}/${SESSION}/sessions/parent_0196.jsonl`;
    const fs = memFs();
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(parent, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = JSON.stringify({
        ready: false, launchId: launchIdFrom(text), updatedAt: "t", exited: { code: 1, at: "t" },
      });
      return { ok: true as const };
    });
    const capturePaneContent = vi.fn(async () => "[pi-runner] ERROR pi exited: bad provider config");
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand, capturePaneContent }));
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--session '${SESSION_FILE}'`);
      expect(text).not.toContain("--resume");
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendShellCommand }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true, appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("resume passes effort as --thinking for Pi; none without; OMP never", async () => {
    const run = async (make: (fs: ReturnType<typeof memFs>, tmux: TmuxAdapter) => PiResumeAdapter, type: string, effort?: string | null) => {
      const fs = memFs({ [SESSION_FILE]: "jsonl" });
      const sendShellCommand = vi.fn(async (_t: string, text: string) => {
        fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
        return { ok: true as const };
      });
      const result = await make(fs, mockTmux({ sendShellCommand })).resume(SESSION, type, SESSION_FILE, "/work", "zai/glm", undefined, effort);
      expect(result.ok).toBe(true);
      return sendShellCommand.mock.calls[0]![1] as string;
    };
    const omp = (fs: ReturnType<typeof memFs>, tmux: TmuxAdapter) =>
      new OmpResumeAdapter(tmux, fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, { pollMs: 1, maxWaitMs: 5, sleep: async () => {} });
    expect(await run(resumeAdapter, "pi_session_file", "high")).toContain("--model 'zai/glm' --thinking 'high' --session");
    expect(await run(resumeAdapter, "pi_session_file")).not.toContain("--thinking");
    expect(await run(resumeAdapter, "pi_session_file", null)).not.toContain("--thinking");
    expect(await run(omp, "omp_session_file", "high")).not.toContain("--thinking");
  });

  it("fails honestly when the runner reports a DIFFERENT session file than requested", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState("/other/file.jsonl", launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendShellCommand }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/does not report the requested session file/);
  });

  it("surfaces a staged launch failure without sending another submit", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const sendShellCommand = vi.fn(async (): Promise<TmuxResult> =>
      ({ ok: false, code: "send_failed", message: "enter failed" }));
    const a = resumeAdapter(fs, mockTmux({ sendShellCommand, sendKeys }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toMatchObject({ ok: false, message: "enter failed" });
    expect(sendKeys).not.toHaveBeenCalled();
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      // Pre-launch reset must already have replaced the stale record with a
      // pending one stamped for THIS attempt.
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text) });
      // Then the "runner" reports ready for THIS attempt with the NEW file.
      fs.files[statePath] = readyState(NEW_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: NEW_FILE, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("fresh launch ignores a PRE-EXISTING exited sidecar (no instant attention_required)", async () => {
    const fs = memFs({
      [statePath]: JSON.stringify({ ready: false, launchId: "stale-launch", updatedAt: "t", exited: { code: 1, at: "t" } }),
    });
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = readyState(NEW_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
  });

  it("a ready sidecar WITHOUT this attempt's launchId never completes the launch", async () => {
    // The "runner" writes a ready record stamped with a DIFFERENT launch id
    // (e.g. a racing older instance) — the poll must time out, not accept it.
    const fs = memFs();
    const sendShellCommand = vi.fn(async () => {
      fs.files[statePath] = readyState(OLD_FILE, "some-other-launch");
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));
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
    const sendShellCommand = vi.fn(async () => ({ ok: true as const })); // new runner never reports
    const a = resumeAdapter(fs, mockTmux({ sendShellCommand }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/timed out/);
    // And the stale record was overwritten with a pending one before typing.
    expect(sendShellCommand).toHaveBeenCalledOnce();
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendShellCommand }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true, appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("this attempt's sidecar ready WITHOUT a sessionFile is not proof (no optional match)", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = JSON.stringify({ ready: true, launchId: launchIdFrom(text), updatedAt: "t" });
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendShellCommand }));
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
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text), lastEntryId: "entry-42" });
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(
      { tmuxSession: SESSION, cwd: "/work" } as never,
      { name: SESSION, resumeToken: SESSION_FILE },
    );
    expect(result.ok).toBe(true);
    expect(sendShellCommand).toHaveBeenCalledOnce();
  });

  it("PiResumeAdapter pre-write preserves lastEntryId through the pending reset", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl", [statePath]: priorWithCursor });
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text), lastEntryId: "entry-42" });
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = new PiResumeAdapter(mockTmux({ sendShellCommand }), fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {},
    });
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true, appliedLaunch: PI_FLOOR_EFFECT });
    expect(sendShellCommand).toHaveBeenCalledOnce();
  });

  // OPR.0.4.8.2: Pi RESTORE resource-trust posture (RESOURCE TRUST, NOT a permission policy). Direct
  // PiResumeAdapter call-site pin so pi-resume.ts cannot regress while the pure piTrust helper stays
  // green. OFF keeps the configured/no-approve trust; YOLO ON forces --approve.
  it("PiResumeAdapter restore trust: OFF -> --no-approve; ON (YOLO) -> --approve", async () => {
    async function resumeCmd(): Promise<string> {
      const fs = memFs({ [SESSION_FILE]: "jsonl" });
      let cmd = "";
      const sendShellCommand = vi.fn(async (_t: string, text: string) => {
        cmd = text;
        fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
        return { ok: true as const };
      });
      const a = new PiResumeAdapter(mockTmux({ sendShellCommand }), fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
        pollMs: 1, maxWaitMs: 5, sleep: async () => {},
      });
      await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
      return cmd;
    }
    try {
      delete process.env.OPENRIG_YOLO;
      const off = await resumeCmd();
      expect(off).toContain("--no-approve");
      expect(off).not.toContain("--approve"); // "--no-approve" does not contain the "--approve" token

      process.env.OPENRIG_YOLO = "1";
      const on = await resumeCmd();
      expect(on).toContain("--approve");
      expect(on).not.toContain("--no-approve");
    } finally {
      delete process.env.OPENRIG_YOLO;
    }
  });
});

// #875 direction 2: Pi loads its agent folder's AGENTS.md before the repository's (Quality's native run on Pi 1.0.1), so a
// Pi seat's managed guidance goes there and the person's tracked repository AGENTS.md is never written.
describe("a Pi seat's managed guidance goes to its own agent folder (#875)", () => {
  const AGENT_FILE = nodePath.join(piSeatPaths(STATE_ROOT, SESSION).agentDir, "AGENTS.md");
  const seat = { tmuxSession: SESSION, cwd: "/work" } as never;

  it("chooses the seat's agent-folder AGENTS.md, and nothing without a session", () => {
    const adapter = adapterWith(memFs(), mockTmux());
    expect(adapter.guidanceFileFor(seat)).toEqual({ file: AGENT_FILE });
    expect(adapter.guidanceFileFor({ tmuxSession: null, cwd: "/work" } as never)).toEqual({ file: null });
  });

  it.each([
    ["the agent AGENTS.md is a symlink", AGENT_FILE, { link: true, nlink: 1 }],
    ["the agent AGENTS.md is a hard link", AGENT_FILE, { link: false, nlink: 2 }],
    ["the agent folder is a symlink", piSeatPaths(STATE_ROOT, SESSION).agentDir, { link: true, nlink: 1 }],
  ])("keeps the repository file when %s, which other sessions could read, and says so", (_case, linked, info) => {
    const fs = { ...memFs(), linkInfo: (p: string) => (p === linked ? info : null) };
    const chosen = adapterWith(fs, mockTmux()).guidanceFileFor(seat);
    expect(chosen.file).toBeNull();
    expect(chosen.note).toMatch(/repository AGENTS\.md/);
  });

  it("merges startup guidance and projected guidance into the chosen file, creating its folder, and never the repository AGENTS.md", async () => {
    const fs = memFs({ "/spec/SOP.md": "How work flows here.", "/spec/culture.md": "Team culture." });
    const adapter = adapterWith(fs, mockTmux());
    const binding = { tmuxSession: SESSION, cwd: "/work", guidanceFile: AGENT_FILE } as never;
    const delivered = await adapter.deliverStartup([{ path: "SOP.md", absolutePath: "/spec/SOP.md", ownerRoot: "/spec",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }], binding);
    expect(delivered.failed).toEqual([]);
    const projected = await adapter.project({ runtime: "pi", cwd: "/work", entries: [{ effectiveId: "culture", category: "guidance",
      mergeStrategy: "managed_block", absolutePath: "/spec/culture.md", classification: "safe_projection" }],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as never, binding);
    expect(projected.failed).toEqual([]);
    expect(fs.files[AGENT_FILE]).toContain("How work flows here.");
    expect(fs.files[AGENT_FILE]).toContain("Team culture.");
    expect(fs.dirs.has(nodePath.dirname(AGENT_FILE))).toBe(true);
    expect("/work/AGENTS.md" in fs.files).toBe(false);
  });

  it("a binding with no chosen file (a restore from an older snapshot) still merges into the repository AGENTS.md", async () => {
    const fs = memFs({ "/spec/SOP.md": "How work flows here." });
    await adapterWith(fs, mockTmux()).deliverStartup([{ path: "SOP.md", absolutePath: "/spec/SOP.md", ownerRoot: "/spec",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }], { tmuxSession: SESSION, cwd: "/work", guidanceFile: null } as never);
    expect(fs.files["/work/AGENTS.md"]).toContain("How work flows here.");
    expect(AGENT_FILE in fs.files).toBe(false);
  });

  it("an OMP seat keeps the repository file: nothing has shown OMP loads its agent folder's AGENTS.md", () => {
    const omp = new OmpRuntimeAdapter({ tmux: mockTmux(), fsOps: memFs(), stateRoot: STATE_ROOT, runnerEntryPath: RUNNER });
    expect(omp.guidanceFileFor(seat)).toEqual({ file: null });
  });
});

// #2432 X-F2: a restore's recorded agent file that became a link after its launch gets nothing written through it.
describe("a Pi seat's recorded guidance file that has since become a link (#2432)", () => {
  const AGENT_FILE = nodePath.join(piSeatPaths(STATE_ROOT, SESSION).agentDir, "AGENTS.md");
  it("writes no guidance through it or into the repository AGENTS.md, and says why", async () => {
    const fs = { ...memFs({ "/spec/SOP.md": "How work flows here." }), linkInfo: (p: string) => (p === AGENT_FILE ? { link: true, nlink: 1 } : null) };
    const result = await adapterWith(fs, mockTmux()).deliverStartup([{ path: "SOP.md", absolutePath: "/spec/SOP.md", ownerRoot: "/spec",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["restore"] }], { tmuxSession: SESSION, cwd: "/work", guidanceFile: AGENT_FILE } as never);
    expect(AGENT_FILE in fs.files).toBe(false);
    expect("/work/AGENTS.md" in fs.files).toBe(false);
    expect(result.warnings?.join("\n")).toMatch(/now a link/);
  });
});

describe("PiRuntimeAdapter and PiResumeAdapter launch_wrapper", () => {
  const statePath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;

  it.each(["fresh", "resume", "fork"] as const)("PiRuntimeAdapter %s resolves launchWrapper on seatLaunchEnvironment, passes --launch-wrapper-arg tokens to runner, and omits launchWrapper from shell command()", async mode => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const commandCalls: Array<{ session: string; cmd: string; target: unknown }> = [];
    const resolveLaunchWrapper = vi.fn((w: readonly string[]) => [`/resolved/bin/${w[0]}`, ...w.slice(1)]);
    const seatLaunchEnvironment = {
      accountHome: () => undefined,
      resolveLaunchWrapper,
      command: vi.fn(async (session: string, cmd: string, target: unknown) => {
        commandCalls.push({ session, cmd, target });
        return `/usr/bin/env 'OPENRIG_RUNTIME=pi' ${cmd}`;
      }),
    } as never;
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      const childFile = mode === "fork" ? `${STATE_ROOT}/${SESSION}/sessions/forked_child.jsonl` : SESSION_FILE;
      fs.files[statePath] = readyState(childFile, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = new PiRuntimeAdapter({
      tmux: mockTmux({ sendShellCommand }),
      seatLaunchEnvironment,
      fsOps: fs,
      stateRoot: STATE_ROOT,
      runnerEntryPath: RUNNER,
      sleep: async () => {},
    });
    const wrapper = ["my-wrapper", "arg 1", "--leading", "", "--"];
    const result = await adapter.launchHarness(
      { tmuxSession: SESSION, nodeId: "node-pi", launchGeneration: "gen-1", cwd: "/work", model: "zai/glm-5.2", launchWrapper: wrapper } as never,
      {
        name: SESSION,
        ...(mode === "resume" ? { resumeToken: SESSION_FILE } : {}),
        ...(mode === "fork" ? { forkSource: { kind: "native_id", value: SESSION_FILE } } : {}),
      },
    );
    expect(result.ok).toBe(true);
    expect(resolveLaunchWrapper).toHaveBeenCalledWith(wrapper);
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]!.target).toEqual({
      nodeId: "node-pi",
      generation: "gen-1",
      runtime: "pi",
    });
    expect(sendShellCommand.mock.calls[0]![1]).toContain(
      "node '/daemon-dist/adapters/pi-runner.js'",
    );
    expect(sendShellCommand.mock.calls[0]![1]).toContain(
      "--launch-wrapper-arg '/resolved/bin/my-wrapper' --launch-wrapper-arg 'arg 1' --launch-wrapper-arg '--leading' --launch-wrapper-arg '' --launch-wrapper-arg '--'",
    );
  });

  it("PiRuntimeAdapter refuses selected launchWrapper when seatLaunchEnvironment is absent, runtime is omp, or resolveLaunchWrapper fails (before writing pending sidecar)", async () => {
    const fs = memFs();
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const piWithoutEnv = new PiRuntimeAdapter({
      tmux: mockTmux({ sendShellCommand }),
      fsOps: fs,
      stateRoot: STATE_ROOT,
      runnerEntryPath: RUNNER,
      sleep: async () => {},
    });
    const res1 = await piWithoutEnv.launchHarness(
      { tmuxSession: SESSION, cwd: "/work", launchWrapper: ["my-wrapper", "--"] } as never,
      { name: SESSION },
    );
    expect(res1).toEqual({ ok: false, error: "launch_wrapper support unavailable; no agent started." });
    expect(sendShellCommand).not.toHaveBeenCalled();
    expect(statePath in fs.files).toBe(false);

    const ompWithEnv = new OmpRuntimeAdapter({
      tmux: mockTmux({ sendShellCommand }),
      seatLaunchEnvironment: {
        resolveLaunchWrapper: vi.fn((w: readonly string[]) => [...w]),
        command: vi.fn(async (_s: string, cmd: string) => cmd),
      } as never,
      fsOps: fs,
      stateRoot: STATE_ROOT,
      runnerEntryPath: RUNNER,
      sleep: async () => {},
    });
    const res2 = await ompWithEnv.launchHarness(
      { tmuxSession: SESSION, cwd: "/work", launchWrapper: ["my-wrapper", "--"] } as never,
      { name: SESSION },
    );
    expect(res2).toEqual({ ok: false, error: "launch_wrapper support unavailable; no agent started." });
    expect(sendShellCommand).not.toHaveBeenCalled();
    expect(statePath in fs.files).toBe(false);

    const failingCommand = vi.fn(async (_s: string, cmd: string) => cmd);
    const piWithFailingResolve = new PiRuntimeAdapter({
      tmux: mockTmux({ sendShellCommand }),
      seatLaunchEnvironment: {
        resolveLaunchWrapper: vi.fn(() => { throw new Error("PATH=/secret/token missing wrapper"); }),
        command: failingCommand,
      } as never,
      fsOps: fs,
      stateRoot: STATE_ROOT,
      runnerEntryPath: RUNNER,
      sleep: async () => {},
    });
    const res3 = await piWithFailingResolve.launchHarness(
      { tmuxSession: SESSION, cwd: "/work", launchWrapper: ["missing-wrapper", "--"] } as never,
      { name: SESSION },
    );
    expect(res3).toEqual({ ok: false, error: "launch_wrapper unavailable; no agent started." });
    expect(JSON.stringify(res3)).not.toContain("/secret/token");
    expect(failingCommand).not.toHaveBeenCalled();
    expect(sendShellCommand).not.toHaveBeenCalled();
    expect(statePath in fs.files).toBe(false);
  });

  it("PiRuntimeAdapter retains launch_path_too_long bare runner retry when wrapped because the raw runner command carries the exact same --launch-wrapper-arg flags", async () => {
    const seatLaunchEnvironment = {
      accountHome: () => undefined,
      resolveLaunchWrapper: vi.fn((w: readonly string[]) => [`/abs/bin/${w[0]}`, ...w.slice(1)]),
      command: vi.fn(async (_s: string, cmd: string) => `/usr/bin/env 'OPENRIG_RUNTIME=pi' ${cmd}`),
    } as never;

    const fs = memFs();
    let wrappedCalls = 0;
    const wrappedSend = vi.fn(async (_t: string, text: string): Promise<TmuxResult> => {
      if (++wrappedCalls === 1) return { ok: false, code: "launch_path_too_long", message: "staged script path too long" };
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true };
    });
    const wrappedAdapter = new PiRuntimeAdapter({
      tmux: mockTmux({ sendShellCommand: wrappedSend }),
      seatLaunchEnvironment,
      fsOps: fs,
      stateRoot: STATE_ROOT,
      runnerEntryPath: RUNNER,
      sleep: async () => {},
    });
    const wrappedRes = await wrappedAdapter.launchHarness(
      { tmuxSession: SESSION, cwd: "/work", launchWrapper: ["wrapper", "--flag", "--"] } as never,
      { name: SESSION },
    );
    expect(wrappedRes.ok).toBe(true);
    expect(wrappedSend).toHaveBeenCalledTimes(2);
    const expectedFlags = "--launch-wrapper-arg '/abs/bin/wrapper' --launch-wrapper-arg '--flag' --launch-wrapper-arg '--'";
    expect(wrappedSend.mock.calls[0]![1]).toContain(expectedFlags);
    expect(wrappedSend.mock.calls[1]![1]).toMatch(/^node '/);
    expect(wrappedSend.mock.calls[1]![1]).toContain(expectedFlags);

    // Unwrapped (including empty array []): still retries bare cmd on launch_path_too_long without wrapper flags
    const unwrappedFs = memFs();
    let calls = 0;
    const unwrappedSend = vi.fn(async (_t: string, text: string): Promise<TmuxResult> => {
      if (++calls === 1) return { ok: false, code: "launch_path_too_long", message: "staged script path too long" };
      unwrappedFs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true };
    });
    const unwrappedAdapter = new PiRuntimeAdapter({
      tmux: mockTmux({ sendShellCommand: unwrappedSend }),
      seatLaunchEnvironment,
      fsOps: unwrappedFs,
      stateRoot: STATE_ROOT,
      runnerEntryPath: RUNNER,
      sleep: async () => {},
    });
    const unwrappedRes = await unwrappedAdapter.launchHarness(
      { tmuxSession: SESSION, cwd: "/work", launchWrapper: [] } as never,
      { name: SESSION },
    );
    expect(unwrappedRes.ok).toBe(true);
    expect(unwrappedSend).toHaveBeenCalledTimes(2);
    expect(unwrappedSend.mock.calls[1]![1]).toMatch(/^node '/);
    expect(unwrappedSend.mock.calls[1]![1]).not.toContain("--launch-wrapper-arg");
  });

  it("PiResumeAdapter resolves launchWrapper before pending sidecar write, passes --launch-wrapper-arg tokens to runner without passing launchWrapper to command(), and retains launch_path_too_long retry with identical flags", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const commandCalls: Array<{ session: string; cmd: string; target: unknown }> = [];
    const resolveLaunchWrapper = vi.fn((w: readonly string[]) => [`/abs/bin/${w[0]}`, ...w.slice(1)]);
    const seatLaunchEnvironment = {
      accountHome: () => undefined,
      resolveLaunchWrapper,
      command: vi.fn(async (session: string, cmd: string, target: unknown) => {
        commandCalls.push({ session, cmd, target });
        return `/usr/bin/env ${cmd}`;
      }),
    } as never;
    const sendShellCommand = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const resumeAdapter = new PiResumeAdapter(
      mockTmux({ sendShellCommand }),
      fs,
      { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER },
      { seatLaunchEnvironment, pollMs: 1, maxWaitMs: 5, sleep: async () => {} },
    );

    const wrapper = ["my-wrapper", "--opt", "--"];
    const okRes = await resumeAdapter.resume(SESSION, "pi_session_file", SESSION_FILE, "/work", "zai/glm-5.2", "full_bypass", "high", wrapper);
    expect(okRes.ok).toBe(true);
    expect(resolveLaunchWrapper).toHaveBeenCalledWith(wrapper);
    expect(commandCalls).toEqual([{
      session: SESSION,
      cmd: expect.stringContaining("--approve --model 'zai/glm-5.2' --thinking 'high' --session"),
      target: { runtime: "pi", nodeId: "node-pi", accountHome: undefined },
    }]);
    const expectedFlags = "--launch-wrapper-arg '/abs/bin/my-wrapper' --launch-wrapper-arg '--opt' --launch-wrapper-arg '--'";
    expect(sendShellCommand.mock.calls[0]![1]).toContain("node '/daemon-dist/adapters/pi-runner.js'");
    expect(sendShellCommand.mock.calls[0]![1]).toContain(expectedFlags);

    // Without seatLaunchEnvironment -> refused before sendShellCommand or sidecar write
    const noEnvFs = memFs({ [SESSION_FILE]: "jsonl" });
    const noEnvSend = vi.fn(async () => ({ ok: true as const }));
    const noEnvAdapter = new PiResumeAdapter(
      mockTmux({ sendShellCommand: noEnvSend }),
      noEnvFs,
      { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER },
      { pollMs: 1, maxWaitMs: 5, sleep: async () => {} },
    );
    const noEnvRes = await noEnvAdapter.resume(SESSION, "pi_session_file", SESSION_FILE, "/work", undefined, undefined, undefined, wrapper);
    expect(noEnvRes).toEqual({ ok: false, code: "resume_failed", message: "launch_wrapper support unavailable; no agent started." });
    expect(noEnvSend).not.toHaveBeenCalled();
    expect(statePath in noEnvFs).toBe(false);

    // resolveLaunchWrapper throwing -> sanitized refusal before pending sidecar write
    const failResolveFs = memFs({ [SESSION_FILE]: "jsonl" });
    const failResolveSend = vi.fn(async () => ({ ok: true as const }));
    const failResolveAdapter = new PiResumeAdapter(
      mockTmux({ sendShellCommand: failResolveSend }),
      failResolveFs,
      { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER },
      {
        seatLaunchEnvironment: {
          resolveLaunchWrapper: vi.fn(() => { throw new Error("secret-path-value"); }),
          command: vi.fn(async (_s: string, cmd: string) => cmd),
        } as never,
        pollMs: 1, maxWaitMs: 5, sleep: async () => {},
      },
    );
    const failResolveRes = await failResolveAdapter.resume(SESSION, "pi_session_file", SESSION_FILE, "/work", undefined, undefined, undefined, wrapper);
    expect(failResolveRes).toEqual({ ok: false, code: "resume_failed", message: "launch_wrapper unavailable; no agent started." });
    expect(failResolveSend).not.toHaveBeenCalled();
    expect(statePath in failResolveFs.files).toBe(false);

    // launch_path_too_long when wrapped -> retries raw runner command with exact same wrapper flags
    const tooLongFs = memFs({ [SESSION_FILE]: "jsonl" });
    let tooLongCalls = 0;
    const tooLongSend = vi.fn(async (_t: string, text: string): Promise<TmuxResult> => {
      if (++tooLongCalls === 1) return { ok: false, code: "launch_path_too_long", message: "too long" };
      tooLongFs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true };
    });
    const tooLongAdapter = new PiResumeAdapter(
      mockTmux({ sendShellCommand: tooLongSend }),
      tooLongFs,
      { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER },
      { seatLaunchEnvironment, pollMs: 1, maxWaitMs: 5, sleep: async () => {} },
    );
    const tooLongRes = await tooLongAdapter.resume(SESSION, "pi_session_file", SESSION_FILE, "/work", undefined, undefined, undefined, wrapper);
    expect(tooLongRes.ok).toBe(true);
    expect(tooLongSend).toHaveBeenCalledTimes(2);
    expect(tooLongSend.mock.calls[0]![1]).toContain(expectedFlags);
    expect(tooLongSend.mock.calls[1]![1]).toMatch(/^node '/);
    expect(tooLongSend.mock.calls[1]![1]).toContain(expectedFlags);
  });
});

it.each(["selected", "cleared"])("does not bypass a %s Pi account when a wrapped launch cannot be staged", async selection => {
  const fs = memFs();
  const accountHome = selection === "cleared" ? null : "/accounts/pi";
  const sendShellCommand = vi.fn(async (): Promise<TmuxResult> => ({ ok: false, code: "launch_path_too_long", message: "fixture bound" }));
  const command = vi.fn(async (_session: string, cmd: string) => `/usr/bin/env ${cmd}`);
  const adapter = new PiRuntimeAdapter({
    tmux: mockTmux({ sendShellCommand }), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER,
    seatLaunchEnvironment: {
      accountHome: () => "/accounts/previous", resolveLaunchWrapper: () => ["/wrapper", "--"], command,
    } as never,
  });
  const result = await adapter.launchHarness({ tmuxSession: SESSION, nodeId: "node-pi", cwd: "/work", accountHome, launchWrapper: ["wrapper", "--"] } as never, { name: SESSION });
  expect(result.ok).toBe(false);
  expect(command.mock.calls[0]).toEqual([SESSION, expect.stringContaining("--launch-wrapper-arg '/wrapper'"), expect.objectContaining({ accountHome })]);
  expect(sendShellCommand).toHaveBeenCalledTimes(1);
});

it("stages a Pi account successor with canonical identity and a separate state directory", async () => {
  const fs = memFs();
  const predecessorPath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;
  fs.files[predecessorPath] = readyState(SESSION_FILE, "old-launch");
  const stagedRoot = `${STATE_ROOT}/account-switches/new-generation`;
  const stagedPath = piSeatPaths(stagedRoot, SESSION).runnerStatePath;
  const token = `${stagedRoot}/${SESSION}/sessions/new.jsonl`;
  const sendShellCommand = vi.fn(async (target: string, text: string) => {
    expect(target).toBe("staging-pane");
    expect(text).toContain(`--session-name '${SESSION}' --state-root '${stagedRoot}'`);
    fs.files[stagedPath] = readyState(token, launchIdFrom(text));
    return { ok: true as const };
  });
  const adapter = new PiRuntimeAdapter({ tmux: mockTmux({ sendShellCommand }), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER });
  const binding = { tmuxSession: "staging-pane", launchGeneration: "new-generation", cwd: "/work", runtimeSwitchFrom: { runtime: "pi", session: SESSION, pane: "%0", generation: "old-generation" } } as never;
  expect(await adapter.launchHarness(binding, { name: SESSION })).toMatchObject({ ok: true, resumeToken: token });
  expect(await adapter.checkReady(binding)).toMatchObject({ ready: true });
  expect(fs.files[predecessorPath]).toBe(readyState(SESSION_FILE, "old-launch"));
});
