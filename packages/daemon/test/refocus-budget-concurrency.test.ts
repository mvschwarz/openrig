// Refocus: the hook's time budget against the harness's outer kill, its failure report, and (characterized, unresolved)
// overlapping events for one occupant.
// Each case runs the real hook as a harness does (JSON on stdin, killed at the registration's outer bound), with a stub
// `rig` and a stub trace script whose delays are set per case. The overlaps are hook processes overlapping; whether a
// harness overlaps these events natively is not established here.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, "../assets/plugins/openrig-core");
const HOOK = join(PLUGIN, "hooks/scripts/refocus.cjs");
const SEAT = "dev-impl@budget-rig";

let root: string | undefined;
afterEach(() => {
  // A case that made the state folder read-only may have timed out before putting it back.
  if (root) try { chmodSync(join(root, "openrig", "refocus"), 0o755); } catch {}
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

interface Fixture { home: string; bin: string; log: string }

function fixture(): Fixture {
  root = mkdtempSync(join(tmpdir(), "refocus-budget-"));
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
[ -n "$STUB_TRACE_PARTIAL" ] && echo "$STUB_TRACE_PARTIAL"
${sleep("STUB_TRACE_MS")}
echo "TRACE OK: work and topology"
`);
  chmodSync(join(bin, "rig"), 0o755);
  chmodSync(join(bin, "trace"), 0o755);
  return { home, bin, log };
}

interface Run { killed: boolean; ms: number; stdout: string; stderr: string }

// Run the hook as the harness does, killed at `outerMs` (both registrations' bound for refocus: 60 s).
function hook(f: Fixture, event: string, session: string, extra: Record<string, string> = {}, outerMs = 60_000): Promise<Run> {
  const transcript = join(root!, `${session}.jsonl`);
  if (!existsSync(transcript)) writeFileSync(transcript, "");
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn("node", [HOOK, "--runtime", "claude"], {
      env: {
        PATH: `${f.bin}:${process.env.PATH}`, HOME: root!, OPENRIG_HOME: f.home, OPENRIG_SESSION_NAME: SEAT,
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
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: session, transcript_path: transcript, prompt: "next" }));
  });
}

const context = (r: Run): string => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "");
const stateOf = (f: Fixture, session: string) =>
  JSON.parse(readFileSync(join(f.home, "refocus", `${SEAT}__${session}.json`), "utf8")) as Record<string, unknown>;
const healthOf = (f: Fixture) => readdirSync(join(f.home, "refocus")).filter((n) => n.endsWith(".health.json"))
  .map((n) => JSON.parse(readFileSync(join(f.home, "refocus", n), "utf8")) as { failures?: number });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe("refocus: the time budget", () => {
  it("delivers a slow but successful trace when a longer budget is selected", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_BUDGET_MS: "10000", STUB_TRACE_MS: "2500" });
    expect(r.killed).toBe(false);
    expect(context(r)).toContain("TRACE OK: work and topology");
    expect(context(r)).not.toContain("TRACE GAP");
    expect(stateOf(f, "s1")).toMatchObject({ firedOn: "UserPromptSubmit" });
    expect(stateOf(f, "s1")["pendingOn"]).toBeUndefined();
  }, 20_000);

  it("ends a trace that never finishes as a gap inside the selected budget, keeping the refocus due", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_BUDGET_MS: "10000", STUB_TRACE_MS: "30000" });
    expect(r.killed).toBe(false);
    expect(r.ms).toBeLessThan(10_000);
    expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 20_000);

  it("limits a selected budget to 52 s, so reporting and recording the outcome still end inside the 60 s bound", async () => {
    // At 52 s the trace's cap is 23.1 s: a 23.5 s trace ends as a gap (at 55 s its cap would have been 24.4 s).
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_BUDGET_MS: "120000", STUB_TRACE_MS: "23500" });
    expect(r.killed).toBe(false);
    // The gap is what tells 52 s from 55 s; the time bound only checks the hook ended, with room for process start-up.
    expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    expect(r.ms).toBeLessThan(30_000);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 40_000);

  it("keeps today's 2 s trace cap when no budget is selected", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "2500" }, 5_000);
    expect(r.killed).toBe(false);
    expect(r.ms).toBeLessThan(3_500);
    expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 20_000);

  it("with no budget selected, gives main's result: each lookup keeps its 2 s cap, unclipped, inside the 60 s bound", async () => {
    // Lookups each under their own 2 s cap (with room for a slow runner's process start-up) that together pass 5 s: on
    // main's 5 s registration this was killed; now it completes as main's code does.
    const f = fixture();
    const slow = { STUB_WHOAMI_MS: "1700", STUB_TRACE_MS: "1700", STUB_CONTEXT_MS: "1700", OPENRIG_REFOCUS_CONTENT_REF: "refocus/team.md",
      OPENRIG_REFOCUS_WORK_NODE: "", OPENRIG_REFOCUS_TREES: "both" };
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", slow);
    expect(r.killed).toBe(false);
    expect(context(r)).toContain("TRACE OK: work and topology");
    expect(context(r)).toContain("CONFIGURED REFOCUS CONTENT");
    expect(stateOf(f, "s1")).toMatchObject({ firedOn: "UserPromptSubmit" });
    // A content-REF seat with a slow whoami gets main's full 2 s trace, not a shorter one (completes on main in ~2.9 s).
    const g = fixture();
    await hook(g, "PostCompact", "s1");
    const ref = await hook(g, "UserPromptSubmit", "s1", { STUB_WHOAMI_MS: "1000", STUB_TRACE_MS: "1500", STUB_CONTEXT_MS: "300",
      OPENRIG_REFOCUS_CONTENT_REF: "refocus/team.md", OPENRIG_REFOCUS_WORK_NODE: "", OPENRIG_REFOCUS_TREES: "both" });
    expect(context(ref)).toContain("TRACE OK: work and topology");
    expect(context(ref)).not.toContain("TRACE GAP");
  }, 40_000);

  it("with no budget selected, still files the issue report after three slow failed attempts that ran past 4.5 s", async () => {
    // Default lookups keep their fixed 2 s caps, so a failed default attempt can end around 6 s. Its report gets its
    // own window after that (the stub answers a report after 200 ms), so the third failure is reported and confirmed.
    const f = fixture();
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

  it("with a budget selected, ends lookups that together pass it as a reported gap, and records the failure", async () => {
    // A 4.6 s budget gives each lookup a ~2 s cap; three of them pass the budget, so the last is clipped.
    const f = fixture();
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

describe("refocus: overlapping events for one occupant (UNRESOLVED; characterized, not fixed)", () => {
  // These describe main's behaviour, which this change keeps: two hook runs for one occupant are not serialized, so
  // overlapping hook processes can lose a just-recorded compaction or deliver one refocus twice. Whether a harness
  // overlaps these events natively is NOT ESTABLISHED; the gap is open, not shown safe. If a later change serializes
  // the state, these flip and should then assert the fixed behaviour.
  it("can lose a PostCompact that lands while an earlier refocus is being delivered", async () => {
    const f = fixture();
    await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_NOW: "1" });
    const file = join(f.home, "refocus", `${SEAT}__s1.json`);
    writeFileSync(file, JSON.stringify({ ...stateOf(f, "s1"), pendingOn: "Stop", pendingAt: "2026-10-18T17:00:00.000Z" }));
    const delivering = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "1500" });
    await wait(600);
    await hook(f, "PostCompact", "s1");
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    expect(context(await delivering)).toContain("REFOCUS");
    // The delivery wrote back the state it read before the PostCompact: the compaction's pending is gone.
    expect(stateOf(f, "s1")["pendingOn"]).toBeUndefined();
    expect(context(await hook(f, "UserPromptSubmit", "s1"))).toBe("");
  }, 20_000);

  it("can deliver one pending refocus twice when two prompts overlap", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const first = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "1000" });
    await wait(200);
    const second = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "1000" });
    const delivered = (await Promise.all([first, second])).filter((r) => context(r).includes("REFOCUS"));
    expect(delivered).toHaveLength(2);
  }, 20_000);

  it("still delivers to each of two occupants of one seat when they overlap", async () => {
    const f = fixture();
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
  it("ignores a delivery claim and pendingSeq left on disk, so a resumed hook still delivers what is due", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const file = join(f.home, "refocus", `${SEAT}__s1.json`);
    writeFileSync(file, JSON.stringify({ ...stateOf(f, "s1"), pendingSeq: 3,
      delivering: { token: "left-behind", at: new Date().toISOString(), pendingSeq: 3 } }));
    writeFileSync(`${file}.lock`, "left-behind");
    const r = await hook(f, "UserPromptSubmit", "s1");
    expect(context(r)).toContain("REFOCUS (just compacted");
    expect(stateOf(f, "s1")).toMatchObject({ firedOn: "UserPromptSubmit" });
  }, 20_000);
});
