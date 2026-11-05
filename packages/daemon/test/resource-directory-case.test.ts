import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resourceDirectoryName, resourceDirectoryPath, resourceIdFromDirectoryName } from "../src/domain/resource-directory-name.js";
import { seatSkillReplay, seatSkillsToKeep, type SeatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { claudeConflictTargetPath } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resource-case-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("keeps fresh ordinary ASCII and Unicode case identities distinct", () => {
  const ids = ["Skill", "skill", "SKILL", "\u00c4", "\u00e4", "\u017f", "s", "%53kill", "%73kill"];
  const names = ids.map(id => resourceDirectoryName(id, "win32"));
  expect(new Set(names.map(name => name.toUpperCase())).size).toBe(ids.length);
  for (let index = 0; index < ids.length; index++) {
    expect(resourceIdFromDirectoryName(names[index]!, "win32")).toBe(ids[index]);
    expect(resourceDirectoryName(ids[index]!, "linux")).toBe(ids[index]);
  }
});
function checkLegacyPair(legacy: string, next: string) {
  const dir = root(), old = path.join(dir, legacy); fs.mkdirSync(old); fs.writeFileSync(path.join(old, "SKILL.md"), "operator edit");
  expect(resourceDirectoryPath(dir, legacy, "win32")).toBe(old);
  const selected = resourceDirectoryPath(dir, next, "win32");
  expect(path.basename(selected).toUpperCase()).not.toBe(legacy.toUpperCase());
  expect(path.basename(selected).length).toBeLessThanOrEqual(255);
  expect(resourceIdFromDirectoryName(path.basename(selected), "win32")).toBe(next);
  fs.mkdirSync(selected); fs.writeFileSync(path.join(selected, "SKILL.md"), "new identity");
  expect(resourceDirectoryPath(dir, next, "win32")).toBe(selected);
  expect(fs.readFileSync(path.join(old, "SKILL.md"), "utf8")).toBe("operator edit");
}
it.each([["Skill", "skill"], ["\u017f", "s"]])("preserves legacy %s and gives %s a stable, reversible non-aliasing directory", checkLegacyPair);
it.runIf(process.platform === "win32")("creates a native compact alias beside a legacy 255-character component", () => {
  checkLegacyPair("A" + "a".repeat(254), "a".repeat(255));
});
it("computes a reversible Windows compact alias for a 255-byte POSIX identity", () => {
  const dir = root(), old = path.join(dir, "A" + "a".repeat(254)); fs.mkdirSync(old);
  const selected = path.basename(resourceDirectoryPath(dir, "a".repeat(255), "win32"));
  expect(selected.length).toBeLessThanOrEqual(255);
  expect(resourceIdFromDirectoryName(selected, "win32")).toBe("a".repeat(255));
});
it("refuses duplicate spellings of one identity without changing either", () => {
  const dir = root(); for (const name of ["Skill", "%53kill"]) fs.mkdirSync(path.join(dir, name));
  expect(() => resourceDirectoryPath(dir, "Skill", "win32")).toThrow(/Ambiguous resource directories/);
  expect(fs.readdirSync(dir).sort()).toEqual(["%53kill", "Skill"]);
});
it("does not adopt a legacy file as a directory", () => {
  const dir = root(); fs.writeFileSync(path.join(dir, "Skill"), "keep");
  expect(() => resourceDirectoryPath(dir, "Skill", "win32")).toThrow(/not an ordinary directory/);
  expect(fs.readFileSync(path.join(dir, "Skill"), "utf8")).toBe("keep");
});
it("does not adopt a legacy linked directory or modify its referent", () => {
  const dir = root(), referent = root(); fs.writeFileSync(path.join(referent, "SKILL.md"), "keep referent");
  fs.symlinkSync(referent, path.join(dir, "Skill"), process.platform === "win32" ? "junction" : "dir");
  expect(() => resourceDirectoryPath(dir, "Skill", "win32")).toThrow(/not an ordinary directory/);
  expect(fs.readFileSync(path.join(referent, "SKILL.md"), "utf8")).toBe("keep referent");
});

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? walk(path.join(dir, entry.name)).map(file => path.join(entry.name, file)) : [entry.name]);
it.skipIf(process.platform !== "win32").each(["claude-code", "codex", "pi", "omp"] as const)("projects case-distinct resources and retains edited legacy %s skills through replay", async runtime => {
  const dir = root(), cwd = path.join(dir, "repo"), source = path.join(dir, "source"), stateRoot = path.join(dir, "state");
  fs.mkdirSync(cwd); fs.mkdirSync(source); fs.writeFileSync(path.join(source, "SKILL.md"), "source bytes");
  const fsOps = { exists: fs.existsSync, readFile: (file: string) => fs.readFileSync(file, "utf8"), writeFile: (file: string, text: string) => fs.writeFileSync(file, text),
    mkdirp: (file: string) => fs.mkdirSync(file, { recursive: true }), copyFile: fs.copyFileSync, listFiles: walk, homedir: dir };
  const deps = { fsOps, tmux: {} as TmuxAdapter, stateRoot, runnerEntryPath: path.join(dir, "unused.js") };
  const adapter = runtime === "claude-code" ? new ClaudeCodeAdapter(deps) : runtime === "codex" ? new CodexRuntimeAdapter(deps)
    : runtime === "pi" ? new PiRuntimeAdapter(deps) : new OmpRuntimeAdapter(deps);
  const binding = { cwd, tmuxSession: "owned@case" } as NodeBinding;
  const skillsRoot = runtime === "claude-code" ? path.join(cwd, ".claude", "skills") : runtime === "codex" ? path.join(cwd, ".agents", "skills")
    : path.join(piSeatPaths(stateRoot, binding.tmuxSession).agentDir, "skills");
  const legacy = path.join(skillsRoot, "Skill"); fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, "SKILL.md"), "operator edit");
  const entry = (id: string) => ({ category: "skill" as const, effectiveId: id, sourceSpec: "owned", sourcePath: dir, resourcePath: "source", absolutePath: source, classification: "safe_projection" as const });
  const kept = seatSkillsToKeep([entry("Skill")], { skillsRoot } as SeatSkillPaths);
  expect([...kept.keep]).toEqual(["Skill"]); expect(kept.warnings).toHaveLength(1);
  if (runtime === "claude-code") expect(claudeConflictTargetPath("skill", "Skill", cwd)).toBe(path.join(legacy, "SKILL.md"));
  const ids = ["skill", "\u00c4", "\u00e4"];
  const projected = await adapter.project({ runtime, cwd, entries: ids.map(entry), startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }, binding);
  expect(projected.failed).toEqual([]); expect(projected.projected).toEqual(ids);
  const installed = await adapter.listInstalled(binding);
  for (const id of ["Skill", ...ids]) {
    const selected = resourceDirectoryPath(skillsRoot, id);
    expect(installed).toContainEqual(expect.objectContaining({ effectiveId: id, installedPath: selected }));
    expect(fs.readFileSync(path.join(selected, "SKILL.md"), "utf8")).toBe(id === "Skill" ? "operator edit" : "source bytes");
    if (runtime === "pi" || runtime === "omp") expect(adapter.skillTargetPath!(binding.tmuxSession, id)).toBe(path.join(selected, "SKILL.md"));
  }
  const oldFile = path.join(legacy, "SKILL.md"); fs.rmSync(legacy, { recursive: true });
  const replay = seatSkillReplay({ entries: [entry("Skill"), entry("skill")], files: [], paths: { skillsRoot } as SeatSkillPaths, rehydration: { missing: [oldFile], refused: [] } });
  expect(replay.skipEntryIds.has("Skill")).toBe(true); expect(replay.skipEntryIds.has("skill")).toBe(true);
  expect(fs.existsSync(path.join(skillsRoot, resourceDirectoryName("Skill")))).toBe(false);
});
