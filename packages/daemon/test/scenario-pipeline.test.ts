import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScenarioFile,
  ScenarioLoadError,
  ScenarioPreconditionError,
  extractQueuePreconditions,
  applyQueuePreconditions,
} from "./helpers/scenario-pipeline.js";
import type { RigResult } from "./helpers/scenario-daemon.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "scenarios");
const okRig = (stdout = ""): RigResult => ({ code: 0, stdout, stderr: "" });

// Slice 51-02 — the parse→validate→resolve loader. Reads a scenario YAML, resolves
// its `topology` rig-spec path relative to the scenario file, and validates the
// arch shape. I/O + YAML-syntax failures throw LOUD (ScenarioLoadError); content
// problems return the validator's error list. This is the pure front of the e2e
// pipeline (the heavy spawn+run half is the integration path).

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
function scratch(): string { dir = mkdtempSync(join(tmpdir(), "scn-pipe-")); return dir; }
function write(name: string, body: string): string {
  const d = dir ?? scratch();
  const p = join(d, name);
  writeFileSync(p, body, "utf-8");
  return p;
}

describe("loadScenarioFile", () => {
  it("parses a valid scenario and resolves topology relative to the scenario file", () => {
    const p = write("s.yaml", [
      "scenario: baton-survives",
      "topology: ./topo.yaml",
      "steps:",
      "  - up: {}",
      "  - expect: { surface: queue, match: { state: in-progress } }",
    ].join("\n"));
    const res = loadScenarioFile(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.loaded.scenario.scenario).toBe("baton-survives");
    expect(isAbsolute(res.loaded.topologyPath)).toBe(true);
    expect(res.loaded.topologyPath).toBe(join(dir!, "topo.yaml"));
  });

  it("returns the validator's errors for an unknown surface (loud, not silent)", () => {
    const p = write("s.yaml", [
      "scenario: bad",
      "topology: ./topo.yaml",
      "steps:",
      "  - expect: { surface: nope, match: { x: 1 } }",
    ].join("\n"));
    const res = loadScenarioFile(p);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.code === "UNKNOWN_EXPECT_SURFACE")).toBe(true);
  });

  it("throws ScenarioLoadError on malformed YAML", () => {
    const p = write("s.yaml", "scenario: [unterminated\n  : : :");
    expect(() => loadScenarioFile(p)).toThrow(ScenarioLoadError);
  });

  it("throws ScenarioLoadError on a missing file", () => {
    expect(() => loadScenarioFile(join(tmpdir(), "does-not-exist-scn.yaml"))).toThrow(ScenarioLoadError);
  });
});

// Expressibility (proof item 7): the format + validator EXPRESS the two locked
// evidence scenarios as authored, committed fixtures — parsed + validated by the
// real loader (no daemon). The heavy real-tmux run is the integration suite.
describe("authored evidence scenarios (expressibility)", () => {
  it("expresses #2 queue-baton-survives-restart: validates, resolves topology, and carries the baton precondition", () => {
    const res = loadScenarioFile(join(FIXTURES, "scenario-02-baton.yaml"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.loaded.scenario.scenario).toBe("queue-baton-survives-restart");
    expect(basename(res.loaded.topologyPath)).toBe("topo-stub-baton.yaml");
    // steps drive the runner machinery fully: up -> expect queue -> daemon restart -> expect queue -> down
    const verbs = res.loaded.scenario.steps.map((s) => Object.keys(s)[0]);
    expect(verbs).toEqual(["up", "expect", "daemon", "expect", "down"]);
    // the baton precondition is extractable (fixture-level, outside the grammar)
    const pre = extractQueuePreconditions(res.loaded.scenario.env);
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatchObject({ id: "baton-1", destination: "dev-worker@scn-baton", claim: true });
  });

  it("expresses #10 one-view-state: validates the cross-surface equals over tui_socket/ps/queue", () => {
    const res = loadScenarioFile(join(FIXTURES, "scenario-10-one-view-state.yaml"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.loaded.scenario.scenario).toBe("one-view-state-consistency");
    const equalsStep = res.loaded.scenario.steps.find((s) => "expect" in s)!;
    const exp = (equalsStep as { expect: Record<string, unknown> }).expect;
    expect(exp.equals).toEqual(["tui_socket", "ps", "queue"]);
  });
});

describe("queue-baton preconditions", () => {
  it("maps to `rig queue create` then `rig queue claim` when claim:true", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return okRig(); });
    await applyQueuePreconditions(
      [{ id: "baton-1", source: "harness@r", destination: "dev-worker@r", claim: true }],
      { rigBin: "/bin/rig", readEnv: {}, runRig },
    );
    expect(calls[0].slice(0, 8)).toEqual(["queue", "create", "--id", "baton-1", "--source", "harness@r", "--destination", "dev-worker@r"]);
    expect(calls[1]).toEqual(["queue", "claim", "baton-1", "--destination", "dev-worker@r", "--json"]);
  });

  it("skips claim when claim is not set, and fails closed on a create error", async () => {
    const noClaim = vi.fn(async () => okRig());
    await applyQueuePreconditions([{ id: "b", source: "s@r", destination: "d@r" }], { rigBin: "/bin/rig", readEnv: {}, runRig: noClaim });
    expect(noClaim).toHaveBeenCalledOnce(); // create only

    const boom = vi.fn(async () => ({ code: 1, stdout: "", stderr: "dup id" }));
    await expect(
      applyQueuePreconditions([{ id: "b", source: "s@r", destination: "d@r", claim: true }], { rigBin: "/bin/rig", readEnv: {}, runRig: boom }),
    ).rejects.toBeInstanceOf(ScenarioPreconditionError);
  });

  it("rejects a malformed env.queue entry loudly", () => {
    expect(() => extractQueuePreconditions({ queue: [{ id: "x" }] })).toThrow(ScenarioPreconditionError);
    expect(() => extractQueuePreconditions({ queue: "nope" })).toThrow(ScenarioPreconditionError);
    expect(extractQueuePreconditions(undefined)).toEqual([]);
  });
});
