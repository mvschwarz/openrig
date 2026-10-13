import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCurrentWork } from "../src/domain/current-work.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
const PLUGIN = resolve(HERE, "../assets/plugins/openrig-core");
const CLAUDE_HOOKS = resolve(PLUGIN, "hooks/claude.json");
const CODEX_HOOKS = resolve(PLUGIN, "hooks/codex.json");
const TRACE = resolve(PLUGIN, "skills/refocusing/scripts/trace-to-root.py");
const REFOCUS_MD = resolve(PLUGIN, "skills/refocusing/references/refocus.md");
const LEGACY_COMPOSE = resolve(PLUGIN, "skills/openrig-operating-model/scripts/compose.py");
const REF = "packs/r5-contributing-knowledge-20260824";
// The daemon's own "this seat holds no in-progress typed baton" refusal, taken from the
// derivation itself (no rows, so no filesystem is touched) rather than copied, so a wording
// change in the daemon cannot leave these tests asserting a stale string.
const NO_BATON = deriveCurrentWork([], "/missions").currentWorkBasis;
const AMBIGUOUS = "2 distinct typed work nodes — refusing to guess";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function runHook(options: {
  ref?: string;
  fileContent?: string;
  rigStdout?: string;
  rigStderr?: string;
  rigStatus?: number;
  event?: string;
  transcriptContent?: string;
  extraEnv?: NodeJS.ProcessEnv;
  instanceContent?: string;
  runtime?: "claude" | "codex";
  whoamiStdout?: string;
  whoamiStatus?: number;
  capturePython?: boolean;
}) {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "refocus-context-ref-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const argvCapture = join(root, "rig-argv.json");
  const verbLog = join(root, "rig-verbs.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (options.instanceContent !== undefined) {
    mkdirSync(join(home, "refocus"), { recursive: true });
    writeFileSync(join(home, "refocus", "REFOCUS.md"), options.instanceContent, "utf8");
  }

  let transcript: string | undefined;
  if (options.transcriptContent !== undefined) {
    transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, options.transcriptContent, "utf8");
  }

  const rig = join(bin, "rig");
  // The fake answers two verbs. `queue whoami` is dispatched first and returns its own
  // stdout/status, so a whoami failure can be exercised without disturbing the context-get
  // contract below, which stays byte-identical to keep the existing suites unaffected.
  writeFileSync(rig, `#!/bin/sh
printf '%s %s %s\\n' "$1" "$2" "$3" >> "$RIG_VERB_LOG"
if [ "$1" = "queue" ] && [ "$2" = "whoami" ]; then
  printf '%s' "$RIG_WHOAMI_STDOUT"
  exit "\${RIG_WHOAMI_STATUS:-0}"
fi
printf '["%s","%s","%s"]' "$1" "$2" "$3" > "$RIG_ARGV_CAPTURE"
printf '%s' "$RIG_STDOUT"
printf '%s' "$RIG_STDERR" >&2
exit "\${RIG_STATUS:-0}"
`, "utf8");
  chmodSync(rig, 0o755);

  // The hook resolves its interpreter through PYTHON, so a shim there records the exact
  // trace-to-root argv — which is where --work-start is observable as an effect.
  const pythonLog = join(root, "python-argv.log");
  const python = join(bin, "python-shim");
  writeFileSync(python, `#!/bin/sh
printf '%s\\n' "$*" >> "$PYTHON_ARGV_LOG"
exit 0
`, "utf8");
  chmodSync(python, 0o755);

  let contentFile: string | undefined;
  if (options.fileContent !== undefined) {
    contentFile = join(root, "configured.md");
    writeFileSync(contentFile, options.fileContent, "utf8");
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ""}`,
    OPENRIG_HOME: home,
    OPENRIG_SESSION_NAME: "seat@test",
    OPENRIG_REFOCUS_CONTENT_REF: options.ref,
    OPENRIG_REFOCUS_CONTENT_FILE: contentFile,
    RIG_ARGV_CAPTURE: argvCapture,
    RIG_VERB_LOG: verbLog,
    RIG_STDOUT: options.rigStdout,
    RIG_STDERR: options.rigStderr,
    RIG_STATUS: options.rigStatus === undefined ? undefined : String(options.rigStatus),
    RIG_WHOAMI_STDOUT: options.whoamiStdout,
    RIG_WHOAMI_STATUS: options.whoamiStatus === undefined ? undefined : String(options.whoamiStatus),
    PYTHON_ARGV_LOG: pythonLog,
    OPENRIG_REFOCUS_NOW: "1",
    OPENRIG_REFOCUS_TREES: "work",
    OPENRIG_WORKSPACE_ROOT: home,
    OPENRIG_REFOCUS_WORK_NODE: home,
    ...(options.capturePython ? { PYTHON: python } : {}),
    ...options.extraEnv,
  } as NodeJS.ProcessEnv;

  const result = spawnSync(process.execPath, [HOOK, "--runtime", options.runtime || "claude"], {
    input: JSON.stringify({
      hook_event_name: options.event || "UserPromptSubmit",
      session_id: "refocus-context-ref-fixture",
      transcript_path: transcript || "",
    }),
    encoding: "utf8",
    env,
  });

  return {
    ...result,
    payload: result.stdout ? JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    } : null,
    argvCapture,
    verbLog,
    pythonLog,
    rigVerbs: () => (existsSync(verbLog) ? readFileSync(verbLog, "utf8") : ""),
    traceArgv: () => (existsSync(pythonLog) ? readFileSync(pythonLog, "utf8") : ""),
  };
}

describe("openrig-core refocus hook — context library refs", () => {
  it("REF wins over FILE and delivers the exact rig context get bytes", () => {
    const bundle = "# OpenRig Context Pack: proof v1\n\nassembled bytes\n";
    const result = runHook({ ref: REF, fileContent: "FILE MUST NOT WIN", rigStdout: bundle });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.payload?.hookSpecificOutput.additionalContext).toContain(
      `OPENRIG_REFOCUS_CONTENT_REF=${REF}`,
    );
    expect(result.payload?.hookSpecificOutput.additionalContext).not.toContain("FILE MUST NOT WIN");
    expect(result.payload?.hookSpecificOutput.additionalContext.endsWith(bundle)).toBe(true);
    expect(JSON.parse(readFileSync(result.argvCapture, "utf8"))).toEqual([
      "context", "get", REF,
    ]);
  });

  it("puts an unresolvable REF failure banner at the payload head and still delivers generic context", () => {
    const reason = `Context pack '${REF}' not found in library.`;
    const result = runHook({ ref: REF, rigStderr: `${reason}\n`, rigStatus: 1 });
    const context = result.payload?.hookSpecificOutput.additionalContext || "";

    expect(result.status).toBe(0);
    expect(context.startsWith(`REFOCUS CONTENT REF FAILED: ${REF} — ${reason}`)).toBe(true);
    expect(context).toContain("1. What is the person actually trying to get?");
    expect(context).not.toBe("1. What is the person actually trying to get?");
  });

  it("preserves FILE-only payload bytes when REF is unset", () => {
    const result = runHook({ fileContent: "configured file bytes\n" });

    expect(result.status).toBe(0);
    expect(result.payload?.hookSpecificOutput.additionalContext.endsWith("configured file bytes")).toBe(true);
  });

  it("keeps FILE above instance content and instance content above the shipped default", () => {
    const instance = runHook({ instanceContent: "INSTANCE CONTENT" });
    expect(instance.payload?.hookSpecificOutput.additionalContext.endsWith("INSTANCE CONTENT")).toBe(true);
    expect(instance.payload?.hookSpecificOutput.additionalContext).not.toContain("Discomfort on any of these");

    const file = runHook({ fileContent: "FILE CONTENT", instanceContent: "INSTANCE MUST NOT WIN" });
    expect(file.payload?.hookSpecificOutput.additionalContext.endsWith("FILE CONTENT")).toBe(true);
    expect(file.payload?.hookSpecificOutput.additionalContext).not.toContain("INSTANCE MUST NOT WIN");
  });
});

describe("openrig-core refocus hook — S18 trigger and event contract", () => {
  function refocusEvents(path: string): string[] {
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    return Object.entries(config.hooks)
      .filter(([, entries]) => entries.some((entry) => entry.hooks.some((hook) => /refocus\.cjs/.test(hook.command))))
      .map(([event]) => event)
      .sort();
  }

  it("never registers or emits refocus at SessionStart", () => {
    expect(refocusEvents(CLAUDE_HOOKS)).not.toContain("SessionStart");
    expect(refocusEvents(CODEX_HOOKS)).not.toContain("SessionStart");

    const result = runHook({ event: "SessionStart", extraEnv: { OPENRIG_REFOCUS_NOW: undefined } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("emits schema-valid output or a valid no-op for every registered event", () => {
    for (const [runtime, configPath] of [["claude", CLAUDE_HOOKS], ["codex", CODEX_HOOKS]] as const) {
      for (const event of refocusEvents(configPath)) {
        const result = runHook({
          runtime,
          event,
          transcriptContent: "threshold crossed",
          extraEnv: { OPENRIG_REFOCUS_BYTES: "1", OPENRIG_REFOCUS_NOW: undefined },
        });
        expect(result.status, `${runtime}:${event}`).toBe(0);
        if (!result.stdout) continue;
        expect(event, `${runtime}:${event} may inject context only at a prompt boundary`).toBe("UserPromptSubmit");
        const payload = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(payload).toEqual({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: expect.any(String),
          },
        });
      }
    }
  });

  it("is on by default, on-demand triggerable, and configurable off", () => {
    const onDemand = runHook({});
    expect(onDemand.stdout).not.toBe("");
    expect(onDemand.payload?.hookSpecificOutput.additionalContext).toContain("REFOCUS (on demand)");

    const codexOnDemand = runHook({ runtime: "codex" });
    expect(codexOnDemand.payload?.hookSpecificOutput.additionalContext).toContain("REFOCUS (on demand)");

    const off = runHook({
      transcriptContent: "threshold crossed",
      extraEnv: {
        OPENRIG_REFOCUS_ENABLED: "0",
        OPENRIG_REFOCUS_BYTES: "1",
      },
    });
    expect(off.status).toBe(0);
    expect(off.stdout).toBe("");
  });

  it("uses Codex PostCompact exactly and never substitutes a byte/reset threshold", () => {
    expect(refocusEvents(CODEX_HOOKS)).toContain("PostCompact");

    const thresholdOnly = runHook({
      runtime: "codex",
      transcriptContent: "threshold crossed",
      extraEnv: { OPENRIG_REFOCUS_BYTES: "1", OPENRIG_REFOCUS_NOW: undefined },
    });
    expect(thresholdOnly.status).toBe(0);
    expect(thresholdOnly.stdout).toBe("");
  });

  it("ships self-teaching defaults that cite, rather than copy, the S15 onboarding pack", () => {
    const result = runHook({});
    const context = result.payload?.hookSpecificOutput.additionalContext || "";
    expect(context).toContain("OPENRIG_REFOCUS_CONTENT_REF");
    expect(context).toContain("OPENRIG_REFOCUS_CONTENT_FILE");
    expect(context).toContain("$OPENRIG_HOME/refocus/REFOCUS.md");
    expect(context).toContain("openrig-onboarding-01.md");
    expect(context).toContain("openrig-onboarding-02.md");
    expect(context).toContain("1. What is the person actually trying to get?");
    expect(readFileSync(REFOCUS_MD, "utf8")).toContain("refocusing");
  });
});

describe("openrig-core refocusing skill — real dual-tree trace", () => {
  function fixture() {
    root = mkdtempSync(join(tmpdir(), "refocus-trace-"));
    const topology = join(root, "topology");
    const workspace = join(root, "workspace");
    const topologyStart = join(topology, "rigs/demo/seats/builder");
    const workStart = join(workspace, "missions/release/slices/feature");
    const bin = join(root, "bin");
    mkdirSync(topologyStart, { recursive: true });
    mkdirSync(workStart, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(topology, "rigs/demo/LEARNED.md"), "# Demo rig learned\n", "utf8");
    writeFileSync(join(topologyStart, "LEARNED.md"), "# Builder learned\n", "utf8");
    writeFileSync(join(workspace, "SPEC.md"), "---\nintent: Build useful things\n---\n# Project\n", "utf8");
    writeFileSync(join(workspace, "missions/release/SPEC.md"), "---\nintent: Ship the release\n---\n# Release\n", "utf8");
    writeFileSync(join(workStart, "SPEC.md"), "---\nintent: Deliver refocus\n---\n# Feature\n", "utf8");
    writeFileSync(join(workspace, "missions/release/NOTES.md"), "release observation secret\n", "utf8");
    writeFileSync(join(workStart, "NOTES.md"), "feature observation secret\n", "utf8");
    const rig = join(bin, "rig");
    const callLog = join(root, "rig-calls.log");
    // Every invocation is logged, so a test can count the rig processes one fire spends.
    writeFileSync(rig, `#!/bin/sh
