// Refocus: the hook's time budget, its failure report, and overlapping events for one occupant.
// Each case runs the real hook as a harness does (JSON on stdin, killed at the registration's outer bound), with a stub
// `rig` and a stub trace script whose delays are set per case. The overlaps are hook processes overlapping; whether a
// harness overlaps these events natively is not established here.
import { describe, expect, it, vi, type TestContext } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, "../assets/plugins/openrig-core");
const HOOK = join(PLUGIN, "hooks/scripts/refocus.cjs");
const SEAT = "dev-impl@budget-rig";

interface Fixture { root: string; home: string; bin: string; log: string }

/** Build isolated hook state and controllable lookup scripts for timing and overlap cases. */
function fixture(onTestFinished: TestContext["onTestFinished"]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "refocus-budget-"));
  // Bind cleanup to the owning test, including cases that construct two fixtures.
  onTestFinished(() => {
    // A case that made the state folder read-only may have timed out before putting it back.
    try { chmodSync(join(root, "openrig", "refocus"), 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, "openrig");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const sleep = (name: string) => `[ -n "$${name}" ] && sleep "$(awk -v m="$${name}" 'BEGIN{printf "%.3f", m/1000}')"`;
  // An issue report takes a moment to answer, as the daemon does, and is logged only once it has answered.
  writeFileSync(join(bin, "rig"), `#!/bin/sh
[ "$1" = stream ] || echo "rig $*" >> "${log}"
case "$1 $2" in
  "stream emit") sleep 0.2; echo "rig $*" >> "${log}"; echo '{}';;
  "queue whoami") ${sleep("STUB_WHOAMI_MS")}; echo '{"role":{"state":"no-record","files":[]},"currentWorkBasis":"none"}';;
  "config --json") echo '{}';;
  "context get") ${sleep("STUB_CONTEXT_MS")}; echo "CONFIGURED REFOCUS CONTENT";;
  *) echo '{}';;
esac
`);
  writeFileSync(join(bin, "trace"), `#!/bin/sh
[ -n "$STUB_TRACE_READY" ] && touch "$STUB_TRACE_READY"
if [ -n "$STUB_TRACE_RELEASE" ]; then
  while [ ! -f "$STUB_TRACE_RELEASE" ]; do sleep 0.02; done
fi
[ -n "$STUB_TRACE_PARTIAL" ] && echo "$STUB_TRACE_PARTIAL"
${sleep("STUB_TRACE_MS")}
echo "TRACE OK: work and topology"
`);
  chmodSync(join(bin, "rig"), 0o755);
  chmodSync(join(bin, "trace"), 0o755);
  return { root, home, bin, log };
}

interface Run { killed: boolean; ms: number; stdout: string; stderr: string }

// Run the hook as the harness does, killed at `outerMs` (both registrations' bound for refocus: 60 s).
function hook(f: Fixture, event: string, session: string, extra: Record<string, string> = {}, outerMs = 60_000, promptId?: string): Promise<Run> {
  const transcript = join(f.root, `${session}.jsonl`);
  if (!existsSync(transcript)) writeFileSync(transcript, "");
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn("node", [HOOK, "--runtime", "claude"], {
      env: {
        PATH: `${f.bin}:${process.env.PATH}`, HOME: f.root, OPENRIG_HOME: f.home, OPENRIG_SESSION_NAME: SEAT,
        PYTHON: join(f.bin, "trace"), OPENRIG_REFOCUS_WORK_NODE: f.home, OPENRIG_WORKSPACE_ROOT: f.home,
        OPENRIG_TOPOLOGY_ROOT: f.home, ...extra,
      },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, outerMs);
    child.on("close", () => { clearTimeout(timer); done({ killed, ms: Date.now() - started, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: session, transcript_path: transcript, prompt: "next", prompt_id: promptId }));
  });
}

const context = (r: Run): string => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "");
const stateOf = (f: Fixture, session: string) =>
  JSON.parse(readFileSync(join(f.home, "refocus", `${SEAT}__${session}.json`), "utf8")) as Record<string, unknown>;
const healthOf = (f: Fixture) => readdirSync(join(f.home, "refocus")).filter((n) => n.endsWith(".health.json"))
  .map((n) => JSON.parse(readFileSync(join(f.home, "refocus", n), "utf8")) as { failures?: number });

describe("refocus: the registrations' outer bound", () => {
  it("allows refocus.cjs 60 s on both harnesses and leaves every other hook at 5 s", () => {
    for (const file of ["claude.json", "codex.json"]) {
      const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", file), "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
      const entries = Object.values(hooks).flat().flatMap((g) => g.hooks);
      const refocus = entries.filter((h) => h.command.includes("refocus.cjs"));
      expect(refocus.length).toBeGreaterThan(0);
      for (const h of refocus) expect(h.timeout).toBe(60);
      for (const h of entries.filter((e) => !e.command.includes("refocus.cjs") && !e.command.includes("precompact-hook"))) expect(h.timeout).toBe(5);
    }
  });
});

// Each budget case owns its files and child processes. Overlap their real waits;
// attempts within a case and the overlapping-event scenarios below stay sequential.
describe.concurrent("refocus: the time budget", () => {
  it("delivers a slow but successful trace when a longer budget is selected", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_BUDGET_MS: "10000", STUB_TRACE_MS: "2500" });
    expect(r.killed).toBe(false);
    expect(context(r)).toContain("TRACE OK: work and topology");
    expect(context(r)).not.toContain("TRACE GAP");
    expect(stateOf(f, "s1")).toMatchObject({ firedOn: "UserPromptSubmit" });
    expect(stateOf(f, "s1")["pendingOn"]).toBeUndefined();
  }, 20_000);

  it("ends a trace that never finishes as a gap inside the selected budget, keeping the refocus due", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_BUDGET_MS: "10000", STUB_TRACE_MS: "30000" });
    expect(r.killed).toBe(false);
    expect(r.ms).toBeLessThan(10_000);
    expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 20_000);

  it("limits a selected budget to 52 s, so reporting and recording the outcome still end inside the 60 s bound", async ({ expect, onTestFinished }) => {
    // At 52 s the trace's cap is 23.1 s: a 23.5 s trace ends as a gap (at 55 s its cap would have been 24.4 s).
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_BUDGET_MS: "120000", STUB_TRACE_MS: "23500" });
    expect(r.killed).toBe(false);
    // The gap is what tells 52 s from 55 s; the time bound only checks the hook ended, with room for process start-up.
    expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    expect(r.ms).toBeLessThan(30_000);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 40_000);

  it("keeps today's 2 s trace cap when no budget is selected", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "2500" }, 5_000);
    expect(r.killed).toBe(false);
    expect(r.ms).toBeLessThan(3_500);
    expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 20_000);

  it("with no budget selected, gives main's result: each lookup keeps its 2 s cap, unclipped, inside the 60 s bound", async ({ expect, onTestFinished }) => {
    // Lookups each under their own 2 s cap (with room for a slow runner's process start-up) that together pass the 4.5 s lookup budget: on
    // main's 5 s registration this was killed; now it completes as main's code does.
    const f = fixture(onTestFinished);
    const slow = { STUB_WHOAMI_MS: "1550", STUB_TRACE_MS: "1550", STUB_CONTEXT_MS: "1550", OPENRIG_REFOCUS_CONTENT_REF: "refocus/team.md",
      OPENRIG_REFOCUS_WORK_NODE: "", OPENRIG_REFOCUS_TREES: "both" };
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", slow);
    expect(r.killed).toBe(false);
    expect(context(r)).toContain("TRACE OK: work and topology");
    expect(context(r)).toContain("CONFIGURED REFOCUS CONTENT");
    expect(stateOf(f, "s1")).toMatchObject({ firedOn: "UserPromptSubmit" });
    // A content-REF seat with a slow whoami gets main's full 2 s trace, not a shorter one (completes on main in ~2.9 s).
    const g = fixture(onTestFinished);
    await hook(g, "PostCompact", "s1");
    const ref = await hook(g, "UserPromptSubmit", "s1", { STUB_WHOAMI_MS: "1000", STUB_TRACE_MS: "1500", STUB_CONTEXT_MS: "300",
      OPENRIG_REFOCUS_CONTENT_REF: "refocus/team.md", OPENRIG_REFOCUS_WORK_NODE: "", OPENRIG_REFOCUS_TREES: "both" });
    expect(context(ref)).toContain("TRACE OK: work and topology");
    expect(context(ref)).not.toContain("TRACE GAP");
  }, 40_000);

  it("with no budget selected, still files the issue report after three slow failed attempts that ran past 4.5 s", async ({ expect, onTestFinished }) => {
    // Default lookups keep their fixed 2 s caps, so a failed default attempt can end around 6 s. Its report gets its
    // own window after that (the stub answers a report after 200 ms), so the third failure is reported and confirmed.
    const f = fixture(onTestFinished);
    const slow = { STUB_WHOAMI_MS: "1900", STUB_TRACE_MS: "2500", STUB_CONTEXT_MS: "1900", OPENRIG_REFOCUS_CONTENT_REF: "refocus/team.md",
      OPENRIG_REFOCUS_WORK_NODE: "", OPENRIG_REFOCUS_TREES: "both" };
    await hook(f, "PostCompact", "s1");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await hook(f, "UserPromptSubmit", "s1", slow);
      expect(r.killed).toBe(false);
      expect(r.ms).toBeGreaterThan(4_500);
      expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    }
    expect(healthOf(f)).toEqual([expect.objectContaining({ failures: 3, reportedAt: expect.any(String) })]);
    expect(readFileSync(f.log, "utf8").split("\n").filter((l) => l.startsWith("rig stream")).length).toBe(1);
  }, 60_000);

  it("with a budget selected, ends lookups that together pass it as a reported gap, and records the failure", async ({ expect, onTestFinished }) => {
    // A 4.6 s budget gives each lookup a ~2 s cap; three of them pass the budget, so the last is clipped.
    const f = fixture(onTestFinished);
    const slow = { OPENRIG_REFOCUS_BUDGET_MS: "4600", STUB_WHOAMI_MS: "1950", STUB_TRACE_MS: "1950", STUB_CONTEXT_MS: "1950",
      OPENRIG_REFOCUS_CONTENT_REF: "refocus/team.md", OPENRIG_REFOCUS_WORK_NODE: "", OPENRIG_REFOCUS_TREES: "both" };
    await hook(f, "PostCompact", "s1");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await hook(f, "UserPromptSubmit", "s1", slow);
      expect(r.killed).toBe(false);
      expect(context(r)).toContain("REFOCUS");
      expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    }
    // The third failure's issue report gets its own time after the budget, so it is made and confirmed.
    expect(healthOf(f)).toEqual([expect.objectContaining({ failures: 3, reportedAt: expect.any(String) })]);
    expect(readFileSync(f.log, "utf8").split("\n").filter((l) => l.startsWith("rig stream")).length).toBe(1);
  }, 60_000);
});

