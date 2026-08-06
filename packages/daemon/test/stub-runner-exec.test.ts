import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeStubScript,
  resolveStubScript,
  STUB_MID_TURN_DEATH_EXIT_CODE,
  type StubRunnerIO,
} from "../src/adapters/stub-runner.js";
import { DEFAULT_STUB_SCRIPT, StubScriptError, type StubScript } from "../src/adapters/stub-script.js";
import { stubSeatScriptPath } from "../src/adapters/stub-runner-protocol.js";
import type { CompactionResult } from "../src/adapters/stub-compaction.js";

// Slice 51-01 items 6-8 — R1: the runner's SCRIPT-EXECUTION loop + the StubRunnerIO seam.
//
// The runner no longer only idles: it LOADS a script (a scenario-resolved path in cwd,
// else DEFAULT_STUB_SCRIPT) and EXECUTES its steps against an injected IO seam
// (mirror pi-runner's RunnerIo): `say` → a pane mirror line; `emit compaction` → the
// real precompact seam via io.fireCompaction (arch R3: TRIGGER, never fabricate). The
// executor is dispatch-only over the injected seam, so it unit-tests hermetically with
// a fake IO — the real-spawn wiring is proven separately (stub-runner-compaction e2e).

const IDENTITY = { sessionName: "dev-worker@exec", nodeId: "exec-node" };

/** A recording fake of the StubRunnerIO seam. */
function fakeIo(): StubRunnerIO & { lines: string[]; fireCount: number; activities: Record<string, unknown>[]; died: boolean; diedCode: number | undefined } {
  const state = {
    lines: [] as string[],
    fireCount: 0,
    activities: [] as Record<string, unknown>[],
    died: false,
    diedCode: undefined as number | undefined,
    mirrorLine(line: string) { this.lines.push(line); },
    fireCompaction(): CompactionResult {
      this.fireCount++;
      return { markerPath: "/fake/restore-pending/seat.json" };
    },
    postActivity(payload: Record<string, unknown>) { this.activities.push(payload); },
    // The real runner's die() exits the process; the fake records it so dispatch is testable.
    die(code: number) { this.died = true; this.diedCode = code; },
    now() { return "2021-06-06T06:06:06.000Z"; },
  };
  return state;
}

