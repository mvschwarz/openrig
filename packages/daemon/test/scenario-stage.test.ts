import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  stageTopologyRoot,
  resolveStubScriptTargets,
  deliverStubScripts,
  StubScriptTargetError,
  type StagedTopology,
} from "./helpers/scenario-stage.js";

// 51-02 delta D1 (guard rev-3 bindings) — per-seat stub scripts.
//
// The lock requires scenarios to resolve PER-SEAT scripts; the shipped stub reads
// exactly `<cwd>/.openrig/stub/script.json`, so distinct scripts require distinct
// seat CWDs. A shared --cwd cannot honor that (resolveLaunchCwd makes the override
// win for every seat), so the pipeline stages a SELF-CONTAINED topology root and
// authors per-seat cwds in the staged copy. Staging a lone YAML would rebase the
// spec root and orphan the relative culture_file / local: agent_ref.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "stage-"));
  dirs.push(d);
  return d;
};

/** A source topology DIRECTORY with the relative closure the real fixtures have. */
function sourceTopologyDir(): { dir: string; topology: string } {
  const dir = scratch();
  mkdirSync(join(dir, "agents", "worker"), { recursive: true });
  writeFileSync(join(dir, "culture.md"), "# culture\n");
  writeFileSync(join(dir, "agents", "worker", "agent.yaml"), "id: worker\nrole: worker\n");
  const topology = join(dir, "topo.yaml");
  writeFileSync(
    topology,
    [
      'version: "0.2"',
      "name: scn-pair",
      "culture_file: culture.md",
      "pods:",
      "  - id: dev",
      "    label: Dev",
      "    members:",
      "      - id: alpha",
      '        agent_ref: "local:agents/worker"',
      "        profile: default",
      "        runtime: stub",
      "        cwd: .",
      "      - id: beta",
      '        agent_ref: "local:agents/worker"',
      "        profile: default",
      "        runtime: stub",
      "        cwd: .",
      "    edges: []",
      "",
    ].join("\n"),
  );
  return { dir, topology };
}

describe("D1 — staging copies a SELF-CONTAINED root (the relative closure travels)", () => {
  let staged: StagedTopology;
  let src: { dir: string; topology: string };

  const stage = () => {
    src = sourceTopologyDir();
    staged = stageTopologyRoot(src.topology, join(scratch(), "topology"));
    return staged;
  };

  it("carries culture.md and agents/** beside the staged YAML", () => {
    const s = stage();
    expect(existsSync(s.topologyPath)).toBe(true);
    expect(existsSync(join(s.root, "culture.md"))).toBe(true);
    expect(existsSync(join(s.root, "agents", "worker", "agent.yaml"))).toBe(true);
  });

  it("never writes to the committed source directory", () => {
    const s = stage();
    const before = readFileSync(src.topology, "utf-8");
    expect(before).toContain("cwd: ."); // source keeps its authored cwd
    expect(readdirSync(src.dir).sort()).toEqual(["agents", "culture.md", "topo.yaml"]);
    expect(s.root).not.toContain(src.dir);
  });

  it("authors a DISTINCT existing cwd per seat, inside the staged root", () => {
    const s = stage();
    const doc = parseYaml(readFileSync(s.topologyPath, "utf-8")) as any;
    const members = doc.pods[0].members;
    const cwds = members.map((m: any) => m.cwd);
    expect(new Set(cwds).size).toBe(2); // distinct
    for (const c of cwds) {
      expect(c.startsWith(s.root)).toBe(true);
      expect(existsSync(c)).toBe(true);
    }
    expect(s.seatCwds["dev-alpha"]).toBe(members[0].cwd);
    expect(s.seatCwds["dev-beta"]).toBe(members[1].cwd);
  });

  it("is SEMANTICALLY equal to the source except cwd values (parse/serialize cannot promise bytes)", () => {
    const s = stage();
    const strip = (raw: string) => {
      const d = parseYaml(raw) as any;
      for (const pod of d.pods) for (const m of pod.members) delete m.cwd;
      return d;
    };
    expect(strip(readFileSync(s.topologyPath, "utf-8"))).toEqual(strip(readFileSync(src.topology, "utf-8")));
  });
});

