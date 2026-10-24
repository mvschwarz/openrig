import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioFile, extractStubScripts } from "./helpers/scenario-pipeline.js";
import { stageTopologyRoot, deliverStubScripts } from "./helpers/scenario-stage.js";

// The compaction-restore scenario rides the D2 v1 path: its behaviors live in a
// per-seat launch script declared through env.stub_scripts, which host-mode staging
// delivers into the seat's own cwd. These checks run the REAL scenario file, the REAL
// topology and the REAL shipped script through that staging, so an authoring mistake
// in any of the three fails here rather than as a dead seat on a tmux machine.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SCENARIO_DIR = join(import.meta.dirname, "../../test-system/scenarios");

describe("the compaction-restore scenario's launch script", () => {
  it("loads and validates with env.stub_scripts declared", () => {
    const loaded = loadScenarioFile(join(SCENARIO_DIR, "compaction-restore-resumes-role.yaml"));
    expect(loaded.ok).toBe(true);
  });

  it("stages the topology root and delivers impl's script into impl's own cwd", () => {
    const scenarioPath = join(SCENARIO_DIR, "compaction-restore-resumes-role.yaml");
    const loaded = loadScenarioFile(scenarioPath);
    if (!loaded.ok) throw new Error(`the scenario failed validation: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);

    const stubScripts = extractStubScripts(loaded.loaded.scenario.env);
    expect(Object.keys(stubScripts).sort()).toEqual(["impl"]);

    const dest = mkdtempSync(join(tmpdir(), "compaction-restore-"));
    dirs.push(dest);
    const staged = stageTopologyRoot(loaded.loaded.topologyPath, join(dest, "topology"));
    deliverStubScripts(staged, stubScripts, SCENARIO_DIR);

    const implScript = join(staged.seatCwds["dev-impl"], ".openrig", "stub", "script.json");
    expect(existsSync(implScript)).toBe(true);
    const script = JSON.parse(readFileSync(implScript, "utf-8")) as {
      steps: Array<{ kind: string; behavior?: string; text?: string }>;
    };
    const behaviors = script.steps.filter((s) => s.kind === "emit").map((s) => s.behavior);
    expect(behaviors).toEqual(["compaction", "restore"]);

    // The sibling seat reads no script — 51-01's built-in default applies there.
    expect(existsSync(join(staged.seatCwds["dev-qa"], ".openrig", "stub", "script.json"))).toBe(false);
  });
});