printf '%s\\n' "$*" >> "$RIG_CALL_LOG"
if [ -n "$RIG_HANG" ]; then exec sleep "$RIG_HANG"; fi
# A slow call that still answers; the sleep holds no output pipe, so a timeout kill returns at once.
slow() { if [ -n "$1" ]; then sleep "$1" </dev/null >/dev/null 2>&1; fi; }
if [ "$1 $2" = "queue whoami" ]; then
  if [ -n "$RIG_QUEUE_WHOAMI_SLEEP" ]; then exec sleep "$RIG_QUEUE_WHOAMI_SLEEP"; fi
  slow "$RIG_SLOW_QUEUE_WHOAMI"
  printf '%s' "$RIG_QUEUE_WHOAMI_STDOUT"; exit 0
fi
if [ "$1 $2" = "config --json" ]; then
  slow "$RIG_SLOW_CONFIG_JSON"
  printf '%s' "$RIG_CONFIG_JSON_STDOUT"; exit "\${RIG_CONFIG_JSON_STATUS:-0}"
fi
if [ "$1 $2" = "context get" ]; then slow "$RIG_SLOW_CONTEXT"; printf 'slow configured content for %s\\n' "$3"; exit 0; fi
if [ "$1 $2" = "whoami --json" ]; then printf '{"identity":{"rigName":"demo","sessionName":"builder@demo"}}\\n'; exit 0; fi
if [ "$1 $2 $3" = "config get topology.root" ]; then printf '%s\\n' "$OPENRIG_TEST_TOPOLOGY_ROOT"; exit 0; fi
if [ "$1 $2 $3" = "config get workspace.root" ]; then printf '%s\\n' "$OPENRIG_TEST_WORKSPACE_ROOT"; exit 0; fi
if [ "$1 $2" = "scope resolve-notes" ]; then
  slow "$RIG_SLOW_RESOLVE"
  if [ -r "$3/NOTES.md" ]; then printf '{"ok":true,"resolution":{"path":"%s","name":"NOTES.md"}}\\n' "$3/NOTES.md"; exit 0; fi
  if [ -r "$3/MISSION_NOTES.md" ]; then printf '{"ok":true,"resolution":{"path":"%s","name":"MISSION_NOTES.md"}}\\n' "$3/MISSION_NOTES.md"; exit 0; fi
  printf '{"ok":true,"resolution":null}\\n'; exit 0
