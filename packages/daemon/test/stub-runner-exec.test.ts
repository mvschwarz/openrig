import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeStubScript,
  resolveStubScript,
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

/** A recording fake of the StubRunnerIO seam. */
function fakeIo(): StubRunnerIO & { lines: string[]; fireCount: number } {
  const state = {
    lines: [] as string[],
    fireCount: 0,
    mirrorLine(line: string) { this.lines.push(line); },
    fireCompaction(): CompactionResult {
      this.fireCount++;
      return { markerPath: "/fake/restore-pending/seat.json" };
    },
    now() { return "2021-06-06T06:06:06.000Z"; },
  };
  return state;
}

describe("executeStubScript (R1 dispatch over the StubRunnerIO seam)", () => {
  it("mirrors a `say` step's text verbatim to the pane", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "say", text: "hello from the stub" }] }, io);
    expect(io.lines).toContain("hello from the stub");
    expect(io.fireCount).toBe(0);
  });

  it("fires the REAL compaction seam on an `emit compaction` step (never fabricates)", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "emit", behavior: "compaction" }] }, io);
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
    }, io);
    expect(io.fireCount).toBe(1);
    expect(io.lines[0]).toBe("first");
    expect(io.lines.at(-1)).toBe("third");
  });

  it("does NOT fabricate a not-yet-wired behavior — it mirrors an honest deferral, never a silent no-op", () => {
    for (const behavior of ["slow_output", "mid_turn_death", "restore"] as const) {
      const io = fakeIo();
      executeStubScript({ steps: [{ kind: "emit", behavior }] }, io);
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
