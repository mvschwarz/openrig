// Refocus parity: the hook's time budget against the harness's outer kill, and overlapping events for one occupant.
// Each case runs the real hook as a harness does (JSON on stdin, killed at the registration's outer bound), with a stub
// `rig` and a stub trace script whose delays are set per case. The overlaps are hook processes overlapping; whether a
// harness overlaps these events natively is not established here.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

  it("waits for an occupant's state lock held by another hook, rather than writing without it", async () => {
    const f = fixture();
    await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_NOW: "1" });
    const lockFile = join(f.home, "refocus", `${SEAT}__s1.json.lock`);
    writeFileSync(lockFile, "");
    const compact = hook(f, "PostCompact", "s1");
    await wait(1_800);
    // Still held: nothing written yet.
    expect(stateOf(f, "s1")["pendingOn"]).toBeUndefined();
    rmSync(lockFile);
    const r = await compact;
    expect(r.ms).toBeGreaterThanOrEqual(1_800);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    expect(existsSync(lockFile)).toBe(false);
  }, 20_000);

  it("breaks a lock left by a killed hook once it is stale", async () => {
    const f = fixture();
    await hook(f, "UserPromptSubmit", "s1", { OPENRIG_REFOCUS_NOW: "1" });
    const lockFile = join(f.home, "refocus", `${SEAT}__s1.json.lock`);
    writeFileSync(lockFile, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    const r = await hook(f, "PostCompact", "s1");
    expect(r.ms).toBeLessThan(3_000);
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
  }, 20_000);

  it("doesn't let a claim left by a killed delivery hold the refocus back", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const killed = await hook(f, "UserPromptSubmit", "s1", { STUB_TRACE_MS: "3000" }, 500);
    expect(killed.killed).toBe(true);
    expect(stateOf(f, "s1")["delivering"]).toBeDefined();
    // The claim lasts as long as its owner could still be running: budget 4.5 s + report 1.5 s + closing lock 6 s + 0.5 s.
    // Within that, a second prompt leaves the refocus to it (still due); after it, the refocus is delivered.
    await wait(6_000);
    const inside = await hook(f, "UserPromptSubmit", "s1");
    expect(context(inside)).toBe("");
    expect(stateOf(f, "s1")).toMatchObject({ pendingOn: "PostCompact" });
    await wait(7_000);
    const next = await hook(f, "UserPromptSubmit", "s1");
    expect(context(next)).toContain("REFOCUS (just compacted");
  }, 40_000);
});

describe("refocus: a lock that can't be taken never holds the turn", () => {
  const cases: Array<[string, (lockFile: string) => void]> = [
    ["a directory at the lock path", (lockFile) => mkdirSync(lockFile)],
    ["a dangling link at the lock path", (lockFile) => symlinkSync(join(dirname(lockFile), "nowhere"), lockFile)],
  ];
  for (const [name, plant] of cases) {
    it(`with ${name}, ends at once at both lock sites, delivers, and says it went on without the lock`, async () => {
      const f = fixture();
      await hook(f, "PostCompact", "s1");
      plant(join(f.home, "refocus", `${SEAT}__s1.json.lock`));
      const r = await hook(f, "UserPromptSubmit", "s1");
      expect(r.killed).toBe(false);
      expect(r.ms).toBeLessThan(3_000);
      expect(context(r)).toContain("REFOCUS (just compacted");
      expect(r.stderr).toContain("going on without it");
      // Both lock sites (the start and the closing write) fell back the same way, and the outcome was recorded.
      expect(r.stderr.split("going on without it").length - 1).toBe(2);
      expect(stateOf(f, "s1")["pendingOn"]).toBeUndefined();
    }, 20_000);
  }

  it.skipIf(process.getuid?.() === 0)("with a stale lock in a folder it can't change, ends at once at both lock sites", async () => {
    const f = fixture();
    await hook(f, "PostCompact", "s1");
    const dir = join(f.home, "refocus");
    const lockFile = join(dir, `${SEAT}__s1.json.lock`);
    writeFileSync(lockFile, "dead-owner");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    chmodSync(dir, 0o555);
    try {
      const r = await hook(f, "UserPromptSubmit", "s1");
      expect(r.killed).toBe(false);
      expect(r.ms).toBeLessThan(3_000);
      expect(r.stderr.split("going on without it").length - 1).toBe(2);
      expect(context(r)).toContain("REFOCUS (just compacted");
    } finally {
      chmodSync(dir, 0o755);
    }
  }, 20_000);
});

