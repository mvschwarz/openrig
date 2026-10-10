import { describe, expect, it } from "vitest";
import { RunnerCore, parseRunnerArgs, resolveRuntimeExecutable, type ExecutableResolverOps, type RunnerIo } from "../src/adapters/pi-runner.js";
import { buildPiChildArgs, buildPiChildEnv, buildPiRunnerCommand, OMP_PROVIDER_ENV_VARS, OMP_PROVIDER_EXTRA_ENV_VARS, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { collectAllowlistedProviderAuthEnv } from "../src/startup.js";

const sessionName = "omp-worker@rig";
const sessionFile = "/openrig/state/omp/omp-worker@rig/sessions/2026_0197.jsonl";

function runner() {
  const rpc: Record<string, unknown>[] = [];
  const activity: Record<string, unknown>[] = [];
  const sidecars: PiRunnerState[] = [];
  const mirror: string[] = [];
  const appends: string[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => { rpc.push(cmd); },
    mirrorLine: (line) => { mirror.push(line); },
    mirrorAppend: (text) => { appends.push(text); },
    postActivity: (payload) => { activity.push(payload); },
    writeSidecar: (state) => { sidecars.push(state); },
    sessionFileExists: () => true,
    now: () => "2026-09-24T12:00:00Z",
  };
  const core = new RunnerCore(io, { sessionName, nodeId: "node-1", generation: "occupant-42", launchId: "attempt-1" }, { runtime: "omp", catchUpSince: "entry-8" });
  core.start();
  core.start();
  return { core, rpc, activity, mirror, appends, sidecars };
}

describe("OMP runner command and child isolation", () => {
  it.each(["pi", "omp"] as const)("retains only supplied user names in the %s child baseline", runtime => {
    const opts = { runtime, agentDir: "/fixture/agent", sessionsDir: "/fixture/sessions" };
    const source = { HOME: "/fixture/home", PATH: "/fixture/bin", UNRELATED_VALUE: "not-forwarded" };
    const absent = buildPiChildEnv(source, opts);
    expect(absent).not.toHaveProperty("USER");
    expect(absent).not.toHaveProperty("LOGNAME");
    expect(absent).not.toHaveProperty("UNRELATED_VALUE");
    expect(buildPiChildEnv({ ...source, USER: "fixture-user", LOGNAME: "fixture-login" }, opts))
      .toEqual({ ...absent, USER: "fixture-user", LOGNAME: "fixture-login" });
  });
  it("launches exact session/fork with OMP approval flags, never Pi-only flags", () => {
    const common = { runnerEntryPath: "/daemon/pi-runner.js", sessionName, stateRoot: "/openrig/state/omp", cwd: "/work", model: "anthropic/claude-sonnet", runtime: "omp" as const, launchId: "attempt-1" };
    for (const [trust, mode] of [["approve", "yolo"], ["no-approve", "always-ask"]] as const) {
      const cmd = buildPiRunnerCommand({ ...common, trust, sessionFile });
      expect(cmd).toContain(`--runtime omp --approval-mode ${mode}`);
      expect(cmd).toContain(`--session '${sessionFile}'`);
      expect(cmd).not.toMatch(/--no-approve|--approve|--name|--resume/);
      const parsed = parseRunnerArgs(cmd.match(/(?:'[^']*'|[^\s]+)/g)!.slice(2).map((arg) => arg.replace(/^'|'$/g, "")));
      const child = buildPiChildArgs({ ...parsed, sessionName, sessionsDir: "/openrig/state/omp/omp-worker@rig/sessions", runtime: "omp" });
      expect(child).toEqual(["--mode", "rpc", "--session-dir", "/openrig/state/omp/omp-worker@rig/sessions", "--approval-mode", mode, "--model", "anthropic/claude-sonnet", "--session", sessionFile]);
      expect(buildPiChildArgs({ ...parsed, sessionsDir: "/sessions", runtime: "omp", sessionFile: undefined, forkRef: sessionFile })).toContain("--fork");
    }
    expect(() => parseRunnerArgs(["--runtime", "omp", "--session-name", sessionName, "--state-root", "/state", "--cwd", "/work", "--launch-id", "x", "--approve"])).toThrow(/requires --approval-mode/);
  });

  it("passes only declared provider key and managed identity, not daemon activity credentials", () => {
    const env = buildPiChildEnv({ PATH: "/usr/bin", HOME: "/operator", ANTHROPIC_API_KEY: "seat-key", OPENAI_API_KEY: "other-key", OPENRIG_ACTIVITY_HOOK_TOKEN: "private-token", OPENRIG_OCCUPANT_GENERATION: "occupant-42", AWS_SECRET_ACCESS_KEY: "other-secret" }, { runtime: "omp", agentDir: "/openrig/state/omp/seat/agent", sessionsDir: "/openrig/state/omp/seat/sessions", model: "anthropic/claude-sonnet", sessionName, nodeId: "node-1", openrigHome: "/openrig", openrigUrl: "http://127.0.0.1:3000" });
    // OMP children get the same accepted identity allowlist as Pi (including
    // the occupant generation), plus the seat HOME and pinned identity.
    expect(env).toMatchObject({ HOME: "/openrig/state/omp/seat", PI_CODING_AGENT_DIR: "/openrig/state/omp/seat/agent", PI_CODING_AGENT_SESSION_DIR: "/openrig/state/omp/seat/sessions", ANTHROPIC_API_KEY: "seat-key", OPENRIG_SESSION_NAME: sessionName, OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "omp", OPENRIG_HOME: "/openrig", OPENRIG_URL: "http://127.0.0.1:3000", OPENRIG_OCCUPANT_GENERATION: "occupant-42" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("OPENRIG_ACTIVITY_HOOK_TOKEN");
  });

  it("forwards the accepted OPENRIG_* identity to Pi children without OMP's seat HOME", () => {
    const env = buildPiChildEnv({ PATH: "/usr/bin", HOME: "/operator", OPENRIG_SESSION_NAME: sessionName, OPENRIG_NODE_ID: "node-1", OPENRIG_OCCUPANT_GENERATION: "occupant-42", OPENRIG_ACTIVITY_HOOK_TOKEN: "private-token" }, { runtime: "pi", agentDir: "/s/agent", sessionsDir: "/s/sessions", sessionName, nodeId: "node-1", openrigHome: "/openrig", openrigUrl: "http://127.0.0.1:3000" });
    expect(env).toMatchObject({ OPENRIG_SESSION_NAME: sessionName, OPENRIG_NODE_ID: "node-1", OPENRIG_OCCUPANT_GENERATION: "occupant-42" });
    expect(env).not.toHaveProperty("OPENRIG_ACTIVITY_HOOK_TOKEN");
    expect(env).not.toHaveProperty("OPENRIG_RUNTIME");
    expect(env.HOME).toBe("/operator");
  });

  it("admits every OMP provider key into OMP seats only", () => {
    const names = Object.values(OMP_PROVIDER_ENV_VARS);
    const env = Object.fromEntries(names.map((name) => [name, `value-of-${name}`]));
    expect(Object.keys(collectAllowlistedProviderAuthEnv(names.join(","), env, "omp")).sort()).toEqual([...new Set(names)].sort());
    // Every other runtime keeps main's set: OMP-only names are not admitted.
    expect(collectAllowlistedProviderAuthEnv("MISTRAL_API_KEY,ANTHROPIC_API_KEY", { MISTRAL_API_KEY: "m", ANTHROPIC_API_KEY: "a" })).toEqual({ ANTHROPIC_API_KEY: "a" });
    expect(collectAllowlistedProviderAuthEnv("AWS_SECRET_ACCESS_KEY", { AWS_SECRET_ACCESS_KEY: "x" }, "omp")).toEqual({});
  });

  it("admits a paired provider endpoint alongside its key, for OMP seats only", () => {
    const env = { LITELLM_API_KEY: "proxy-key", LITELLM_BASE_URL: "https://llm.internal/v1" };
    expect(collectAllowlistedProviderAuthEnv("LITELLM_API_KEY,LITELLM_BASE_URL", env, "omp")).toEqual(env);
    // Still double opt-in: an unnamed endpoint stays behind.
    expect(collectAllowlistedProviderAuthEnv("LITELLM_API_KEY", env, "omp")).toEqual({ LITELLM_API_KEY: "proxy-key" });
    expect(collectAllowlistedProviderAuthEnv("LITELLM_API_KEY,LITELLM_BASE_URL", env)).toEqual({});
  });

  it("forwards the declared provider's endpoint into an OMP child, and no other provider's", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/operator",
      LITELLM_API_KEY: "proxy-key",
      LITELLM_BASE_URL: "https://llm.internal/v1",
    };
    const opts = { agentDir: "/openrig/state/omp/seat/agent", sessionsDir: "/openrig/state/omp/seat/sessions", sessionName };
    expect(buildPiChildEnv(source, { ...opts, runtime: "omp", model: "litellm/gpt-oss:120b" })).toMatchObject({
      LITELLM_API_KEY: "proxy-key",
      LITELLM_BASE_URL: "https://llm.internal/v1",
    });
    // A different declared provider carries neither half of the pair.
    expect(buildPiChildEnv(source, { ...opts, runtime: "omp", model: "anthropic/claude-sonnet-4-5" }))
      .not.toHaveProperty("LITELLM_BASE_URL");
    // Pi keeps its own narrower map: no OMP endpoint crosses.
    expect(buildPiChildEnv(source, { ...opts, runtime: "pi", model: "litellm/gpt-oss:120b" }))
      .not.toHaveProperty("LITELLM_BASE_URL");
  });

  it("keeps every paired endpoint attached to a provider the runner can declare", () => {
    for (const provider of Object.keys(OMP_PROVIDER_EXTRA_ENV_VARS)) {
      expect(OMP_PROVIDER_ENV_VARS[provider]).toBeDefined();
    }
  });

  it("names every paired endpoint after its own provider's key variable", () => {
    // A typo here would silently forward another provider's endpoint, or none.
    for (const [provider, extras] of Object.entries(OMP_PROVIDER_EXTRA_ENV_VARS)) {
      const keyVar = OMP_PROVIDER_ENV_VARS[provider]!;
      expect(keyVar).toMatch(/_API_KEY$/);
      expect(extras).toEqual([keyVar.replace(/_API_KEY$/, "_BASE_URL")]);
    }
  });

  it("carries each paired provider's endpoint, and only that provider's", () => {
    const source: Record<string, string> = { PATH: "/usr/bin", HOME: "/operator" };
    for (const extras of Object.values(OMP_PROVIDER_EXTRA_ENV_VARS)) {
      for (const name of extras) source[name] = `endpoint-of-${name}`;
    }
    for (const [provider, keyVar] of Object.entries(OMP_PROVIDER_ENV_VARS)) {
      source[keyVar] = `key-of-${keyVar}`;
    }
    for (const provider of Object.keys(OMP_PROVIDER_ENV_VARS)) {
      const env = buildPiChildEnv(source, {
        runtime: "omp", agentDir: "/s/agent", sessionsDir: "/s/sessions", sessionName,
        model: `${provider}/some-model`,
      });
      const mine = OMP_PROVIDER_EXTRA_ENV_VARS[provider] ?? [];
      for (const name of mine) expect(env[name]).toBe(`endpoint-of-${name}`);
      // No other provider's endpoint rides along.
      const others = Object.entries(OMP_PROVIDER_EXTRA_ENV_VARS)
        .filter(([p]) => p !== provider).flatMap(([, v]) => v)
        .filter((name) => !mine.includes(name));
      for (const name of others) expect(env).not.toHaveProperty(name);
    }
  });

  it("admits an endpoint named without its key, for a keyless local proxy", () => {
    // Each allowlisted name stands alone; the pair is a convention, not a coupling.
    expect(collectAllowlistedProviderAuthEnv("LITELLM_BASE_URL", { LITELLM_BASE_URL: "http://localhost:4000/v1" }, "omp"))
      .toEqual({ LITELLM_BASE_URL: "http://localhost:4000/v1" });
    const env = buildPiChildEnv(
      { PATH: "/usr/bin", HOME: "/operator", LITELLM_BASE_URL: "http://localhost:4000/v1" },
      { runtime: "omp", agentDir: "/s/agent", sessionsDir: "/s/sessions", sessionName, model: "litellm/local" },
    );
    expect(env.LITELLM_BASE_URL).toBe("http://localhost:4000/v1");
    expect(env).not.toHaveProperty("LITELLM_API_KEY");
  });

  it("admits every paired endpoint through the OMP allowlist gate, and no other runtime's", () => {
    const names = Object.values(OMP_PROVIDER_EXTRA_ENV_VARS).flat();
    const env = Object.fromEntries(names.map((name) => [name, `value-of-${name}`]));
    expect(collectAllowlistedProviderAuthEnv(names.join(","), env, "omp")).toEqual(env);
    // Pi/Claude/Codex seats keep main's set: only the two already in
    // KNOWN_PROVIDER_AUTH_ENV cross, the OMP-only endpoints do not.
    const nonOmp = collectAllowlistedProviderAuthEnv(names.join(","), env);
    expect(Object.keys(nonOmp).sort()).toEqual(["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]);
  });
});

describe("OMP executable resolution before the seat HOME applies", () => {
  const shim = "/home/op/.local/share/mise/shims/omp";
  const real = "/home/op/.local/share/mise/installs/omp/18.2.11/omp";
  function ops(files: Record<string, string>, which = real): ExecutableResolverOps & { runs: string[][] } {
    const runs: string[][] = [];
    return {
      runs,
      isExecutable: (p) => p in files,
      realpath: (p) => files[p] ?? p,
      run: (file, args, env) => { runs.push([file, ...args, `HOME=${env.HOME}`]); return which; },
    };
  }

  it("resolves a mise shim to the real binary using the operator HOME", () => {
    const fake = ops({ [shim]: "/home/op/.local/bin/mise", [real]: real });
    expect(resolveRuntimeExecutable("omp", { PATH: "/usr/bin:/home/op/.local/share/mise/shims", HOME: "/home/op" }, fake)).toEqual({ ok: true, path: real });
    expect(fake.runs).toEqual([["/home/op/.local/bin/mise", "which", "omp", "HOME=/home/op"]]);
  });

  it("returns a plain binary's real path without running it", () => {
    const fake = ops({ "/opt/bin/omp": "/opt/omp/omp" });
    expect(resolveRuntimeExecutable("omp", { PATH: "relative:/opt/bin" }, fake)).toEqual({ ok: true, path: "/opt/omp/omp" });
    expect(fake.runs).toEqual([]);
  });

  it("fails as a launch error when omp is missing or the shim maps nowhere", () => {
    expect(resolveRuntimeExecutable("omp", { PATH: "/usr/bin" }, ops({}))).toMatchObject({ ok: false, error: expect.stringMatching(/not found on PATH/) });
    const broken = ops({ [shim]: "/home/op/.local/bin/mise" }, "");
    expect(resolveRuntimeExecutable("omp", { PATH: "/home/op/.local/share/mise/shims" }, broken)).toMatchObject({ ok: false, error: expect.stringMatching(/mise which omp/) });
  });

  it("returns a launch failure if the mise target disappears during resolution", () => {
    const fake = ops({ [shim]: "/home/op/.local/bin/mise", [real]: real });
    fake.realpath = (p) => {
      if (p === real) throw new Error("ENOENT: target removed");
      return "/home/op/.local/bin/mise";
    };
    expect(resolveRuntimeExecutable("omp", { PATH: "/home/op/.local/share/mise/shims" }, fake)).toMatchObject({ ok: false, error: expect.stringContaining("ENOENT") });
  });
});

describe("OMP RPC lifecycle", () => {
  it("restores the durable cursor once and publishes generation-bound identity", () => {
    const { core, rpc, sidecars, activity, mirror, appends } = runner();
    expect(rpc).toEqual([{ type: "get_state", id: "pi-runner-get-state" }, { type: "get_entries", since: "entry-8", id: "pi-runner-catch-up" }]);
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile, sessionId: "id-1" } }));
    expect(mirror).toContain(`[omp-runner] READY session=${sessionFile}`);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, lastEntryId: "entry-8", sessionFile });
    expect(activity).toContainEqual(expect.objectContaining({ eventFamily: "session_identity", runtime: "omp", generation: "occupant-42", sessionFile }));
    core.handlePiLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed words" }, message: { role: "assistant", content: [] } }));
    expect(appends).toEqual(["streamed words"]);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end", isTerminal: false }));
    expect(activity.filter((event) => event.hookEvent === "Stop")).toHaveLength(0);
    core.handleUserBlock("steer ongoing work");
    expect(rpc.at(-1)).toEqual({ type: "steer", message: "steer ongoing work" });
    core.handlePiLine(JSON.stringify({ type: "auto_compaction_start" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "active", subtype: "compaction", generation: "occupant-42" });
    core.handlePiLine(JSON.stringify({ type: "agent_end", isTerminal: true }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", runtime: "omp" });
  });

  it("re-posts identity until the daemon confirms the token, then stops", async () => {
    let persisted = false;
    type Delivery = { promise: Promise<Record<string, unknown> | null>; resolve: (body: Record<string, unknown> | null) => void };
    const pending: Delivery[] = [];
    const activity: Record<string, unknown>[] = [];
    const core = new RunnerCore({
      sendRpc: () => {}, mirrorLine: () => {}, mirrorAppend: () => {},
      postActivity: (payload) => {
        activity.push(payload);
        if (payload.eventFamily !== "session_identity") return;
        let resolve!: Delivery["resolve"];
        const promise = new Promise<Record<string, unknown> | null>((r) => { resolve = r; });
        pending.push({ promise, resolve });
        return promise;
      },
      writeSidecar: () => {}, now: () => "2026-09-24T12:00:00Z",
      sessionFileExists: () => persisted,
    }, { sessionName, generation: "occupant-42" }, { runtime: "omp" });
    // Resolve one delivery and let the runner observe its settlement.
    const answer = async (index: number, body: Record<string, unknown> | null) => {
      pending[index]!.resolve(body);
      await pending[index]!.promise;
      await Promise.resolve();
    };
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile, sessionId: "id-1" } }));
    // The JSONL does not exist until the first persisted turn.
    expect(pending).toHaveLength(0);
    persisted = true;
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.filter((event) => event.eventFamily === "session_identity")).toEqual([expect.objectContaining({ sessionFile })]);
    // A delivery still in flight is not duplicated.
    core.retrySessionIdentity();
    expect(pending).toHaveLength(1);
    // Daemon down: the POST resolved null, so the retry tick re-delivers.
    await answer(0, null);
    core.retrySessionIdentity();
    expect(pending).toHaveLength(2);
    // Reachable daemon that could not persist yet: still unconfirmed.
    await answer(1, { ok: true, tokenPersisted: false });
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(pending).toHaveLength(3);
    await answer(2, { ok: true, tokenPersisted: true });
    core.retrySessionIdentity();
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(pending).toHaveLength(3);
  });

  it("keeps prompt rejections visible as attention after the turn ends", () => {
    const { core, activity } = runner();
    core.handlePiLine(JSON.stringify({ type: "response", id: "prompt-1", command: "prompt", success: false, error: "No API key" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "runtime_error" });
    core.handleUserBlock("try again");
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "runtime_error" });
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop" });
  });

  it("reports an in-turn provider auth failure as attention, as OMP 18.2.11 emits it", () => {
    const { core, activity, mirror } = runner();
    const failed = { role: "assistant", content: [], provider: "anthropic", stopReason: "error", errorStatus: 401, errorMessage: "401 authentication_error: API key is invalid." };
    core.handlePiLine(JSON.stringify({ id: "p1", type: "response", command: "prompt", success: true }));
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "turn_start" }));
    core.handlePiLine(JSON.stringify({ type: "message_start", message: failed }));
    core.handlePiLine(JSON.stringify({ type: "message_end", message: failed }));
    core.handlePiLine(JSON.stringify({ type: "turn_end", message: failed }));
    core.handlePiLine(JSON.stringify({ type: "agent_end", isTerminal: true, messages: [failed] }));
    expect(mirror).toContain("[omp-runner] ERROR 401 authentication_error: API key is invalid.");
    expect(mirror.filter((line) => line.startsWith("[omp-runner] ERROR"))).toHaveLength(1);
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "runtime_error" });
    // One alert for one failure: the Stop is dropped, not replaced.
    expect(activity.filter((event) => event.subtype === "runtime_error")).toHaveLength(1);
    expect(activity.filter((event) => event.hookEvent === "Stop")).toHaveLength(0);
  });

  it("reports a model error carried only on turn_end, once per turn", () => {
    const { core, activity, mirror } = runner();
    const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" };
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "turn_start" }));
    core.handlePiLine(JSON.stringify({ type: "turn_end", message: failed }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(mirror).toContain("[omp-runner] ERROR 529 overloaded");
    expect(activity.filter((event) => event.subtype === "runtime_error")).toHaveLength(1);
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "runtime_error" });
    // A later turn failing again is a new failure and alerts again.
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "turn_start" }));
    core.handlePiLine(JSON.stringify({ type: "message_end", message: failed }));
    core.handlePiLine(JSON.stringify({ type: "turn_end", message: failed }));
    expect(activity.filter((event) => event.subtype === "runtime_error")).toHaveLength(2);
  });

  it("raises attention once when automatic retries exhaust (auto_retry_end success:false)", () => {
    const { core, activity, mirror } = runner();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_start" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false, finalError: "529 overloaded after 3 attempts" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(mirror.filter((line) => line.startsWith("[omp-runner] ERROR"))).toEqual(["[omp-runner] ERROR 529 overloaded after 3 attempts"]);
    expect(activity.filter((event) => event.subtype === "runtime_error")).toHaveLength(1);
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "runtime_error", runtime: "omp" });
    expect(activity.filter((event) => event.hookEvent === "Stop")).toHaveLength(0);
    // The failed message itself was already reported; the exhausted retry
    // that repeats it adds no second notice or alert.
    const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "busy" };
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "message_end", message: failed }));
    core.handlePiLine(JSON.stringify({ type: "turn_end", message: failed }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false }));
    expect(mirror.filter((line) => line.startsWith("[omp-runner] ERROR")).slice(1)).toEqual(["[omp-runner] ERROR busy"]);
    expect(activity.filter((event) => event.subtype === "runtime_error")).toHaveLength(2);
  });

  it("does not treat a rejected control command as a runtime error", () => {
    const { core, activity, mirror } = runner();
    core.handleUserBlock("/abort");
    core.handlePiLine(JSON.stringify({ id: "a1", type: "response", command: "abort", success: false, error: "Nothing to abort" }));
    expect(mirror.at(-1)).toMatch(/ERROR rpc: Nothing to abort/);
    expect(activity.filter((event) => event.subtype === "runtime_error")).toHaveLength(0);
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop" });
  });

  it("does not classify inherited object properties as input commands", () => {
    const { core, activity } = runner();
    core.handlePiLine(JSON.stringify({ type: "response", command: "constructor", success: false, error: "Unknown command" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity).not.toContainEqual(expect.objectContaining({ subtype: "runtime_error" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop" });
  });

  it("preserves runtime-error priority when a later UI request is cancelled", () => {
    const { core, activity } = runner();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider unavailable" } }));
    core.handlePiLine(JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "after-error" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "runtime_error" });
    expect(activity.filter((event) => event.hookEvent === "Notification")).toHaveLength(1);
  });

  it("keeps a cancelled approval as needs_input through the end of the turn", () => {
    const { core, rpc, activity, mirror } = runner();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "extension_ui_request", method: "select", id: "approval-1", options: ["Allow", "Deny"] }));
    expect(rpc.at(-1)).toEqual({ type: "extension_ui_response", id: "approval-1", cancelled: true });
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "permission_prompt", generation: "occupant-42" });
    expect(mirror.at(-1)).toMatch(/Operator action required/);
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "permission_prompt", runtime: "omp" });
    expect(activity.filter((event) => event.subtype === "permission_prompt")).toHaveLength(1);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", runtime: "omp" });
  });

  it("restores denied-approval attention when the model keeps working in the same turn", () => {
    const { core, activity } = runner();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "approval-2" }));
    core.handlePiLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "PreToolUse", subtype: "read" });
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "permission_prompt" });
    expect(activity.filter((event) => event.hookEvent === "Stop")).toHaveLength(0);
    // The next turn starts clean: its end is a normal idle.
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop" });
    expect(activity.filter((event) => event.subtype === "permission_prompt")).toHaveLength(2);
  });

  it("does not show attention for non-interactive UI requests", () => {
    const { core, activity } = runner();
    core.handlePiLine(JSON.stringify({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "autoresearch" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop" });
  });

  it("never reports READY when get_state cannot establish a session file", () => {
    const { core, mirror, sidecars } = runner();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: null } }));
    expect(sidecars).toEqual([]);
    expect(mirror.join("\n")).toMatch(/ERROR rpc get_state returned no session file/);
    expect(mirror.join("\n")).not.toContain("READY");
  });

  it("fails closed and writes no READY record on get_state failure or child exit", () => {
    const { core, mirror, sidecars, activity } = runner();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: false, error: "No models available" }));
    expect(mirror.join("\n")).toMatch(/ERROR rpc get_state: No models available/);
    expect(mirror.join("\n")).not.toContain("READY");
    core.handlePiExit(1);
    expect(sidecars.at(-1)).toMatchObject({ ready: false, exited: { code: 1 }, launchId: "attempt-1" });
    expect(activity.at(-1)).toMatchObject({ runtime: "omp", generation: "occupant-42", hookEvent: "Stop", subtype: "omp_exited" });
  });
});
