import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
const PLUGIN = resolve(HERE, "../assets/plugins/openrig-core");
const CLAUDE_HOOKS = resolve(PLUGIN, "hooks/claude.json");
const CODEX_HOOKS = resolve(PLUGIN, "hooks/codex.json");
const TRACE = resolve(PLUGIN, "skills/refocusing/scripts/trace-to-root.py");
const REFOCUS_MD = resolve(PLUGIN, "skills/refocusing/references/refocus.md");
const LEGACY_COMPOSE = resolve(PLUGIN, "skills/openrig-operating-model/scripts/compose.py");
const REF = "packs/r5-contributing-knowledge-20260824";

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
}) {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "refocus-context-ref-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const argvCapture = join(root, "rig-argv.json");
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
  writeFileSync(rig, `#!/bin/sh
printf '["%s","%s","%s"]' "$1" "$2" "$3" > "$RIG_ARGV_CAPTURE"
printf '%s' "$RIG_STDOUT"
printf '%s' "$RIG_STDERR" >&2
exit "\${RIG_STATUS:-0}"
`, "utf8");
  chmodSync(rig, 0o755);

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
    RIG_STDOUT: options.rigStdout,
    RIG_STDERR: options.rigStderr,
    RIG_STATUS: options.rigStatus === undefined ? undefined : String(options.rigStatus),
    OPENRIG_REFOCUS_NOW: "1",
    OPENRIG_REFOCUS_TREES: "work",
    OPENRIG_WORKSPACE_ROOT: home,
    OPENRIG_REFOCUS_WORK_NODE: home,
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
    writeFileSync(rig, `#!/bin/sh
if [ "$1 $2 $3" = "config get topology.root" ]; then printf '%s\\n' "$OPENRIG_TEST_TOPOLOGY_ROOT"; exit 0; fi
if [ "$1 $2 $3" = "config get workspace.root" ]; then printf '%s\\n' "$OPENRIG_TEST_WORKSPACE_ROOT"; exit 0; fi
if [ "$1 $2" = "scope resolve-notes" ]; then
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
    };
    return { topology, workspace, topologyStart, workStart, env };
  }

  function trace(args: string[], env: NodeJS.ProcessEnv) {
    return spawnSync("python3", [TRACE, ...args], { encoding: "utf8", env });
  }

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

  it("has one public refocus trace implementation and marks the old composer superseded for this use", () => {
    expect(existsSync(TRACE)).toBe(true);
    const skill = readFileSync(resolve(PLUGIN, "skills/refocusing/SKILL.md"), "utf8");
    expect(skill).toContain("trace-to-root.py");
    expect(readFileSync(LEGACY_COMPOSE, "utf8")).toMatch(/SUPERSEDED FOR REFOCUS/i);

    const publicText = [skill, readFileSync(REFOCUS_MD, "utf8"), readFileSync(TRACE, "utf8")].join("\n");
    expect(publicText).not.toMatch(/\/(?:Users|home|private|var|opt)\//);
    expect(publicText).not.toMatch(/v-openrig-build|release-0\.5\.5|qitem-/i);
  });
});

describe("openrig-core refocus hook — delivery state", () => {
  it("retains due state at Stop, then consumes one context-visible delivery", () => {
    root = mkdtempSync(join(tmpdir(), "refocus-delivery-state-"));
    const home = join(root, "home");
    const transcript = join(root, "transcript.jsonl");
    const state = join(home, "refocus", "seat@test__transcript.json");
    mkdirSync(join(home, "refocus"), { recursive: true });
    writeFileSync(state, JSON.stringify({ lastBytes: 0 }), "utf8");
    writeFileSync(transcript, "due transcript bytes", "utf8");

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
      },
    });

    const observed = invoke("PostCompact");
    expect(observed.status).toBe(0);
    expect(observed.stdout).toBe("");
    expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ pendingOn: "PostCompact" });

    const delivered = invoke("UserPromptSubmit");
    expect(delivered.status).toBe(0);
    expect(JSON.parse(delivered.stdout).hookSpecificOutput.additionalContext).toContain("just compacted");
    expect(JSON.parse(readFileSync(state, "utf8"))).not.toHaveProperty("pendingOn");
  });
});
