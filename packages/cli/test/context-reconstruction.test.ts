import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import { resolveWorkContextHome } from "../src/lib/work-install.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/reconstruction-v0.json", import.meta.url), "utf8")) as {
  base: { id: string }; sourceStore: string;
};

describe("rig context reconstruction", () => {
  let root: string, catalog: string, alpha: string, beta: string, home: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "context-reconstruction-")));
    catalog = join(root, "catalog"); alpha = join(root, "alpha"); beta = join(root, "beta"); home = join(root, "instance");
    for (const path of [catalog, alpha, beta, home]) mkdirSync(path);
    for (const [id, path] of [["alpha", alpha], ["beta", beta]]) {
      const mission = join(path!, "workplans", "same-task");
      mkdirSync(join(mission, "slices", "01-example", "reconstructions"), { recursive: true });
      writeFileSync(join(path!, "project.yaml"), `schema: openrig.project/v0alpha1\nkind: project\nid: ${id}\nmissions: {root: workplans}\n`);
      writeFileSync(join(mission, "slices", "01-example", "SPEC.md"), "---\nid: OPR.99.0.1\n---\nExample slice\n");
      writeFileSync(join(mission, "slices", "01-example", "reconstructions", `${fixture.base.id}.json`), JSON.stringify(fixture.base));
    }
    writeFileSync(join(catalog, "workspace.yaml"), `schema: openrig.workspace/v0alpha1\nprojects:\n  - id: alpha\n    root: ${relative(catalog, alpha)}\n    rigs: [example-rig]\n  - id: beta\n    root: ${relative(catalog, beta)}\n    rigs: [other-rig]\n`);
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_WORKSPACE_ROOT", catalog);
    vi.stubEnv("OPENRIG_WORKSPACE_CATALOG_PATH", join(catalog, "workspace.yaml"));
    vi.stubEnv("OPENRIG_SESSION_NAME", ""); vi.stubEnv("RIGGED_SESSION_NAME", "");
    // If this local command accidentally contacts the daemon, fail in the test.
    vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("local reconstruction must not fetch"); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  async function run(args: string[]) {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const saved = process.exitCode; process.exitCode = undefined;
    try {
      const command = new Command().exitOverride(); command.addCommand(contextCommand());
      await command.parseAsync(["node", "rig", "context", "reconstruction", ...args]);
      return { output: log.mock.calls.map(call => call.join(" ")).join("\n"), errors: error.mock.calls, exitCode: process.exitCode };
    } finally { process.exitCode = saved; log.mockRestore(); error.mockRestore(); }
  }

  it("resolves a catalog project, custom missions root and slice ID without writing or installing context", async () => {
    const result = await run(["inspect", fixture.base.id, "--project", "beta", "--mission", "same-task", "--slice", "OPR.99.0.1"]);
    const data = JSON.parse(result.output);
    expect(result.exitCode).toBeUndefined();
    expect(data.complete).toBe(true);
    expect(data.resolution.projectId).toBe("beta");
    expect(data.resolution.home).toBe(join(beta, "workplans", "same-task", "slices", "01-example"));
    expect(data.requestedStore).toBe(join(data.resolution.home, "reconstructions"));
    expect(data.nodes[0].sourceManifest).toHaveLength(2);
    expect(data.nodes[0].items).toBeUndefined();
    expect(readdirSync(home)).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses shared cwd/rig inference rather than choosing another project's same mission", () => {
    const common = { workspaceRoot: catalog, catalogPath: join(catalog, "workspace.yaml"), mission: "same-task" };
    expect(resolveWorkContextHome({ ...common, cwd: join(beta, "workplans") })).toMatchObject({ projectId: "beta", selectedBy: "cwd" });
    expect(resolveWorkContextHome({ ...common, sessionName: "agent@example-rig", cwd: beta })).toMatchObject({ projectId: "alpha", selectedBy: "rig" });
    expect(resolveWorkContextHome({ ...common, cwd: root })).toMatchObject({ error: { code: "project_required" } });
  });

  it("reads an explicit imported store even when the workspace configuration is unavailable", async () => {
    vi.stubEnv("OPENRIG_WORKSPACE_ROOT", join(root, "missing"));
    const store = join(alpha, "workplans", "same-task", "slices", "01-example", "reconstructions");
    const result = await run(["view", fixture.base.id, "--store", store, "--item", "decision", "--json"]);
    const data = JSON.parse(result.output);
    expect(data.complete).toBe(true);
    expect(data.resolution.mode).toBe("explicit-store");
    expect(data.nodes[0].items.map((v: { id: string }) => v.id)).toEqual(["decision", "dependency", "constraint", "gap", "authority"]);
    expect(data.nodes[0].viewCoverage.omittedIds).toEqual(["remove", "tagged", "omitted"]);
    expect(readdirSync(home)).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns structured failures and nonzero status for missing context, invalid bounds or ambiguous projects", async () => {
    const ambiguous = await run(["inspect", fixture.base.id, "--cwd", root]);
    expect(ambiguous.exitCode).toBe(1); expect(JSON.parse(ambiguous.output).error.code).toBe("project_required");
    const unavailable = await run(["inspect", "b".repeat(64), "--store", root]);
    expect(unavailable.exitCode).toBe(1); expect(JSON.parse(unavailable.output).complete).toBe(false);
    const bound = await run(["view", fixture.base.id, "--store", root, "--max-bytes", "NaN", "--json"]);
    expect(bound.exitCode).toBe(1); expect(JSON.parse(bound.output).error.message).toContain("max-bytes");
  });

  it("rejects paths escaping the selected mission and invalid mission composition", () => {
    const opts = { workspaceRoot: catalog, project: "alpha", mission: "same-task" };
    expect(resolveWorkContextHome({ ...opts, mission: "../beta" })).toMatchObject({ error: { code: "invalid_mission" } });
    expect(resolveWorkContextHome({ ...opts, slice: "../other" })).toMatchObject({ error: { code: "invalid_slice" } });
    symlinkSync(beta, join(alpha, "workplans", "same-task", "slices", "outside"));
    expect(resolveWorkContextHome({ ...opts, slice: "outside" })).toMatchObject({ error: { code: "slice_root_escape" } });
    writeFileSync(join(alpha, "workplans", "same-task", "mission.yaml"), "composition: {slices: not-a-list}\n");
    expect(resolveWorkContextHome({ ...opts, slice: "01-example" })).toMatchObject({ error: { code: "mission_composition_invalid" } });
  });
});
