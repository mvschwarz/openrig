// Refocus parity: the hook's time budget against the harness's outer kill, and overlapping events for one occupant.
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
  writeFileSync(join(bin, "rig"), `#!/bin/sh
echo "rig $*" >> "${log}"
case "$1 $2" in
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

interface Run { killed: boolean; ms: number; stdout: string }

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
    let killed = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, outerMs);
    child.on("close", () => { clearTimeout(timer); done({ killed, ms: Date.now() - started, stdout }); });
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

  it("keeps today's 2 s trace cap when no budget is selected", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const r = await hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "2500" }, 5_000);
    expect(r.killed).toBe(false);
    expect(r.ms).toBeLessThan(3_500);
    expect(context(r)).toMatch(/TRACE GAP — spawnSync .* ETIMEDOUT/);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 20_000);

  it("finishes inside today's 5 s bound when its lookups together would pass it, and records the failure", async () => {
    // Each lookup is under its own 2 s cap; together they passed 5 s and the harness killed the hook with no record.
    const f = fixture();
    const slow = { STUB_WHOAMI_MS: "1900", STUB_TRACE_MS: "1900", STUB_CONTEXT_MS: "1900", OPENRIG_REFOCUS_CONTENT_REF: "refocus/team.md",
      OPENRIG_REFOCUS_WORK_NODE: "", OPENRIG_REFOCUS_TREES: "both" };
    await hook(f, "PostCompact", "s1");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await hook(f, "UserPromptSubmit", "s1", slow, 5_000);
      expect(r.killed).toBe(false);
      expect(context(r)).toContain("REFOCUS");
      expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    }
    expect(healthOf(f)).toEqual([expect.objectContaining({ failures: 3 })]);
    expect(readFileSync(f.log, "utf8").split("\n").filter((l) => l.startsWith("rig stream")).length).toBe(1);
  }, 40_000);
});

describe("refocus: overlapping events for one occupant", () => {
  it("keeps a PostCompact that lands while an earlier refocus is being delivered", async () => {
    const f = fixture();
    await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_NOW: "1" });
    // A growth-due refocus is pending (as Stop leaves it); a prompt starts delivering it with a slow trace.
    const file = join(f.home, "refocus", `${SEAT}__s1.json`);
    writeFileSync(file, JSON.stringify({ ...stateOf(f, "s1"), pendingOn: "Stop", pendingAt: "2026-10-18T17:00:00.000Z" }));
    const delivering = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "1500" });
    await wait(600);
    await hook(f, "PostCompact", "s1");
    expect(context(await delivering)).toContain("REFOCUS");
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    const next = await hook(f, "UserPromptSubmit", "s1");
    expect(context(next)).toContain("REFOCUS (just compacted");
  }, 20_000);

  it("delivers a pending refocus once when two prompts overlap", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const first = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "1000" });
    await wait(200);
    const second = hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "1000" });
    const delivered = (await Promise.all([first, second])).filter((r) => context(r).includes("REFOCUS"));
    expect(delivered).toHaveLength(1);
    expect(stateOf(f, "s1")["pendingOn"]).toBeUndefined();
    expect(stateOf(f, "s1")["delivering"]).toBeUndefined();
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
    expect([stateOf(f, "s1")["pendingOn"], stateOf(f, "s2")["pendingOn"]]).toEqual([undefined, undefined]);
  }, 20_000);

  it("doesn't let a claim left by a killed delivery hold the refocus back", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const killed = await hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "3000" }, 500);
    expect(killed.killed).toBe(true);
    expect(stateOf(f, "s1")["delivering"]).toBeDefined();
    // The claim lasts the budget (4.5 s) plus a 2 s margin.
    await wait(6_700);
    const next = await hook(f, "UserPromptSubmit", "s1");
    expect(context(next)).toContain("REFOCUS (just compacted");
  }, 30_000);
});
