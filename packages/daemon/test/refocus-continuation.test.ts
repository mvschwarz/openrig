import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
const boundary = "OpenRig post-compaction turn boundary. Please acknowledge this message briefly. Do not restore yet; the next normal user message will contain the restore instructions.";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "refocus-continuation-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const trace = join(bin, "trace");
  const rig = join(bin, "rig");
  const calls = join(root, "calls");
  writeFileSync(trace, '#!/bin/sh\nprintf "%s" "$TRACE_RESULT"\n');
  writeFileSync(rig, '#!/bin/sh\nif [ "$1 $2" = "stream emit" ]; then\n printf "%s\\n" "$*" >> "$CALLS"\n exit "${STREAM_EXIT:-0}"\nfi\nprintf "{}"\n');
  chmodSync(trace, 0o755);
  chmodSync(rig, 0o755);
  const run = (event: string, prompt = "continue", good = true, extra: NodeJS.ProcessEnv = {}, identity = "occupant") => {
    const result = spawnSync(process.execPath, [hook, "--runtime", "claude"], {
      input: JSON.stringify({ hook_event_name: event, session_id: identity, prompt }),
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENRIG_HOME: root,
        OPENRIG_SESSION_NAME: "seat@test", OPENRIG_REFOCUS_ENABLED: "1", OPENRIG_REFOCUS_NOW: "",
        OPENRIG_REFOCUS_CONTENT_REF: "", OPENRIG_REFOCUS_CONTENT_FILE: "", OPENRIG_REFOCUS_TREES: "work",
        OPENRIG_REFOCUS_WORK_NODE: root, OPENRIG_WORKSPACE_ROOT: root,
        PYTHON: trace, TRACE_RESULT: good ? "WORK TRACE: current intent" : "TRACE GAP — fixture resolver unavailable",
        CALLS: calls, ...extra },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  return { root, run, calls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    state: () => JSON.parse(readFileSync(join(root, "refocus", "seat@test__occupant.json"), "utf8")) };
}

describe("refocus continuation", () => {
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

  it("reports only the third failed attempt, retains due state, and resets on a successful delivery", () => {
    const f = fixture();
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
