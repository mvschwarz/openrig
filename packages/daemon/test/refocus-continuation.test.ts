import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
const boundary = "OpenRig post-compaction turn boundary. Please acknowledge this message briefly. Do not restore yet; the next normal user message will contain the restore instructions.";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(nodeRig = false, runtime = "claude") {
  const root = mkdtempSync(join(tmpdir(), "refocus-continuation-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const trace = join(bin, "trace");
  const rig = join(bin, "rig");
  const calls = join(root, "calls");
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, "x".repeat(100));
  writeFileSync(trace, '#!/bin/sh\nprintf "%s" "$TRACE_RESULT"\nprintf "%s" "$TRACE_STDERR" >&2\nexit "${TRACE_STATUS:-0}"\n');
  writeFileSync(rig, nodeRig ? `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "stream" && args[1] === "emit") {
  require("node:fs").appendFileSync(process.env.CALLS, args.join(" ") + "\\n");
  process.exit(Number(process.env.STREAM_EXIT || 0));
}
process.stdout.write("{}");
` : '#!/bin/sh\nif [ "$1 $2" = "stream emit" ]; then\n printf "%s\\n" "$*" >> "$CALLS"\n exit "${STREAM_EXIT:-0}"\nfi\nprintf "{}"\n');
  chmodSync(trace, 0o755);
  chmodSync(rig, 0o755);
  const run = (event: string | { hook_event_name: string; omp_prepare?: boolean; omp_delivery_id?: string },
    prompt = "continue", good = true, extra: NodeJS.ProcessEnv = {}, identity = "occupant", timeout = 10_000) => {
    const result = spawnSync(process.execPath, [hook, "--runtime", runtime], {
      input: JSON.stringify({ ...(typeof event === "string" ? { hook_event_name: event } : event),
        session_id: identity, prompt, transcript_path: transcript }),
      encoding: "utf8", timeout, killSignal: "SIGKILL",
      env: { ...process.env, PATH: nodeRig ? bin : `${bin}:${process.env.PATH}`, OPENRIG_HOME: root,
        OPENRIG_SESSION_NAME: "seat@test", OPENRIG_REFOCUS_ENABLED: "1", OPENRIG_REFOCUS_NOW: "",
        OPENRIG_REFOCUS_CONTENT_REF: "", OPENRIG_REFOCUS_CONTENT_FILE: "", OPENRIG_REFOCUS_TREES: "work",
        OPENRIG_REFOCUS_WORK_NODE: root, OPENRIG_WORKSPACE_ROOT: root,
        PYTHON: trace, TRACE_RESULT: good ? "WORK TRACE: current intent" : "TRACE GAP — fixture resolver unavailable",
        TRACE_STATUS: good ? "0" : "1", CALLS: calls, ...extra },
    });
    expect(result.status, result.error?.message || result.stderr).toBe(0);
    return result.stdout;
  };
  const stateFile = join(root, "refocus", "seat@test__occupant.json");
  return { root, run, transcript, stateFile, calls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    state: () => JSON.parse(readFileSync(stateFile, "utf8")) };
}

describe("refocus continuation", () => {
  it("keeps OMP context pending through discarded preparations, then completes it once for its occupant and revision", () => {
    const f = fixture(false, "omp");
    const prepare = { hook_event_name: "UserPromptSubmit", omp_prepare: true };
    const accepted = (id: string) => ({ hook_event_name: "OmpRefocusAccepted", omp_delivery_id: id });
    f.run("PostCompact");
    const { ompRevision: first, ompComplete } = JSON.parse(f.run(prepare));
    expect(first).toEqual(expect.any(String));
    expect(ompComplete).toBe(true);
    expect(f.state()).toMatchObject({ pendingRevision: first, pendingOn: "PostCompact" });
    expect(f.state().firedAt).toBeUndefined();
    expect(JSON.parse(f.run(prepare)).ompRevision).toBe(first);
    f.run(accepted(first), "", true, {}, "another-occupant");
    expect(f.state().pendingRevision).toBe(first);
    expect(existsSync(join(f.root, "refocus", "seat@test__another-occupant.json"))).toBe(false);
    f.run("PostCompact");
    const { ompRevision: next } = JSON.parse(f.run(prepare));
    expect(next).toEqual(expect.any(String));
    expect(next).not.toBe(first);
    f.run(accepted(first));
    expect(f.state().pendingRevision).toBe(next);
    f.run(accepted(next));
    expect(f.state().pendingRevision).toBeUndefined();
    expect(f.state().firedOn).toBe("UserPromptSubmit");
    const settled = f.state();
    f.run(accepted(next));
    expect(f.state()).toEqual(settled);
    expect(f.run(prepare)).toBe("");
  });
  it("adopts legacy pending OMP state and retries an acknowledgement blocked by a concurrent writer", () => {
    const f = fixture(false, "omp");
    mkdirSync(join(f.root, "refocus"));
    writeFileSync(f.stateFile, JSON.stringify({ lastBytes: 100, pendingOn: "PostCompact" }));
    const prepare = { hook_event_name: "UserPromptSubmit", omp_prepare: true };
    const { ompRevision } = JSON.parse(f.run(prepare));
    expect(ompRevision).toEqual(expect.any(String));
    const accept = { hook_event_name: "OmpRefocusAccepted", omp_delivery_id: ompRevision };
    const guard = f.stateFile + ".guard";
    symlinkSync(process.pid + "-" + randomUUID(), guard);
    f.run(accept);
    expect(f.state().pendingRevision).toBe(ompRevision);
    unlinkSync(guard);
    f.run(accept);
    expect(f.run(prepare)).toBe("");
  });
  it("retries an on-demand OMP context after cancellation or a failed render", () => {
    const f = fixture(false, "omp");
    const prepare = { hook_event_name: "UserPromptSubmit", omp_prepare: true };
    const failed = JSON.parse(f.run(prepare, "", false, { OPENRIG_REFOCUS_NOW: "1" }));
    expect(failed.ompComplete).toBe(false);
    const revision = f.state().pendingRevision;
    expect(revision).toEqual(expect.any(String));
    writeFileSync(f.transcript, "smaller");
    const retry = JSON.parse(f.run(prepare));
    expect(retry.ompRevision).toBe(revision);
    expect(retry.ompComplete).toBe(true);
    expect(retry.hookSpecificOutput.additionalContext).toContain("on demand");
    f.run({ hook_event_name: "OmpRefocusAccepted", omp_delivery_id: revision });
    expect(f.run(prepare)).toBe("");
  });
  it.each(["omp", "codex"])("the %s hook ignores growth thresholds and does not unwrap Claude pasted content", (runtime) => {
    const f = fixture(false, runtime);
    expect(f.run("UserPromptSubmit")).toBe("");
    writeFileSync(f.transcript, "x".repeat(2_048));
    expect(f.run("UserPromptSubmit", "continue", true, { OPENRIG_REFOCUS_BYTES: "1000" })).toBe("");
    expect(f.run("PostCompact")).toBe("");
    expect(f.run("UserPromptSubmit", `<pasted_content id="fixture">${boundary}</pasted_content id="fixture">`)).toContain("just compacted");
    expect(f.state().pendingOn).toBeUndefined();
    expect(f.run("UserPromptSubmit")).toBe("");
  });
  it.each(["missing close", "trailing text"])("finishes a long pasted prompt with %s within the parsing bound", (ending) => {
    const f = fixture();
    const prompt = `<pasted_content id="fixture">${" ".repeat(64_000)}tail`
      + (ending === "trailing text" ? '</pasted_content id="fixture"> extra' : "");
    const started = Date.now();
    // A separate process deadline stops even a synchronous parser regression.
    expect(f.run("UserPromptSubmit", prompt, true, {}, "occupant", 2_000)).toBe("");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(f.state().lastBytes).toBe(100);
  }, 5_000);
  it("leaves PostCompact due through repeated acknowledgement turns, then delivers once on restore", () => {
    const f = fixture();
    expect(f.run("PostCompact")).toBe("");
    const before = f.state();
    expect(f.run("UserPromptSubmit", boundary)).toBe("");
    expect(f.run("UserPromptSubmit", boundary)).toBe("");
    expect(f.state()).toEqual(before);
    expect(f.run("UserPromptSubmit", "Restore this session now")).toContain("just compacted");
    expect(f.state().pendingOn).toBeUndefined();
    expect(f.run("UserPromptSubmit")).toBe("");
  });

  it("preserves the exact PostCompact obligation if its transcript shrinks before restore", () => {
    const f = fixture();
    f.run("PostCompact");
    writeFileSync(f.transcript, "short");
    expect(f.run("UserPromptSubmit", boundary)).toBe("");
    expect(f.run("UserPromptSubmit", "Restore now")).toContain("just compacted");
    expect(f.state().lastBytes).toBe(5);
    expect(f.state().pendingOn).toBeUndefined();
  });

  it.each([false, true])("reports the third failure and resets after delivery (env-node CLI without Node on PATH=%s)", nodeRig => {
    const f = fixture(nodeRig);
    f.run("PostCompact");
    for (let i = 0; i < 2; i++) f.run("UserPromptSubmit", "continue", false);
    expect(f.calls()).toEqual([]);
    expect(f.state().firedAt).toBeUndefined();
    expect(f.state().pendingOn).toBe("PostCompact");
    f.run("UserPromptSubmit", "continue", false);
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0]).toContain("--hint-tags issue,refocus");
    f.run("UserPromptSubmit", "continue", false);
    expect(f.calls()).toHaveLength(1);
    f.run("UserPromptSubmit");
    expect(f.state().pendingOn).toBeUndefined();
    f.run("PostCompact");
    for (let i = 0; i < 3; i++) f.run("UserPromptSubmit", "continue", false);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0].match(/--id (\S+)/)?.[1]).not.toBe(f.calls()[1].match(/--id (\S+)/)?.[1]);
  });

  it("labels a retried post-compaction refocus as a retry with the failure, and a new compaction as fresh", () => {
    const f = fixture();
    f.run("PostCompact");
    expect(f.run("UserPromptSubmit", "continue", false)).toContain("REFOCUS (just compacted — your picture is lossy)");
    expect(f.state().pendingOn).toBe("PostCompact");

    const retry = f.run("UserPromptSubmit");
    expect(retry).toContain("REFOCUS (retrying the post-compaction refocus; the last attempt failed: trace gap: trace exited 1)");
    expect(retry).not.toContain("just compacted");
    expect(f.state().pendingOn).toBeUndefined();
    expect(f.state().pendingFailure).toBeUndefined();

    f.run("PostCompact");
    f.run("UserPromptSubmit", "continue", false);
    f.run("PostCompact");
    expect(f.state().pendingFailure).toBeUndefined();
    expect(f.run("UserPromptSubmit")).toContain("REFOCUS (just compacted — your picture is lossy)");
  });

  it("caps a long failure reason in the retry label; the failed attempt's trace gap keeps it whole", () => {
    const f = fixture();
    const stderr = `Traceback: ${"frame ".repeat(200)}end`;
    f.run("PostCompact");
    expect(f.run("UserPromptSubmit", "continue", false, { TRACE_STDERR: stderr })).toContain(`TRACE GAP — ${stderr.trim()}`);
    const saved = f.state().pendingFailure as string;
    expect(saved).toHaveLength(300);
    expect(saved).toBe(`${`trace gap: ${stderr}`.slice(0, 299)}…`);
    expect(f.run("UserPromptSubmit")).toContain(`REFOCUS (retrying the post-compaction refocus; the last attempt failed: ${saved})`);
  });

  it("retries an unconfirmed stream write under the same id and isolates occupants", () => {
    const f = fixture();
    f.run("PostCompact");
    for (let i = 0; i < 3; i++) f.run("UserPromptSubmit", "continue", false, { STREAM_EXIT: "1" });
    f.run("UserPromptSubmit", "continue", false);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0].match(/--id (\S+)/)?.[1]).toBe(f.calls()[1].match(/--id (\S+)/)?.[1]);
    f.run("PostCompact", "continue", true, {}, "other-occupant");
    f.run("UserPromptSubmit", "continue", false, {}, "other-occupant");
    expect(f.calls()).toHaveLength(2);
    expect(readdirSync(join(f.root, "refocus")).filter((name) => name.endsWith(".health.json"))).toHaveLength(2);
  });
});
