import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { buildCompactCommand, buildPostCompactRestorePrompt, buildPostCompactTurnBoundaryPrompt } from "../src/domain/claude-compaction-enforcer.js";
import { createDaemon } from "../src/startup.js";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";

const plugin = resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const hook = join(plugin, "hooks/scripts/refocus.cjs");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(os.tmpdir(), "refocus-managed-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls");
  const rig = join(bin, "rig");
  writeFileSync(rig, `#!/bin/sh
if [ "$1 $2" = "scope resolve-notes" ]; then
  if [ "$FAIL_NOTES" = 1 ]; then printf 'resolver unavailable' >&2; exit 1; fi
  printf '%s' "$NOTES_RESULT"; exit 0
fi
if [ "$1 $2" = "stream emit" ]; then sleep "\${STREAM_DELAY:-0}"; printf '%s\\n' "$*" >> "$CALLS"; exit 0; fi
printf '{}'
`);
  chmodSync(rig, 0o755);
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ sessionId: "occupant", cwd: root, message: { role: "user", content: "Continue the fixture." } }) + "\n");
  writeFileSync(join(root, "SPEC.md"), "---\nintent: Complete the selected work\n---\n");
  const notes = join(root, "NOTES.md");
  writeFileSync(notes, "Ordinary notes.\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, OPENRIG_HOME: root,
    CLAUDE_CONFIG_DIR: join(root, ".claude"), OPENRIG_COMPACTION_OUT_ROOT: join(root, "packets"),
    PATH: `${bin}:${process.env.PATH}`, OPENRIG_SESSION_NAME: "seat@test", RIGGED_HOME: undefined,
    OPENRIG_REFOCUS_ENABLED: "1", OPENRIG_REFOCUS_NOW: "", OPENRIG_REFOCUS_BYTES: "2600000",
    OPENRIG_REFOCUS_CONTENT_REF: "", OPENRIG_REFOCUS_CONTENT_FILE: "", OPENRIG_REFOCUS_TREES: "work",
    OPENRIG_WORKSPACE_ROOT: root, OPENRIG_REFOCUS_WORK_NODE: root, OPENRIG_REFOCUS_DEPTH: "light",
    PYTHON: "python3", CALLS: calls, NOTES_RESULT: JSON.stringify({ ok: true, resolution: { path: notes, name: "NOTES.md" } }),
  };
  const invoke = (script: string, input: object, extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ session_id: "occupant", transcript_path: transcript, cwd: root, ...input }),
      env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  let compactEvent = 0;
  return { root, env, notes, transcript,
    run: (event: string, prompt = "continue", extra: NodeJS.ProcessEnv = {}) => invoke(hook, {
      hook_event_name: event, prompt, ...(event === "PostCompact" ? { event_id: `compact-${++compactEvent}` } : {}),
    }, extra),
    prepare: (managed: boolean) => invoke(join(plugin, "skills/claude-compaction-restore/scripts/precompact-hook.mjs"), {
      hook_event_name: "PreCompact", trigger: "manual",
      custom_instructions: managed ? buildCompactCommand("").slice("/compact ".length) : null,
    }),
    state: () => JSON.parse(readFileSync(join(root, "refocus/seat@test__occupant.json"), "utf8")),
    setState: (state: object) => writeFileSync(join(root, "refocus/seat@test__occupant.json"), JSON.stringify(state)),
    calls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
  };
}

