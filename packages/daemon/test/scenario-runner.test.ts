import { describe, it, expect, vi } from "vitest";
import { validateScenario } from "./helpers/scenario-schema.js";
import {
  runValidatedScenario,
  parseDuration,
  type ScenarioRunnerDeps,
} from "./helpers/scenario-runner.js";
import type { RunRecord } from "./helpers/scenario-run-record.js";

// Slice 51-02 — the runner CORE (dumb executor). Parse+validate happens upstream;
// this runs a validated scenario's steps in order: actions via the injected
// runAction, `expect` via poll-until-match over the injected observe. On the first
// failed step it emits an expected-vs-last-observed DIFF, appends a FAIL run-record
// row, and stops. All-pass → PASS + a PASS row. Zero heuristics.

function clock(stepMs = 1000) {
  let t = 0;
  return () => (t += stepMs);
}

function makeDeps(over: Partial<ScenarioRunnerDeps> & { records?: RunRecord[] } = {}): ScenarioRunnerDeps & { records: RunRecord[] } {
  const records: RunRecord[] = over.records ?? [];
  return {
    runAction: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    observe: vi.fn(async () => ({})),
    now: clock(),
    sleep: async () => {},
    appendRecord: (r: RunRecord) => records.push(r),
    defaults: { withinMs: 1000, pollIntervalMs: 100 },
    ...over,
    records,
  };
}

const scenario = (steps: unknown[], name = "s") =>
  (validateScenario({ scenario: name, topology: "fixtures/t.yaml", steps }) as { ok: true; scenario: never }).scenario;

describe("parseDuration", () => {
  it("parses relative durations to ms", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("5s")).toBe(5000);
    expect(parseDuration("2m")).toBe(120000);
    expect(parseDuration("1h")).toBe(3600000);
    expect(parseDuration("1500")).toBe(1500); // bare = ms
  });
});

describe("runValidatedScenario", () => {
  it("runs actions in order and PASSes when every expect matches", async () => {
    const deps = makeDeps({
      observe: vi.fn(async () => ({ state: "in-progress" })),
    });
    const sc = scenario([
      { up: {} },
      { send: { to: "a@r", text: "x" } },
      { expect: { surface: "queue", match: { state: "in-progress" } } },
      { down: {} },
    ]);
    const r = await runValidatedScenario(sc, deps);
    expect(r.verdict).toBe("PASS");
    // actions ran in order
    expect((deps.runAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["up", "send", "down"]);
    expect(deps.records.at(-1)?.verdict).toBe("PASS");
  });

  it("FAILs at the first expect that never matches, with a DIFF + an appended FAIL record", async () => {
    const deps = makeDeps({
      observe: vi.fn(async () => ({ state: "pending" })),
      now: clock(600), // elapses the 1000ms default after ~2 polls
    });
    const sc = scenario([
      { up: {} },
      { expect: { surface: "queue", match: { state: "in-progress" } } },
      { down: {} },
    ]);
    const r = await runValidatedScenario(sc, deps);
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(1);
    expect(r.diff).toContain("in-progress");
    expect(r.diff).toContain("pending");
    // stopped before `down`
    expect((deps.runAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["up"]);
    const rec = deps.records.at(-1)!;
    expect(rec.verdict).toBe("FAIL");
    expect(rec.failedStep).toBe(1);
    expect(rec.diff).toContain("pending");
  });

  it("FAILs when an action returns a non-zero exit", async () => {
    const deps = makeDeps({
      runAction: vi.fn(async (verb: string) => (verb === "send" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" })),
    });
    const sc = scenario([{ up: {} }, { send: { to: "a@r", text: "x" } }, { down: {} }]);
    const r = await runValidatedScenario(sc, deps);
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(1);
    expect(r.diff).toContain("boom");
  });

  it("supports the contains mode over a string surface", async () => {
    const deps = makeDeps({ observe: vi.fn(async () => "...seat restored...") });
    const sc = scenario([{ expect: { surface: "pane", seat: "a@r", contains: "restored" } }]);
    expect((await runValidatedScenario(sc, deps)).verdict).toBe("PASS");
    const deps2 = makeDeps({ observe: vi.fn(async () => "nothing"), now: clock(600) });
    expect((await runValidatedScenario(sc, deps2)).verdict).toBe("FAIL");
  });

  it("honors a per-expect within override", async () => {
    let polls = 0;
    const deps = makeDeps({
      observe: vi.fn(async () => { polls++; return { state: "pending" }; }),
      now: clock(100),
    });
    const sc = scenario([{ expect: { surface: "queue", within: "250ms", match: { state: "x" } } }]);
    await runValidatedScenario(sc, deps);
    // 250ms bound at 100ms/tick => ~3 polls, far fewer than the 1000ms default
    expect(polls).toBeLessThanOrEqual(4);
  });
});