fi
exit 1
`, "utf8");
    chmodSync(rig, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ""}`,
      OPENRIG_TEST_TOPOLOGY_ROOT: topology,
      OPENRIG_TEST_WORKSPACE_ROOT: workspace,
      RIG_CALL_LOG: callLog,
    };
    const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : []);
    const resetCalls = () => rmSync(callLog, { force: true });
    return { topology, workspace, topologyStart, workStart, env, calls, resetCalls };
  }

  function trace(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    return spawnSync("python3", [TRACE, ...args], { encoding: "utf8", env, cwd });
  }

  // The work-node cases below must not inherit an ambient work-node variable from the runner.
  const unpinned = (env: NodeJS.ProcessEnv) => ({ ...env, OPENRIG_REFOCUS_WORK_NODE: undefined });

  it("renders both config-rooted, path-only ascents with notes at light depth", () => {
    const f = fixture();
    const result = trace([
      "--trees", "both", "--depth", "light",
      "--topology-start", f.topologyStart,
      "--work-start", f.workStart,
    ], f.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TOPOLOGY TRACE");
    expect(result.stdout).toContain("Demo rig learned");
    expect(result.stdout).toContain("Builder learned");
    expect(result.stdout).toContain("WORK TRACE");
    expect(result.stdout).toContain("Build useful things");
    expect(result.stdout).toContain("Ship the release");
    expect(result.stdout).toContain("Deliver refocus");
    expect(result.stdout).toContain("NOTES.md");
    expect(result.stdout).not.toContain("observation secret");
  });

  it("makes tree and depth intensity observable and reports a broken chain link", () => {
    const f = fixture();
    unlinkSync(join(f.topology, "rigs/demo/LEARNED.md"));
    const topologyOnly = trace([
      "--trees", "topology", "--depth", "full",
      "--topology-start", f.topologyStart,
      "--work-start", f.workStart,
    ], f.env);
    expect(topologyOnly.status).toBe(0);
    expect(topologyOnly.stdout).toContain("MISSING LINK");
    expect(topologyOnly.stdout).not.toContain("WORK TRACE");

    const workFull = trace([
      "--trees", "work", "--depth", "full",
      "--topology-start", f.topologyStart,
      "--work-start", f.workStart,
    ], f.env);
    expect(workFull.status).toBe(0);
    expect(workFull.stdout).toContain("feature observation secret");
    expect(workFull.stdout).not.toContain("TOPOLOGY TRACE");
  });

  it("falls back to the work root, labelled as broad orientation, for the daemon's exact no-baton basis", () => {
    const f = fixture();
    // cwd sits on a slice to prove the fallback does not quietly re-point to cwd inference.
    const result = trace(["--trees", "work", "--work-basis", NO_BATON], unpinned(f.env), f.workStart);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`start: ${realpathSync(f.workspace)}\nFALLBACK — no current typed baton (${NO_BATON})`);
    expect(result.stdout).toContain("not evidence of a current mission");
    expect(result.stdout).toContain("Build useful things");
    expect(result.stdout).not.toContain("Ship the release");
    expect(result.stdout).not.toContain("Deliver refocus");
    expect(result.stdout).not.toContain("TRACE GAP");
  });

  it("keeps the sibling 'resolved to no work node' refusal a named gap, never the fallback", () => {
    const f = fixture();
    const sibling = "no typed in-progress work resolved to a work node";
    const result = trace(["--trees", "work", "--work-basis", sibling], unpinned(f.env), f.workStart);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`TRACE GAP — no single current work node: ${sibling}`);
    expect(result.stdout).not.toContain("FALLBACK");
    expect(result.stdout).not.toContain("Build useful things");
  });

  it("names an ambiguous basis as the gap even when the working directory is inside the workspace", () => {
    const f = fixture();
    const result = trace(["--trees", "work", "--work-basis", AMBIGUOUS], unpinned(f.env), f.workStart);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`TRACE GAP — no single current work node: ${AMBIGUOUS}`);
    expect(result.stdout).not.toContain("FALLBACK");
    expect(result.stdout).not.toContain("Deliver refocus");
  });

  it("reports an unreadable current-work answer as UNKNOWN even when the working directory is inside the workspace", () => {
    const f = fixture();
    const reason = "queue whoami answer was not JSON";
    const result = trace(["--trees", "work", "--work-unknown", reason], unpinned(f.env), f.workStart);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`TRACE GAP — current work node UNKNOWN: ${reason}`);
    expect(result.stdout).not.toContain("FALLBACK");
    expect(result.stdout).not.toContain("Deliver refocus");
  });

  it("lets an explicit --work-start or OPENRIG_REFOCUS_WORK_NODE win over a daemon basis", () => {
    const f = fixture();
    const flag = trace(["--trees", "work", "--work-start", f.workStart, "--work-basis", NO_BATON], unpinned(f.env));
    expect(flag.status).toBe(0);
    expect(flag.stdout).toContain("Deliver refocus");
    expect(flag.stdout).not.toContain("FALLBACK");
    expect(flag.stdout).not.toContain("TRACE GAP");

    const env = trace(["--trees", "work", "--work-basis", AMBIGUOUS], { ...f.env, OPENRIG_REFOCUS_WORK_NODE: f.workStart });
    expect(env.status).toBe(0);
    expect(env.stdout).toContain("Deliver refocus");
    expect(env.stdout).not.toContain("TRACE GAP");
  });

  it("keeps standalone cwd inference and names literal-path recovery when unresolved", () => {
    const f = fixture();
    const inside = trace(["--trees", "work"], unpinned(f.env), f.workStart);
    expect(inside.status).toBe(0);
    expect(inside.stdout).toContain("Deliver refocus");
    expect(inside.stdout).not.toContain("FALLBACK");

    const outside = trace(["--trees", "work"], unpinned(f.env), dirname(f.workspace));
    expect(outside.status).toBe(0);
    expect(outside.stdout).toContain(
      "TRACE GAP — current work node is unresolved; pass --work-start with a literal absolute path (or configure OPENRIG_REFOCUS_WORK_NODE separately)",
    );
  });

  it("keeps the trace script's no-baton text equal to the daemon's refusal", () => {
    // -B: importing the script must not write __pycache__ into the shipped skill, which the pack build rejects.
    const loaded = spawnSync("python3", ["-B", "-c", [
      "import importlib.util, sys",
      "spec = importlib.util.spec_from_file_location('trace_to_root', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "sys.stdout.write(module.NO_CURRENT_BATON_BASIS)",
    ].join("\n"), TRACE], { encoding: "utf8" });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toBe(NO_BATON);
  });

  it("has one public refocus trace implementation and marks the old composer superseded for this use", () => {
    expect(existsSync(TRACE)).toBe(true);
    const skill = readFileSync(resolve(PLUGIN, "skills/refocusing/SKILL.md"), "utf8");
    expect(skill).toContain("trace-to-root.py");
    expect(readFileSync(LEGACY_COMPOSE, "utf8")).toMatch(/SUPERSEDED FOR REFOCUS/i);

    const publicText = [skill, readFileSync(REFOCUS_MD, "utf8"), readFileSync(TRACE, "utf8")].join("\n");
    expect(publicText).not.toMatch(/\/(?:Users|home|private|var|opt)\//);
    expect(publicText).not.toMatch(/v-openrig-build|release-0\.5\.5|qitem-/i);
  });

  // One fire used to start 7 rig processes on a typed slice: queue whoami, two config gets,
  // whoami, and one resolver call per level. The hook now reads both roots with one config read
  // and the script takes a canonical seat from OPENRIG_SESSION_NAME, which leaves 5.
  describe("rig processes per fire", () => {
    const typed = (workNodePath: string) =>
      JSON.stringify({ currentWork: { workNodePath }, currentWorkBasis: "one typed in-progress work node" });
    const configJson = (topology: unknown, workspace: unknown) => JSON.stringify({
      daemon: { port: 1 },
      db: { path: "CONFIG-FIELD-NOT-FOR-OUTPUT" },
      topology: { root: topology },
      workspace: { root: workspace },
    });
    // Nothing ambient may decide a root, a start or the interpreter.
    const clean = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
      ...env,
      OPENRIG_NODE_ID: undefined,
      OPENRIG_SESSION_NAME: undefined,
      OPENRIG_TOPOLOGY_ROOT: undefined,
      OPENRIG_WORKSPACE_ROOT: undefined,
      OPENRIG_REFOCUS_TOPOLOGY_NODE: undefined,
      OPENRIG_REFOCUS_WORK_NODE: undefined,
      OPENRIG_REFOCUS_TREES: undefined,
      OPENRIG_REFOCUS_DEPTH: undefined,
      OPENRIG_REFOCUS_CONTENT_REF: undefined,
      OPENRIG_REFOCUS_CONTENT_FILE: undefined,
      PYTHON: undefined,
    });

    function hook(f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = {}) {
      f.resetCalls();
      const result = spawnSync(process.execPath, [HOOK, "--runtime", "claude"], {
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "refocus-calls" }),
        encoding: "utf8",
        env: {
          ...clean(f.env),
          OPENRIG_HOME: join(root!, "hook-home"),
          OPENRIG_SESSION_NAME: "builder@demo",
          OPENRIG_REFOCUS_NOW: "1",
          RIG_QUEUE_WHOAMI_STDOUT: typed(f.workStart),
          RIG_CONFIG_JSON_STDOUT: configJson(f.topology, f.workspace),
          ...env,
        },
      });
      const context = result.stdout
        ? (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
        : "";
      return { ...result, context, calls: f.calls() };
    }

    const resolverCalls = (f: ReturnType<typeof fixture>, nodes: string[]) =>
      nodes.map((node) => `scope resolve-notes ${join(realpathSync(f.workspace), node)} --json`);

    it("spends 5 rig processes on a typed fire and 3 on the no-baton fallback", () => {
      const f = fixture();
      const typedFire = hook(f);
      expect(typedFire.status).toBe(0);
      expect(typedFire.stderr).toBe("");
      expect(typedFire.context).toContain(`start: ${realpathSync(f.topology)}/rigs/demo/seats/builder\n`);
      expect(typedFire.context).toContain("Builder learned");
      expect(typedFire.context).toContain("Deliver refocus");
      expect(typedFire.context).not.toContain("CONFIG-FIELD-NOT-FOR-OUTPUT");
      expect(typedFire.calls).toEqual([
        "queue whoami --json",
        "config --json",
        ...resolverCalls(f, ["", "missions/release", "missions/release/slices/feature"]),
      ]);

      const fallback = hook(f, { RIG_QUEUE_WHOAMI_STDOUT: JSON.stringify({ currentWork: null, currentWorkBasis: NO_BATON }) });
      expect(fallback.status).toBe(0);
      expect(fallback.context).toContain(`FALLBACK — no current typed baton (${NO_BATON})`);
      expect(fallback.context).toContain("Builder learned");
      expect(fallback.calls).toEqual(["queue whoami --json", "config --json", ...resolverCalls(f, [""])]);
    });

    it("sets no root from a failed or malformed config read, so the script's own lookup runs as before", () => {
      const f = fixture();
      for (const env of [
        { RIG_CONFIG_JSON_STDOUT: "", RIG_CONFIG_JSON_STATUS: "1" },
        { RIG_CONFIG_JSON_STDOUT: "not json at all" },
        { RIG_CONFIG_JSON_STDOUT: configJson(42, null) },
      ]) {
        const result = hook(f, env);
        expect(result.status).toBe(0);
        expect(result.calls.filter((call) => call.startsWith("config"))).toEqual([
          "config --json",
          "config get topology.root",
          "config get workspace.root",
        ]);
        expect(result.context).toContain(`root: ${realpathSync(f.topology)}`);
        expect(result.context).toContain("Builder learned");
        expect(result.context).toContain("Deliver refocus");
      }
    });

    it("keeps explicit roots, fills only a missing one, and skips the read when both are supplied", () => {
      const f = fixture();
      const decoy = join(root!, "decoy-root");

      const both = hook(f, {
        OPENRIG_TOPOLOGY_ROOT: f.topology,
        OPENRIG_WORKSPACE_ROOT: f.workspace,
        RIG_CONFIG_JSON_STDOUT: configJson(decoy, decoy),
      });
      expect(both.status).toBe(0);
      expect(both.calls.filter((call) => call.startsWith("config"))).toEqual([]);
      expect(both.context).toContain("Builder learned");
      expect(both.context).toContain("Deliver refocus");

      const partial = hook(f, {
        OPENRIG_TOPOLOGY_ROOT: f.topology,
        RIG_CONFIG_JSON_STDOUT: configJson(decoy, f.workspace),
      });
      expect(partial.calls.filter((call) => call.startsWith("config"))).toEqual(["config --json"]);
      expect(partial.context).toContain(`root: ${realpathSync(f.topology)}`);
      expect(partial.context).toContain("Deliver refocus");
      expect(partial.context).not.toContain("decoy-root");

      const empty = hook(f, { OPENRIG_TOPOLOGY_ROOT: "", OPENRIG_WORKSPACE_ROOT: f.workspace });
      expect(empty.calls.filter((call) => call.startsWith("config"))).toEqual(["config --json"]);
      expect(empty.context).toContain(`root: ${realpathSync(f.topology)}`);
      expect(empty.context).toContain("Builder learned");
    });

    it("reads config only for the roots the selected trees need", () => {
      const f = fixture();
      const work = hook(f, { OPENRIG_REFOCUS_TREES: "work", OPENRIG_WORKSPACE_ROOT: f.workspace });
      expect(work.status).toBe(0);
      expect(work.calls.filter((call) => call.startsWith("config"))).toEqual([]);
      expect(work.context).toContain("Deliver refocus");
      expect(work.context).not.toContain("TOPOLOGY TRACE");

      const topology = hook(f, { OPENRIG_REFOCUS_TREES: "topology", OPENRIG_TOPOLOGY_ROOT: f.topology });
      expect(topology.status).toBe(0);
      expect(topology.calls.filter((call) => call.startsWith("config"))).toEqual([]);
      expect(topology.context).toContain("Builder learned");
      expect(topology.context).not.toContain("WORK TRACE");
    });

    // Both harnesses kill the hook at 5 s. With every rig call hanging, queue whoami (2 s) and
    // python (2 s) are fixed, so the config read may only use what is left; a gap is delivered.
    it("delivers within the 5 s hook kill when every rig call hangs", () => {
      const f = fixture();
      const started = Date.now();
      const result = hook(f, { RIG_HANG: "8" });
      const elapsed = Date.now() - started;
      expect(result.status).toBe(0);
      expect(elapsed).toBeLessThan(5_000);
      expect(result.context).toContain("REFOCUS (on demand)");
      expect(result.context).toContain("TRACE GAP");
      expect(result.calls[0]).toBe("queue whoami --json");
      expect(result.calls.filter((call) => call === "config --json").length).toBeLessThanOrEqual(1);
    }, 20_000);

    // With a content ref, `rig context get` runs after python. Every call here answers, just slowly:
    // main delivers this fire well under 5 s, so the config read must not spend the time the
    // content lookup needs. Without the content reserve this fire took over 5.2 s and was killed.
    it("delivers a slow but successful fire with a content ref inside the 5 s hook kill", () => {
      const f = fixture();
      const started = Date.now();
      const result = hook(f, {
        OPENRIG_REFOCUS_CONTENT_REF: "packs/slow-ref",
        RIG_SLOW_QUEUE_WHOAMI: "0.6",
        RIG_SLOW_CONFIG_JSON: "1.7",
        RIG_SLOW_RESOLVE: "0.4",
        RIG_SLOW_CONTEXT: "1.5",
      });
      const elapsed = Date.now() - started;
      expect(result.status).toBe(0);
      expect(elapsed).toBeLessThan(5_000);
      expect(result.context).toContain("REFOCUS CONTENT SOURCE: OPENRIG_REFOCUS_CONTENT_REF=packs/slow-ref");
      expect(result.context).toContain("slow configured content for packs/slow-ref");
      expect(result.calls).not.toContain("config --json");
    }, 20_000);

    // A queue whoami past the hook's 2 s budget must reach the trace as UNKNOWN (#484 review LOW-1).
    it("passes a queue whoami that outlives its 2 s budget as UNKNOWN to the real trace", () => {
      const f = fixture();
      const result = hook(f, { RIG_QUEUE_WHOAMI_SLEEP: "6" });
      expect(result.status).toBe(0);
      expect(result.context).toContain(
        "TRACE GAP — current work node UNKNOWN: queue whoami failed: spawnSync rig ETIMEDOUT",
      );
      expect(result.context).not.toContain("Deliver refocus");
    }, 20_000);

    // Vectors from the daemon's session-name parity set (session-name-parity.test.ts).
    const topologyTrace = (f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv, args: string[] = []) => {
      f.resetCalls();
      return trace(["--trees", "topology", ...args], { ...clean(f.env), ...env });
    };

    it("derives the seat start from a canonical session name without asking rig whoami", () => {
      const f = fixture();
      for (const [session, seat] of [
        ["builder@demo", "rigs/demo/seats/builder"],
        ["dev46-driver2@openrig-delivery", "rigs/openrig-delivery/seats/dev46-driver2"],
        ["member@rig@x", "rigs/rig@x/seats/member"],
        ["human@some-rig", "rigs/some-rig/seats/human"],
      ]) {
        mkdirSync(join(f.topology, seat), { recursive: true });
        const result = topologyTrace(f, { OPENRIG_SESSION_NAME: session });
        expect(result.status, session).toBe(0);
        expect(result.stdout, session).toContain(`start: ${realpathSync(f.topology)}/${seat}\n`);
        expect(f.calls(), session).not.toContain("whoami --json");
      }
    });

    it("asks rig whoami once when a canonical session name has no seat folder", () => {
      const f = fixture();
      // A stale name left over from a seat swap: canonical, but no such seat exists.
      const result = topologyTrace(f, { OPENRIG_SESSION_NAME: "builder-v2@demo" });
      expect(result.status).toBe(0);
      expect(f.calls().filter((call) => call === "whoami --json")).toHaveLength(1);
      expect(result.stdout).toContain(`start: ${realpathSync(f.topology)}/rigs/demo/seats/builder\n`);
      expect(result.stdout).toContain("Builder learned");
    });

    it("keeps rig whoami for legacy, malformed, human-class and out-of-charset session names", () => {
      const f = fixture();
      for (const session of [undefined, "", "r03-worker", "bare", "@rig", "member@", "human@kernel", "human-mvs@host", "mike@external", "seat/x@demo"]) {
        const result = topologyTrace(f, { OPENRIG_SESSION_NAME: session });
        expect(result.status, String(session)).toBe(0);
        expect(f.calls(), String(session)).toContain("whoami --json");
        expect(result.stdout, String(session)).toContain(`start: ${realpathSync(f.topology)}/rigs/demo/seats/builder\n`);
      }
    });

    it("lets an explicit topology start win over the session name", () => {
      const f = fixture();
      const explicit = join(f.topology, "rigs/demo");
      const flag = topologyTrace(f, { OPENRIG_SESSION_NAME: "other@elsewhere" }, ["--topology-start", explicit]);
      expect(flag.stdout).toContain(`start: ${explicit}\n`);
      expect(f.calls()).not.toContain("whoami --json");

      const env = topologyTrace(f, { OPENRIG_SESSION_NAME: "other@elsewhere", OPENRIG_REFOCUS_TOPOLOGY_NODE: explicit });
      expect(env.stdout).toContain(`start: ${explicit}\n`);
      expect(f.calls()).not.toContain("whoami --json");
    });
  });
});

