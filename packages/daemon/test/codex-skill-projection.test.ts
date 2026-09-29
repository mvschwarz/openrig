import fs from "node:fs";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { hashContent } from "../src/domain/conflict-detector.js";
import { claudeConflictTargetPath, planProjection, projectionConflictWarnings, type ProjectionInput, type ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const sourceFile = "/fixture/shared/skills/shared-skill/SKILL.md";
const claudeFile = "/fixture/project/.claude/skills/shared-skill/SKILL.md";
const codexFile = "/fixture/project/.agents/skills/shared-skill/SKILL.md";
const sourceText = "# Shared skill\nRead the project context.\n";
const editedText = "# Operator edit\nKeep this local change.\n";

// Execute the production planning block without constructing an instantiator,
// opening a database or launching a seat. Unlike a copied resolver, this also
// catches a wiring change that sends the wrong plan to the adapter.
const instantiator = fs.readFileSync(new URL("../src/domain/rigspec-instantiator.ts", import.meta.url), "utf8");
const start = instantiator.indexOf("    const planResult = planProjection({");
const end = instantiator.indexOf("    const resolvedFiles = this.buildResolvedStartupFiles(", start);
if (start < 0 || end < start) throw new Error("Production projection planning block not found");
const buildPlan = new Function(
  "planProjection", "claudeConflictTargetPath", "projectionConflictWarnings", "nodePath",
  "input", "configResult", "resolveResult", "projectionManifest", "launchResult", "canonicalSessionName",
  instantiator.slice(start, end) + "\nreturn planResult.plan;",
);

function fixture(target: "absent" | "identical" | "edited", runtime = "codex", force = false) {
  const files = new Map([[sourceFile, sourceText], [claudeFile, sourceText]]);
  if (target !== "absent") files.set(codexFile, target === "identical" ? sourceText : editedText);
  const writes: string[] = [];
  const fsOps = {
    exists: (path: string) => files.has(path),
    readFile: (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`Unexpected virtual read: ${path}`);
      return text;
    },
    writeFile: (path: string, text: string) => {
      if (path !== codexFile) throw new Error(`Unexpected virtual write: ${path}`);
      writes.push(path);
      files.set(path, text);
    },
    mkdirp: (path: string) => {
      if (!path.startsWith("/fixture/project/.agents/skills/")) throw new Error(`Unexpected virtual directory: ${path}`);
    },
    listFiles: (path: string) => path === nodePath.dirname(sourceFile) ? ["SKILL.md"] : [],
  };
  const config: ProjectionInput["config"] = {
    runtime, cwd: "/fixture/project", restorePolicy: "resume_if_possible",
    selectedResources: {
      skills: [{ effectiveId: "shared-skill", sourceSpec: "shared", sourcePath: "/fixture/shared", resource: { id: "shared-skill", path: "skills/shared-skill" } }],
      guidance: [], subagents: [], plugins: [], runtimeResources: [],
    },
    startup: { files: [], actions: [] }, resolvedSpecName: "qa", resolvedSpecVersion: "1.0", resolvedSpecHash: "fixture",
  };
  let resolveTargetPath: NonNullable<ProjectionInput["resolveTargetPath"]>;
  const plan: ProjectionPlan = buildPlan.call(
    { deps: { fsOps, rigRepo: { getRigClaudeManagedBlockFile: () => "CLAUDE.local.md" } } },
    (input: ProjectionInput) => { resolveTargetPath = input.resolveTargetPath!; return planProjection(input); },
    claudeConflictTargetPath, projectionConflictWarnings, nodePath,
    { member: { runtime }, rigId: "fixture", force }, { config }, { collisions: [] },
    { lastHash: (path: string) => path === codexFile ? hashContent(sourceText) : null },
    { warnings: [] }, "dev-check@fixture",
  );
  const adapter = new CodexRuntimeAdapter({
    fsOps,
    tmux: new Proxy({}, { get() { throw new Error("No tmux calls allowed"); } }) as never,
    listProcesses: () => { throw new Error("No process survey allowed"); },
  });
  const binding: NodeBinding = {
    id: "binding", nodeId: "node", tmuxSession: null, tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: config.cwd,
  };
  return { files, writes, plan, resolveTargetPath: resolveTargetPath!, project: () => adapter.project(plan, binding) };
}

describe("Codex skill projection in a shared project", () => {
  it("writes the missing Codex skill when the Claude copy is already identical", async () => {
    const f = fixture("absent");
    expect(await f.project()).toEqual({ projected: ["shared-skill"], skipped: [], failed: [] });
    expect(f.files.get(codexFile)).toBe(sourceText);
    expect(f.files.get(claudeFile)).toBe(sourceText);
    expect(f.writes).toEqual([codexFile]);
  });

  it.each(["codex", "claude-code"])("keeps an identical %s target a no-op", async runtime => {
    const f = fixture("identical", runtime);
    expect(f.plan.noOps.map(entry => entry.effectiveId)).toEqual(["shared-skill"]);
    if (runtime === "codex") expect(await f.project()).toEqual({ projected: [], skipped: ["shared-skill"], failed: [] });
    expect(f.writes).toEqual([]);
  });

  it("preserves the operator's Codex edit and retains its conflict diagnostic", async () => {
    const f = fixture("edited");
    expect(f.plan.conflicts[0]?.classification).toBe("operator_conflict");
    expect((await f.project()).failed).toEqual([]);
    expect(f.files.get(codexFile)).toBe(editedText);
    expect(f.files.get(claudeFile)).toBe(sourceText);
    expect(f.writes).toEqual([]);
  });

  it("allows the existing explicit force option to replace the Codex edit", async () => {
    const f = fixture("edited", "codex", true);
    expect((await f.project()).projected).toEqual(["shared-skill"]);
    expect(f.files.get(codexFile)).toBe(sourceText);
    expect(f.files.get(claudeFile)).toBe(sourceText);
  });

  it.each(["codex", "claude-code", "pi", "terminal"])("preserves other conflict targets for %s", runtime => {
    const f = fixture("absent", runtime);
    for (const category of ["skill", "guidance", "subagent", "plugin", "runtime_resource"]) {
      if (runtime === "codex" && category === "skill") continue;
      const args = [category, "other", "/fixture/project", "/fixture/agents/reviewer.md"] as const;
      expect(f.resolveTargetPath(...args)).toBe(claudeConflictTargetPath(...args, runtime === "claude-code" ? "CLAUDE.local.md" : undefined));
    }
  });
});
