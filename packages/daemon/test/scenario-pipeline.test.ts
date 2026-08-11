import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

  it("expresses #10 one-view-state: the DECLARATIVE equals mapping over the two daemon-truth surfaces", () => {
    const res = loadScenarioFile(join(FIXTURES, "scenario-10-one-view-state.yaml"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.loaded.scenario.scenario).toBe("one-view-state-consistency");
    const expects = res.loaded.scenario.steps
      .filter((s) => "expect" in s)
      .map((s) => (s as { expect: Record<string, unknown> }).expect);

    // 51-03: equals is now the declarative MAPPING (A-N1's scenario-facing form),
    // each surface declaring the field that carries the shared truth.
    const equalsStep = expects.find((e) => e.equals)!;
    expect(equalsStep.equals).toEqual({
      ps: { pluck: "name" },
      queue: { pluck: "destinationSession", rig: true },
    });

    // tui_socket is asserted SEPARATELY on its own coherence, deliberately not
    // folded into the equality: both of the shipped control socket's OBSERVE
    // verbs return UI/registry state, so it carries no daemon truth to compare
    // and including it could only pass by comparing something trivially equal.
    const tuiStep = expects.find((e) => e.surface === "tui_socket")!;
    expect(tuiStep).toBeDefined();
    expect(tuiStep.match).toEqual({ ok: true });
    expect(equalsStep.equals).not.toHaveProperty("tui_socket");
  });
});

describe("queue-baton preconditions (post-P21 identity: env-carried, never a body flag)", () => {
  it("carries the declared identity via OPENRIG_SESSION_NAME per call — creator=source, claimant=destination — and never passes the retired --source flag", async () => {
    const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
    const runRig = vi.fn(async (args: string[], env: Record<string, string | undefined>) => {
      calls.push({ args, env });
      return okRig();
    });
    await applyQueuePreconditions(
      [{ id: "baton-1", source: "harness@r", destination: "dev-worker@r", claim: true }],
      { rigBin: "/bin/rig", readEnv: { OPENRIG_URL: "http://127.0.0.1:9" }, runRig },
    );
    // P21 I3 (c4fad7b39) retired --source (deprecated + IGNORED): the sender rides
    // the transport header, derived from OPENRIG_SESSION_NAME. An ignored flag in
    // the argv would be a stale claim in the harness — assert its ABSENCE.
    expect(calls[0].args.slice(0, 6)).toEqual(["queue", "create", "--id", "baton-1", "--destination", "dev-worker@r"]);
    expect(calls[0].args).not.toContain("--source");
    expect(calls[0].env.OPENRIG_SESSION_NAME).toBe("harness@r");
    expect(calls[0].env.OPENRIG_URL).toBe("http://127.0.0.1:9"); // daemon target preserved
    expect(calls[1].args).toEqual(["queue", "claim", "baton-1", "--destination", "dev-worker@r", "--json"]);
    expect(calls[1].env.OPENRIG_SESSION_NAME).toBe("dev-worker@r");
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

describe("D3 — env.scope_mission survives the WHOLE path into the shipped argv", () => {
  it("load → env-extract → real-deps → reader produces `rig scope audit --mission <name> --json`", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = mkdtempSync(join(tmpdir(), "scope-mission-"));
    try {
      const argvLog = join(d, "argv.log");
      // A stand-in `rig` bin: records the REAL argv the pipeline invokes, so this
      // pins the composed path (a helper-level argv spy could pass while the
      // pipeline silently dropped the field).
      const fakeRig = join(d, "fake-rig.mjs");
      writeFileSync(fakeRig, [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'process.stdout.write("{}");',
        "",
      ].join("\n"));
      writeFileSync(join(d, "topo.yaml"), [
        'version: "0.2"', "name: scn-scope", "pods:", "  - id: dev", "    label: Dev",
        "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
        "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
      ].join("\n"));
      const scenarioPath = join(d, "scope.yaml");
      writeFileSync(scenarioPath, [
        "scenario: scope-mission-plumbing",
        "topology: ./topo.yaml",
        "env:",
        "  scope_mission: release-0.5.1",
        "steps:",
        "  - expect:",
        "      surface: scope",
        "      within: 0ms",
        "      match: { findings: [] }",
        "",
      ].join("\n"));

      const fakeDaemon = async () => ({
        // a real ScenarioDaemon's readEnv carries the scaffold env (PATH included)
        readEnv: { PATH: process.env.PATH }, baseUrl: "http://127.0.0.1:1",
        sigterm: async () => {}, restart: async () => {}, stop: async () => {},
      });
      await runScenarioFile(scenarioPath, {
        rigBin: fakeRig,
        baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
        daemon: fakeDaemon as never,
        deps: { defaults: { withinMs: 0, pollIntervalMs: 1 } },
      });

      const invocations = readFileSync(argvLog, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(invocations).toContainEqual(["scope", "audit", "--mission", "release-0.5.1", "--json"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