describe("openrig-core refocus hook — delivery state", () => {
  // These cases exercise delivery state; the real dual-tree trace is covered above.
  function successfulTrace(home: string): string {
    const script = join(home, "trace-success");
    writeFileSync(script, '#!/bin/sh\nprintf "WORK TRACE: fixture intent\\n"\n');
    chmodSync(script, 0o755);
    return script;
  }

  it("retains due state at Stop, then consumes one context-visible delivery", () => {
    root = mkdtempSync(join(tmpdir(), "refocus-delivery-state-"));
    const home = join(root, "home");
    const transcript = join(root, "transcript.jsonl");
    const state = join(home, "refocus", "seat@test__transcript.json");
    mkdirSync(join(home, "refocus"), { recursive: true });
    writeFileSync(state, JSON.stringify({ lastBytes: 0 }), "utf8");
    writeFileSync(transcript, "due transcript bytes", "utf8");
    const python = successfulTrace(home);

    const invoke = (event: string) => spawnSync(process.execPath, [HOOK, "--runtime", "claude"], {
      input: JSON.stringify({ hook_event_name: event, transcript_path: transcript }),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENRIG_HOME: home,
        OPENRIG_SESSION_NAME: "seat@test",
        OPENRIG_REFOCUS_BYTES: "1",
        OPENRIG_REFOCUS_CONTENT_REF: undefined,
        OPENRIG_REFOCUS_CONTENT_FILE: undefined,
        OPENRIG_REFOCUS_TREES: "work",
        OPENRIG_WORKSPACE_ROOT: home,
        OPENRIG_REFOCUS_WORK_NODE: home,
        PYTHON: python,
      },
    });

    const stop = invoke("Stop");
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe("");
    expect(existsSync(state)).toBe(true);
    expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({
      lastBytes: 0,
      pendingOn: "Stop",
    });

    const delivered = invoke("UserPromptSubmit");
    expect(delivered.status).toBe(0);
    expect(JSON.parse(delivered.stdout).hookSpecificOutput.additionalContext).toContain("REFOCUS (");
    expect(delivered.stdout).not.toContain("TRACE GAP");
    const deliveredState = JSON.parse(readFileSync(state, "utf8"));
    expect(deliveredState).toMatchObject({
      lastBytes: Buffer.byteLength("due transcript bytes"),
      firedOn: "UserPromptSubmit",
    });
    expect(deliveredState).not.toHaveProperty("pendingOn");

    const repeat = invoke("UserPromptSubmit");
    expect(repeat.status).toBe(0);
    expect(repeat.stdout).toBe("");
  });

  it("retains PostCompact due-state without invalid output, then delivers it at the next prompt", () => {
    root = mkdtempSync(join(tmpdir(), "refocus-postcompact-state-"));
    const home = join(root, "home");
    const state = join(home, "refocus", "seat@test__postcompact-occupant.json");
    mkdirSync(home, { recursive: true });
    const python = successfulTrace(home);
    const invoke = (event: string) => spawnSync(process.execPath, [HOOK, "--runtime", "codex"], {
      input: JSON.stringify({ hook_event_name: event, session_id: "postcompact-occupant", transcript_path: "" }),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENRIG_HOME: home,
        OPENRIG_SESSION_NAME: "seat@test",
        OPENRIG_REFOCUS_NOW: undefined,
        OPENRIG_REFOCUS_TREES: "work",
        OPENRIG_WORKSPACE_ROOT: home,
        OPENRIG_REFOCUS_WORK_NODE: home,
        OPENRIG_REFOCUS_CONTENT_REF: undefined,
        OPENRIG_REFOCUS_CONTENT_FILE: undefined,
        PYTHON: python,
      },
    });

    const observed = invoke("PostCompact");
    expect(observed.status).toBe(0);
    expect(observed.stdout).toBe("");
    expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ pendingOn: "PostCompact" });

    const delivered = invoke("UserPromptSubmit");
    expect(delivered.status).toBe(0);
    expect(JSON.parse(delivered.stdout).hookSpecificOutput.additionalContext).toContain("just compacted");
    expect(delivered.stdout).not.toContain("TRACE GAP");
    expect(JSON.parse(readFileSync(state, "utf8"))).not.toHaveProperty("pendingOn");
  });
});