describe("refocus: the state lock takes over and releases only its own", () => {
  const { createLock } = createRequire(import.meta.url)(join(PLUGIN, "hooks/scripts/refocus-lock.cjs")) as {
    createLock: (file: string, opts: { staleMs: number; waitMs: number; hooks?: { beforeTakeover?: () => void } }) => {
      acquire: () => { ok: boolean; reason?: string }; release: () => void; token: string; isHeld: () => boolean;
    };
  };
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "refocus-lock-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("keeps waiting, rather than giving up, when the lock is released and taken again between its read and its check", () => {
    const lockFile = join(dir, "s.json.lock");
    const other = createLock(lockFile, { staleMs: 5_000, waitMs: 300 });
    expect(other.acquire().ok).toBe(true);
    // The read finds nothing, the path holds a fresh regular lock again: a live holder, not a dangling link.
    const realRead = readFileSync;
    let swapped = false;
    const fsModule = createRequire(import.meta.url)("node:fs") as { readFileSync: typeof readFileSync };
    fsModule.readFileSync = ((path: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
      if (!swapped && String(path) === lockFile) {
        swapped = true;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return (realRead as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof readFileSync;
    try {
      const waiter = createLock(lockFile, { staleMs: 5_000, waitMs: 300 });
      expect(waiter.acquire()).toEqual({ ok: false, reason: "another hook held the lock past the wait" });
    } finally {
      fsModule.readFileSync = realRead;
    }
    other.release();
  });

  it("when two contenders both see the same stale lock, only one ends up holding it", () => {
    const lockFile = join(dir, "s.json.lock");
    writeFileSync(lockFile, "dead-owner");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    const b = createLock(lockFile, { staleMs: 5_000, waitMs: 300 });
    let raced = false;
    // A reads the stale lock, then B takes it over and holds a fresh one before A moves anything.
    const a = createLock(lockFile, { staleMs: 5_000, waitMs: 300, hooks: { beforeTakeover: () => {
      if (raced) return;
      raced = true;
      expect(b.acquire()).toEqual({ ok: true });
    } } });
    const got = a.acquire();
    expect(got.ok).toBe(false);
    expect(b.isHeld()).toBe(true);
    expect(a.isHeld()).toBe(false);
    // B's lock is where it was, with B's token, and nothing else was left behind.
    expect(readFileSync(lockFile, "utf8")).toBe(b.token);
    expect(readdirSync(dir)).toEqual(["s.json.lock"]);
  });

  it("releases only a lock that still holds its own token", () => {
    const lockFile = join(dir, "s.json.lock");
    const a = createLock(lockFile, { staleMs: 5_000, waitMs: 300 });
    expect(a.acquire().ok).toBe(true);
    // Another owner's lock now sits at the path (A's was broken as stale while A was suspended).
    writeFileSync(lockFile, "another-owner");
    a.release();
    expect(readFileSync(lockFile, "utf8")).toBe("another-owner");
  });

  it("gives up at its deadline while a live holder keeps the lock", () => {
    const lockFile = join(dir, "s.json.lock");
    const holder = createLock(lockFile, { staleMs: 5_000, waitMs: 300 });
    expect(holder.acquire().ok).toBe(true);
    const started = Date.now();
    const waiter = createLock(lockFile, { staleMs: 5_000, waitMs: 300 });
    expect(waiter.acquire()).toEqual({ ok: false, reason: "another hook held the lock past the wait" });
    expect(Date.now() - started).toBeLessThan(2_000);
    holder.release();
    expect(waiter.acquire().ok).toBe(true);
  });
});