describe("executeStubScript (R1 dispatch over the StubRunnerIO seam)", () => {
  it("mirrors a `say` step's text verbatim to the pane", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "say", text: "hello from the stub" }] }, io, IDENTITY);
    expect(io.lines).toContain("hello from the stub");
    expect(io.fireCount).toBe(0);
  });

  it("fires the REAL compaction seam on an `emit compaction` step (never fabricates)", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "emit", behavior: "compaction" }] }, io, IDENTITY);
    expect(io.fireCount).toBe(1);
    // The runner mirrors the marker the seam actually wrote (observable, honest).
    expect(io.lines.some((l) => l.includes("/fake/restore-pending/seat.json"))).toBe(true);
  });

  it("executes multi-step scripts in order", () => {
    const io = fakeIo();
    executeStubScript({
      steps: [
        { kind: "say", text: "first" },
        { kind: "emit", behavior: "compaction" },
        { kind: "say", text: "third" },
      ],
    }, io, IDENTITY);
    expect(io.fireCount).toBe(1);
    expect(io.lines[0]).toBe("first");
    expect(io.lines.at(-1)).toBe("third");
  });

  it("frames the scripted turn with canonical activity events (UserPromptSubmit … Stop), runtime=stub", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "say", text: "reply" }] }, io, IDENTITY);
    // A script is ONE turn: it opens with UserPromptSubmit (running) and closes with
    // Stop (idle) — the observable state transition the 51-02 scenario harness reads.
    expect(io.activities.at(0)).toMatchObject({
      hookEvent: "UserPromptSubmit", runtime: "stub", sessionName: IDENTITY.sessionName, nodeId: IDENTITY.nodeId,
    });
    expect(io.activities.at(-1)).toMatchObject({ hookEvent: "Stop", runtime: "stub" });
    // Every payload carries the canonical field shape (occurredAt from the injected clock).
    for (const a of io.activities) {
      expect(a.occurredAt).toBe("2021-06-06T06:06:06.000Z");
      expect(a.sessionName).toBe(IDENTITY.sessionName);
    }
  });

  it("simulates slow_output as DETERMINISTIC chunked pane output (paced observable, no real delay, no fabrication)", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "emit", behavior: "slow_output" }] }, io, IDENTITY);
    expect(io.fireCount).toBe(0); // not a compaction; no seam fired
    // "paced output at the scripted rate" (PRD §4.2) realized deterministically as a
    // fixed MULTI-part chunk sequence — the assertable observable (the scenario verb set
    // has no temporal assertion, so chunking IS the paced signal); §5-clean, fits R3.
    const chunks = io.lines.filter((l) => /slow_output chunk \d+\/\d+/.test(l));
    expect(chunks.length).toBeGreaterThanOrEqual(2); // multi-part = paced
    // Emitted in ascending order, deterministically.
    expect(io.lines.indexOf(chunks[0]!)).toBeLessThan(io.lines.indexOf(chunks[chunks.length - 1]!));
    expect(chunks[0]).toContain("1/");
    expect(chunks[chunks.length - 1]).toContain(`${chunks.length}/${chunks.length}`);
  });

  it("simulates mid_turn_death: the turn dies mid-flight — hooks CEASE (no Stop) and later steps do NOT run", () => {
    const io = fakeIo();
    executeStubScript({
      steps: [
        { kind: "emit", behavior: "mid_turn_death" },
        { kind: "say", text: "SHOULD NOT RUN — the seat is dead" },
      ],
    }, io, IDENTITY);
    // The turn opened (UserPromptSubmit) but died before completing — NO Stop was posted.
    const events = io.activities.map((a) => a.hookEvent);
    expect(events).toContain("UserPromptSubmit");
    expect(events).not.toContain("Stop"); // hooks ceased
    // The process was told to die (real runner exits here); later steps never ran.
    expect(io.died).toBe(true);
    expect(io.diedCode).toBe(STUB_MID_TURN_DEATH_EXIT_CODE);
    expect(io.lines).not.toContain("SHOULD NOT RUN — the seat is dead");
  });

  it("does NOT fabricate a not-yet-wired behavior — it mirrors an honest deferral, never a silent no-op", () => {
    for (const behavior of ["restore"] as const) {
      const io = fakeIo();
      executeStubScript({ steps: [{ kind: "emit", behavior }] }, io, IDENTITY);
      // No compaction seam fired for a non-compaction behavior…
      expect(io.fireCount).toBe(0);
      // …and the runner says so out loud (visible, not silently dropped).
      expect(io.lines.some((l) => l.includes(behavior) && /not yet simulated/i.test(l))).toBe(true);
    }
  });
});

describe("resolveStubScript (scenario-resolved path in cwd, else the built-in default)", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "stub-resolve-")); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  const fsLike = () => ({
    readFile: (p: string) => readFileSync(p, "utf8"),
    exists: (p: string) => existsSync(p),
  });

  it("returns DEFAULT_STUB_SCRIPT when no scenario script is present in cwd", () => {
    expect(resolveStubScript(cwd, fsLike())).toEqual(DEFAULT_STUB_SCRIPT);
  });

  it("parses the scenario-resolved script at <cwd>/.openrig/stub/script.json when present", () => {
    const scriptPath = stubSeatScriptPath(cwd);
    mkdirSync(join(cwd, ".openrig", "stub"), { recursive: true });
    const script: StubScript = { steps: [{ kind: "emit", behavior: "compaction" }] };
    writeFileSync(scriptPath, JSON.stringify(script), "utf8");
    expect(resolveStubScript(cwd, fsLike())).toEqual(script);
  });

  it("fails LOUDLY on a malformed scenario script (never a silent fallback to default)", () => {
    const scriptPath = stubSeatScriptPath(cwd);
    mkdirSync(join(cwd, ".openrig", "stub"), { recursive: true });
    writeFileSync(scriptPath, "{not json", "utf8");
    expect(() => resolveStubScript(cwd, fsLike())).toThrow(StubScriptError);
  });
});