describe("openrig-core refocus hook — current-work binding (OPR.0.5.8.14)", () => {
  const whoami = (currentWork: unknown) => JSON.stringify({ currentWork });

  // Every case here unsets the work-node env var, because the harness default sets it and
  // the whole repair only applies when a live seat carries no such variable.
  const derive = (options: { whoamiStdout?: string; whoamiStatus?: number; workNode?: string }) =>
    runHook({
      capturePython: true,
      whoamiStdout: options.whoamiStdout,
      whoamiStatus: options.whoamiStatus,
      extraEnv: { OPENRIG_REFOCUS_WORK_NODE: options.workNode },
    });

  it("passes the derived work node as --work-start when exactly one typed baton resolves", () => {
    const result = derive({
      whoamiStdout: whoami({
        mission: "release-0.5.8",
        slice: "OPR.0.5.8.14",
        workNodePath: "/w/missions/release-0.5.8/slices/14-refocus-current-work-binding",
        basis: "one typed in-progress row",
      }),
    });

    expect(result.rigVerbs()).toContain("queue whoami");
    expect(result.traceArgv()).toContain(
      "--work-start /w/missions/release-0.5.8/slices/14-refocus-current-work-binding",
    );
  });

  it("follows a switched baton with no residue from the previous one", () => {
    const first = derive({
      whoamiStdout: whoami({
        mission: "release-0.5.8",
        slice: "OPR.0.5.8.14",
        workNodePath: "/w/slices/14-refocus-current-work-binding",
        basis: "one typed in-progress row",
      }),
    });
    expect(first.traceArgv()).toContain("--work-start /w/slices/14-refocus-current-work-binding");

    const second = derive({
      whoamiStdout: whoami({
        mission: "release-0.5.8",
        slice: "OPR.0.5.8.9",
        workNodePath: "/w/slices/09-single-topology-creation-ingress",
        basis: "one typed in-progress row",
      }),
    });
    expect(second.traceArgv()).toContain("--work-start /w/slices/09-single-topology-creation-ingress");
    expect(second.traceArgv()).not.toContain("14-refocus-current-work-binding");
  });

  it("consults the daemon and still refuses to guess when no typed work exists", () => {
    const result = derive({ whoamiStdout: whoami(null) });

    // The consult is the RED half: today the hook never asks. Declining to pass a path is
    // only meaningful once we can prove the answer was sought and then honestly refused.
    expect(result.rigVerbs()).toContain("queue whoami");
    expect(result.traceArgv()).not.toContain("--work-start");
  });

  it("consults the daemon and still refuses to guess when two typed batons are held", () => {
    const result = derive({ whoamiStdout: whoami(null) });

    expect(result.rigVerbs()).toContain("queue whoami");
    expect(result.traceArgv()).not.toContain("--work-start");
  });

  it("lets an explicit work-node env var win without consulting the daemon at all", () => {
    const result = derive({
      workNode: "/explicit/override",
      whoamiStdout: whoami({
        mission: "release-0.5.8",
        slice: "OPR.0.5.8.14",
        workNodePath: "/derived/should-not-win",
        basis: "one typed in-progress row",
      }),
    });

    expect(result.traceArgv()).toContain("--work-start /explicit/override");
    expect(result.traceArgv()).not.toContain("/derived/should-not-win");
    expect(result.rigVerbs()).not.toContain("queue whoami");
  });

  it("falls through to today's behaviour when the whoami consult fails", () => {
    const result = derive({ whoamiStdout: "not json at all", whoamiStatus: 1 });

    expect(result.status).toBe(0);
    expect(result.rigVerbs()).toContain("queue whoami");
    expect(result.traceArgv()).not.toContain("--work-start");
  });

  // The daemon always sends currentWorkBasis next to currentWork; these use that real shape.
  const answer = (currentWork: unknown, currentWorkBasis?: string) =>
    JSON.stringify({ currentWork, currentWorkBasis });

  it("passes only --work-start when a work node resolves, even though a basis is always present", () => {
    const result = derive({
      whoamiStdout: answer({ workNodePath: "/w/slices/14-refocus", basis: "one typed in-progress row" }, "one typed in-progress row"),
    });
    expect(result.traceArgv()).toContain("--work-start /w/slices/14-refocus");
    expect(result.traceArgv()).not.toContain("--work-basis");
    expect(result.traceArgv()).not.toContain("--work-unknown");
  });

  it("passes the daemon's basis as --work-basis when it names no single work node", () => {
    for (const basis of [NO_BATON, AMBIGUOUS]) {
      const result = derive({ whoamiStdout: answer(null, basis) });
      expect(result.rigVerbs()).toContain("queue whoami");
      expect(result.traceArgv()).toContain(`--work-basis ${basis}`);
      expect(result.traceArgv()).not.toContain("--work-start");
      expect(result.traceArgv()).not.toContain("--work-unknown");
    }
  });

  it("passes a failed or unreadable whoami as --work-unknown, never as a basis", () => {
    const cases = [
      { whoamiStdout: "", whoamiStatus: 1, reason: "queue whoami exited 1 with no answer" },
      { whoamiStdout: "not json at all", reason: "queue whoami answer was not JSON" },
      { whoamiStdout: answer(null), reason: "queue whoami named no current work and no basis" },
    ];
    for (const { reason, ...options } of cases) {
      const result = derive(options);
      expect(result.status).toBe(0);
      expect(result.traceArgv()).toContain(`--work-unknown ${reason}`);
      expect(result.traceArgv()).not.toContain("--work-start");
      expect(result.traceArgv()).not.toContain("--work-basis");
    }
  });

  it("delivers the work-root fallback through the real trace when the daemon reports no baton", () => {
    const result = runHook({
      whoamiStdout: answer(null, NO_BATON),
      extraEnv: { OPENRIG_REFOCUS_WORK_NODE: undefined },
    });
    const context = result.payload?.hookSpecificOutput.additionalContext || "";
    expect(result.status).toBe(0);
    expect(context).toContain(`FALLBACK — no current typed baton (${NO_BATON})`);
    expect(context).not.toContain("current work node is unresolved");
  });
});