describe("D1 — env.stub_scripts key contract (loud BEFORE any write or spawn)", () => {
  const topo = {
    pods: [
      { id: "dev", members: [{ id: "alpha", runtime: "stub" }, { id: "beta", runtime: "stub" }] },
      { id: "ops", members: [{ id: "alpha", runtime: "stub" }, { id: "real", runtime: "claude-code" }] },
    ],
  };

  it("resolves a pod-qualified key to exactly one member", () => {
    expect(resolveStubScriptTargets(topo, { "dev-alpha": "a.json" })).toEqual({ "dev-alpha": "dev-alpha" });
  });

  it("resolves an unambiguous bare member id", () => {
    expect(resolveStubScriptTargets(topo, { beta: "b.json" })).toEqual({ beta: "dev-beta" });
  });

  it("rejects an UNKNOWN key naming the available stub seats", () => {
    let msg = "";
    try { resolveStubScriptTargets(topo, { wroker: "a.json" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("wroker");
    expect(msg).toContain("dev-alpha");
    expect(() => resolveStubScriptTargets(topo, { wroker: "a.json" })).toThrow(StubScriptTargetError);
  });

  it("rejects an AMBIGUOUS bare key that matches two pods", () => {
    expect(() => resolveStubScriptTargets(topo, { alpha: "a.json" })).toThrow(/ambiguous/i);
  });

  it("rejects a DUPLICATE ALIAS — two keys resolving to the same member", () => {
    expect(() => resolveStubScriptTargets(topo, { beta: "b.json", "dev-beta": "b2.json" })).toThrow(/same seat|duplicate/i);
  });

  it("rejects a NON-STUB target (a script would never be read)", () => {
    expect(() => resolveStubScriptTargets(topo, { "ops-real": "r.json" })).toThrow(/runtime:stub|not a stub/i);
  });
});

describe("D1 — delivery writes each script to ITS OWN seat cwd; unmapped seats get nothing", () => {
  it("writes only the mapped seats' script.json (an unmapped seat falls to the built-in default)", () => {
    const src = sourceTopologyDir();
    const scriptsDir = scratch();
    writeFileSync(join(scriptsDir, "a.json"), JSON.stringify({ steps: [{ kind: "say", text: "[alpha]" }] }));
    const staged = stageTopologyRoot(src.topology, join(scratch(), "topology"));

    deliverStubScripts(staged, { "dev-alpha": join(scriptsDir, "a.json") }, scriptsDir);

    const alphaScript = join(staged.seatCwds["dev-alpha"], ".openrig", "stub", "script.json");
    const betaScript = join(staged.seatCwds["dev-beta"], ".openrig", "stub", "script.json");
    expect(existsSync(alphaScript)).toBe(true);
    expect(JSON.parse(readFileSync(alphaScript, "utf-8")).steps[0].text).toBe("[alpha]");
    // the unmapped seat has NO script file — 51-01's built-in default applies
    expect(existsSync(betaScript)).toBe(false);
  });

  it("fails loud on a missing or malformed script file (never a silent default)", () => {
    const src = sourceTopologyDir();
    const scriptsDir = scratch();
    const staged = stageTopologyRoot(src.topology, join(scratch(), "topology"));
    expect(() => deliverStubScripts(staged, { "dev-alpha": join(scriptsDir, "nope.json") }, scriptsDir)).toThrow(/nope\.json/);

    writeFileSync(join(scriptsDir, "bad.json"), "{not json");
    expect(() => deliverStubScripts(staged, { "dev-alpha": join(scriptsDir, "bad.json") }, scriptsDir)).toThrow();
  });
});

describe("D1 R4/R5 — pipeline-level fences", () => {
  it("R4: a bad script-map key fails BEFORE any filesystem or process effect", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const src = sourceTopologyDir();
    const scenarioPath = join(src.dir, "bad-key.yaml");
    writeFileSync(
      scenarioPath,
      [
        "scenario: bad-key",
        "topology: ./topo.yaml",
        "env:",
        "  stub_scripts:",
        "    wroker: ./nope.json",
        "steps:",
        "  - up: {}",
        "",
      ].join("\n"),
    );
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("openrig-scenario-"));
    let spawned = false;
    await expect(
      runScenarioFile(scenarioPath, {
        rigBin: "/nonexistent/rig",
        baseEnv: { HOME: "/tmp/x", PATH: process.env.PATH, TERM: "xterm" },
        // a spawner that would flag any process effect — it must NEVER be called
        daemon: async () => { spawned = true; throw new Error("spawner must not run"); },
      }),
    ).rejects.toThrow(StubScriptTargetError);
    expect(spawned).toBe(false);
    // no scaffold was created either
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("openrig-scenario-"));
    expect(after.length).toBe(before.length);
  });

  it("R5: container mode REFUSES scripted scenarios by name, and is untouched without scripts", async () => {
    const { runScenarioFile, ScenarioModeUnsupportedError } = await import("./helpers/scenario-pipeline.js");
    const src = sourceTopologyDir();
    const scriptsDir = scratch();
    writeFileSync(join(scriptsDir, "a.json"), JSON.stringify({ steps: [{ kind: "say", text: "hi" }] }));
    const scenarioPath = join(src.dir, "scripted.yaml");
    writeFileSync(
      scenarioPath,
      [
        "scenario: scripted",
        "topology: ./topo.yaml",
        "env:",
        "  stub_scripts:",
        `    dev-alpha: ${join(scriptsDir, "a.json")}`,
        "steps:",
        "  - up: {}",
        "",
      ].join("\n"),
    );
    let staged = 0;
    let stopped = 0;
    const containerish = async () => ({
      readEnv: {}, baseUrl: "http://127.0.0.1:1",
      sigterm: async () => {}, restart: async () => {},
      stop: async () => { stopped++; },
      stageTopology: async (p: string) => { staged++; return p; },
    });
    await expect(
      runScenarioFile(scenarioPath, {
        rigBin: "/nonexistent/rig",
        baseEnv: { HOME: "/tmp/x", PATH: process.env.PATH, TERM: "xterm" },
        daemon: containerish as never,
      }),
    ).rejects.toBeInstanceOf(ScenarioModeUnsupportedError);
    expect(staged).toBe(0);   // never reached the container stage path
    expect(stopped).toBe(1);  // teardown still ran
  });
});