describe("refocus: overlapping events for one occupant", () => {
  it("preserves a PostCompact that lands while an earlier refocus is being delivered", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_NOW: "1" });
    const file = join(f.home, "refocus", `${SEAT}__s1.json`);
    writeFileSync(file, JSON.stringify({ ...stateOf(f, "s1"), pendingOn: "Stop", pendingAt: "2026-10-18T17:00:00.000Z" }));
    const ready = join(f.root, "trace-ready");
    const release = join(f.root, "trace-release");
    // Hold delivery after it has read the state; process start-up time cannot choose the interleaving.
    const delivering = hook(f, "UserPromptSubmit", "s1", {
      OPENRIG_REFOCUS_BUDGET_MS: "52000", STUB_TRACE_READY: ready, STUB_TRACE_RELEASE: release,
    }, 60_000, "prompt-1");
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10000 });
      await hook(f, "PostCompact", "s1");
      expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    } finally {
      writeFileSync(release, "");
    }
    expect(context(await delivering)).toContain("REFOCUS");
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    expect(context(await hook(f, "UserPromptSubmit", "s1", {}, 60_000, "prompt-1"))).toBe("");
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    expect(context(await hook(f, "UserPromptSubmit", "s1", {}, 60_000, "prompt-2"))).toContain("REFOCUS (just compacted");
    expect(stateOf(f, "s1")["pendingOn"]).toBeUndefined();
  }, 20_000);

  it("delivers a pending refocus once when two handlers overlap", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const ready = join(f.root, "trace-ready");
    const release = join(f.root, "trace-release");
    const first = hook(f, "UserPromptSubmit", "s1", {
      OPENRIG_REFOCUS_BUDGET_MS: "10000", STUB_TRACE_READY: ready, STUB_TRACE_RELEASE: release,
    }, 60_000, "prompt-A");
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
      const revision = stateOf(f, "s1").pendingRevision;
      const second = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_NOW: "1" }, 60_000, "prompt-A");
      expect(context(second)).toBe("");
      expect(second.stderr).toContain("another hook is delivering");
      expect(stateOf(f, "s1").pendingRevision).toBe(revision);
    } finally {
      writeFileSync(release, "");
      expect(context(await first)).toContain("REFOCUS");
    }
    expect(context(await hook(f, "UserPromptSubmit", "s1"))).toBe("");
  }, 20_000);

  it("retains a distinct identified on-demand prompt while an earlier prompt is rendering", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const ready = join(f.root, "trace-ready");
    const release = join(f.root, "trace-release");
    const first = hook(f, "UserPromptSubmit", "s1", {
      OPENRIG_REFOCUS_BUDGET_MS: "10000", STUB_TRACE_READY: ready, STUB_TRACE_RELEASE: release,
    }, 60_000, "prompt-A");
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
      const second = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_NOW: "1" }, 60_000, "prompt-B");
      expect(context(second)).toBe("");
    } finally {
      writeFileSync(release, "");
      expect(context(await first)).toContain("REFOCUS");
    }
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: expect.any(String) });
    expect(context(await hook(f, "UserPromptSubmit", "s1", {}, 60_000, "prompt-C"))).toContain("REFOCUS");
    expect(context(await hook(f, "UserPromptSubmit", "s1", {}, 60_000, "prompt-D"))).toBe("");
  }, 20_000);

  it("delivers once per identified prompt even if the second handler starts after completion", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    const env = { OPENRIG_REFOCUS_NOW: "1" };
    expect(context(await hook(f, "UserPromptSubmit", "s1", env, 60_000, "prompt-1"))).toContain("REFOCUS");
    expect(context(await hook(f, "UserPromptSubmit", "s1", env, 60_000, "prompt-1"))).toBe("");
    expect(context(await hook(f, "UserPromptSubmit", "s1", env, 60_000, "prompt-2"))).toContain("REFOCUS");
  });

  it("recovers pending work after the rendering hook is killed", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const ready = join(f.root, "trace-ready");
    const release = join(f.root, "trace-release");
    const interrupted = hook(f, "UserPromptSubmit", "s1", {
      OPENRIG_REFOCUS_BUDGET_MS: "10000", STUB_TRACE_READY: ready, STUB_TRACE_RELEASE: release,
    }, 1000);
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
      expect(await interrupted).toMatchObject({ killed: true, stdout: "" });
    } finally {
      writeFileSync(release, "");
    }
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact", deliveryClaim: { pid: expect.any(Number) } });
    const resumed = await hook(f, "UserPromptSubmit", "s1");
    expect(resumed.stderr).toContain("prior delivery owner could not be confirmed");
    expect(context(resumed)).toContain("REFOCUS (just compacted");
    expect(context(await hook(f, "UserPromptSubmit", "s1"))).toBe("");
  });

  it("uses a shared successor guard after its former owner exits", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const guard = join(f.home, "refocus", `${SEAT}__s1.json.guard`);
    const owner = spawnSync(process.execPath, ["-e", ""]).pid;
    const token = `${owner}-00000000-0000-4000-8000-000000000001`;
    symlinkSync(token, guard);
    const first = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "200" });
    const second = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "200" });
    const runs = await Promise.all([first, second]);
    expect(runs.filter((run) => context(run).includes("REFOCUS"))).toHaveLength(1);
    expect(readlinkSync(guard)).toBe(token);
  });

  it("does not take a successor when the old guard was released before the owner exited", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const stateFile = join(f.home, "refocus", `${SEAT}__s1.json`);
    const guard = stateFile + ".guard";
    const oldPid = spawnSync(process.execPath, ["-e", ""]).pid;
    symlinkSync(`${oldPid}-00000000-0000-4000-8000-000000000001`, guard);
    const liveToken = `${process.pid}-00000000-0000-4000-8000-000000000002`;
    const result = spawnSync(process.execPath, ["-e", `
      const fs = require("node:fs");
      const [helper, stateFile, liveToken, oldPid] = process.argv.slice(1);
      const kill = process.kill;
      process.kill = (pid, signal) => {
        if (pid === Number(oldPid)) {
          fs.unlinkSync(stateFile + ".guard");
          fs.symlinkSync(liveToken, stateFile + ".guard");
        }
        return kill(pid, signal);
      };
      const access = require(helper).openRefocusState(stateFile);
      console.log(access.exclusive);
      access.close();
    `, join(dirname(HOOK), "refocus-state.cjs"), stateFile, liveToken, String(oldPid)], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("false");
    expect(readlinkSync(guard)).toBe(liveToken);
  });

  it("reports an unreadable guard and leaves the pending compaction available", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "UserPromptSubmit", "s1");
    const guard = join(f.home, "refocus", `${SEAT}__s1.json.guard`);
    mkdirSync(guard);
    const compact = await hook(f, "PostCompact", "s1");
    expect(compact.stderr).toContain("could not coordinate state");
    const uncoordinated = await hook(f, "UserPromptSubmit", "s1");
    expect(uncoordinated.stderr).toContain("could not coordinate state");
    expect(context(uncoordinated)).toContain("REFOCUS (just compacted");
    rmSync(guard, { recursive: true });
    expect(context(await hook(f, "UserPromptSubmit", "s1"))).toContain("REFOCUS (just compacted");
    expect(context(await hook(f, "UserPromptSubmit", "s1"))).toBe("");
  });

  it("still delivers to each of two occupants of one seat when they overlap", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    await hook(f, "PostCompact", "s2");
    const runs = await Promise.all([
      hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "1000" }),
      hook(f, "UserPromptSubmit", "s2", { STUB_TRACE_MS: "1000" }),
    ]);
    expect(runs.map((r) => context(r).includes("REFOCUS"))).toEqual([true, true]);
  }, 20_000);
});

describe("refocus: state left by an earlier candidate", () => {
  it("ignores a delivery claim and pendingSeq left on disk, so a resumed hook still delivers what is due", async ({ expect, onTestFinished }) => {
    const f = fixture(onTestFinished);
    await hook(f, "PostCompact", "s1");
    const file = join(f.home, "refocus", `${SEAT}__s1.json`);
    writeFileSync(file, JSON.stringify({ ...stateOf(f, "s1"), pendingSeq: 3,
      delivering: { token: "left-behind", at: new Date().toISOString(), pendingSeq: 3 } }));
    writeFileSync(`${file}.lock`, "left-behind");
    const r = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_BUDGET_MS: "10000" });
    expect(context(r)).toContain("REFOCUS (just compacted");
    expect(stateOf(f, "s1")).toMatchObject({ firedOn: "UserPromptSubmit" });
  }, 20_000);
});