describe("managed refocus and trace results", () => {
  it("holds peer messages before and after the boundary until the real restore request", () => {
    const f = fixture();
    f.prepare(true);
    f.run("PostCompact");
    const before = f.state();
    for (const prompt of ["From: peer@test\nThe build is done.", `  ${buildPostCompactTurnBoundaryPrompt()}\n`, "Another peer update."]) {
      expect(f.run("UserPromptSubmit", prompt)).toBe("");
      expect(f.state()).toEqual(before);
    }
    const restore = buildPostCompactRestorePrompt({ sessionName: "seat@test", openrigHome: f.root });
    expect(f.run("UserPromptSubmit", restore)).toContain("just compacted");
    expect(f.state().pendingOn).toBeUndefined();
    expect(f.run("UserPromptSubmit")).toBe("");
    expect(f.calls()).toEqual([]);
  });

  it("manual compaction replaces a managed marker and delivers on the next prompt", () => {
    const f = fixture();
    f.prepare(true);
    f.prepare(false);
    f.run("PostCompact");
    expect(f.run("UserPromptSubmit")).toContain("just compacted");
    expect(f.state().pendingOn).toBeUndefined();
  });

  it("delivers on the next ordinary prompt after ten minutes without a restore request", () => {
    const f = fixture();
    f.prepare(true);
    const armedAfter = Date.now();
    f.run("PostCompact");
    const armedAt = f.state().managedRestorePendingAt;
    f.setState({ ...f.state(), managedRestorePendingAt: new Date(Date.now() - 9 * 60_000).toISOString() });
    expect(f.run("UserPromptSubmit", "A peer arrived before restore.")).toBe("");
    f.setState({ ...f.state(), managedRestorePendingAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    expect(f.run("UserPromptSubmit", buildPostCompactTurnBoundaryPrompt())).toBe("");
    expect(f.run("UserPromptSubmit", "Continue after restarting the daemon.")).toContain("just compacted");
    expect(Date.parse(armedAt)).toBeGreaterThanOrEqual(armedAfter);
    expect(f.state().managedRestorePending).toBeUndefined();
    expect(f.state().managedRestorePendingAt).toBeUndefined();
    expect(f.state().pendingOn).toBeUndefined();
    expect(f.run("UserPromptSubmit")).toBe("");
    expect(f.calls()).toEqual([]);
  });

  it.each([undefined, "invalid", "2999-01-01T00:00:00.000Z"])("does not strand a managed hold with an unusable timestamp: %s", (timestamp) => {
    const f = fixture();
    f.prepare(true);
    f.run("PostCompact");
    f.setState({ ...f.state(), managedRestorePendingAt: timestamp });
    expect(f.run("UserPromptSubmit")).toContain("just compacted");
    expect(f.state().managedRestorePending).toBeUndefined();
  });

  it("a new managed compaction rearms the hold and a manual compaction clears it", () => {
    const f = fixture();
    f.prepare(true);
    f.run("PostCompact");
    f.setState({ ...f.state(), managedRestorePendingAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    f.prepare(true);
    f.run("PostCompact");
    expect(f.run("UserPromptSubmit")).toBe("");
    f.prepare(false);
    f.run("PostCompact");
    expect(f.state().managedRestorePendingAt).toBeUndefined();
    expect(f.run("UserPromptSubmit")).toContain("just compacted");
  });

  it("does not inherit a managed restore marker from a different occupant", () => {
    const f = fixture();
    f.prepare(true);
    for (const suffix of [".json", ".expected.json"]) {
      const file = join(f.root, "compaction/restore-pending/seat@test" + suffix);
      const marker = JSON.parse(readFileSync(file, "utf8"));
      marker.sessionId = "retired-occupant";
      writeFileSync(file, JSON.stringify(marker));
    }
    f.run("PostCompact");
    expect(f.run("UserPromptSubmit")).toContain("just compacted");
  });

  it.each(["light", "full"])("consumes successful %s traces containing diagnostic words in authored text once", (depth) => {
    const f = fixture();
    if (depth === "light") writeFileSync(join(f.root, "SPEC.md"), "---\nintent: Eliminate TRACE GAP messages without losing context\n---\n");
    writeFileSync(f.notes, "NOTES RESOLUTION GAP — an exact diagnostic line discussed in authored notes.\n");
    f.run("PostCompact");
    const output = f.run("UserPromptSubmit", "continue", { OPENRIG_REFOCUS_DEPTH: depth });
    expect(output).toContain(depth === "light" ? "Eliminate TRACE GAP messages" : "an exact diagnostic line discussed in authored notes");
    expect(f.state().pendingOn).toBeUndefined();
    expect(f.state().firedAt).toBeTruthy();
    expect(f.run("UserPromptSubmit", "continue", { OPENRIG_REFOCUS_DEPTH: depth })).toBe("");
    expect(f.calls()).toEqual([]);
  });

  it("retains real resolver failures and resets the episode when the resolver recovers", () => {
    const f = fixture();
    f.run("PostCompact");
    for (let n = 0; n < 3; n++) expect(f.run("UserPromptSubmit", "continue", { FAIL_NOTES: "1" })).toContain("NOTES RESOLUTION GAP");
    expect(f.state().pendingOn).toBe("PostCompact");
    expect(f.calls()).toHaveLength(1);
    f.run("UserPromptSubmit");
    expect(f.state().pendingOn).toBeUndefined();
  });

  it("check mode reports actual resolution failure without changing standalone rendered output", () => {
    const f = fixture();
    const script = join(plugin, "skills/refocusing/scripts/trace-to-root.py");
    const run = (check: boolean) => spawnSync("python3", [script, "--trees", "work", ...(check ? ["--check"] : [])], {
      env: { ...f.env, FAIL_NOTES: "1" }, encoding: "utf8", timeout: 5_000,
    });
    const plain = run(false), checked = run(true);
    expect(plain.status).toBe(0);
    expect(checked.status).toBe(1);
    expect(checked.stdout).toBe(plain.stdout);
  });

  it("confirms a slow stream receipt within the remaining hook budget", () => {
    const f = fixture();
    f.run("PostCompact");
    for (let n = 0; n < 2; n++) f.run("UserPromptSubmit", "continue", { FAIL_NOTES: "1" });
    f.run("UserPromptSubmit", "continue", { FAIL_NOTES: "1", STREAM_DELAY: "0.8" });
    const dir = join(f.root, "refocus");
    const file = readdirSync(dir).find((name) => name.endsWith(".health.json"))!;
    expect(JSON.parse(readFileSync(join(dir, file), "utf8")).reportedAt).toBeTruthy();
    expect(f.calls()).toHaveLength(1);
  });

  it.each([false, true])("startup seeds a loadable bare refocusing skill for both harnesses (router seed fails: %s)", async (failRouterSeed) => {
    const f = fixture();
    vi.stubEnv("OPENRIG_HOME", f.root);
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    vi.spyOn(os, "homedir").mockReturnValue(f.root);
    vi.spyOn(PluginVendorService.prototype, "attemptAutoFetch").mockResolvedValue();
    if (failRouterSeed) {
      const original = PluginVendorService.prototype.ensureSkillGlobally;
      vi.spyOn(PluginVendorService.prototype, "ensureSkillGlobally").mockImplementation(function (this: PluginVendorService, ...args) {
        if (args[1] === "openrig-skills") throw new Error("injected router seed failure");
        return original.apply(this, args);
      });
    }
    const { db } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", cmuxFactory: async () => { throw new Error("inert fixture"); } });
    try {
      for (const harness of [".claude", ".agents"]) {
        const skill = join(f.root, harness, "skills/refocusing");
        expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
        const text = readFileSync(join(skill, "SKILL.md"), "utf8");
        expect(text).toContain("name: refocusing");
        expect(text).not.toContain("openrig-core:refocusing");
        expect(readFileSync(join(skill, "scripts/trace-to-root.py"), "utf8")).toBe(readFileSync(join(plugin, "skills/refocusing/scripts/trace-to-root.py"), "utf8"));
      }
    } finally { db.close(); }
  });
});
