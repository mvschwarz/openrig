import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { resourceDirectoryName, resourceIdFromDirectoryName } from "../src/domain/resource-directory-name.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { claudeConflictTargetPath } from "../src/domain/projection-planner.js";
import { seatSkillsToKeep, seatSkillReplay } from "../src/domain/seat-skill-storage.js";
import type { SeatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { planCwdPreparation } from "../src/domain/seat-cwd-preparation.js";
import type { ProjectionManifestStore } from "../src/domain/projection-manifest-store.js";

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)).map(file => path.join(entry.name, file)) : [entry.name]);

const superscriptDeviceIds = ["COM", "LPT"].flatMap(prefix => ["\u00b9", "\u00b2", "\u00b3"].flatMap(digit => [prefix + digit, prefix.toLowerCase() + digit + ".txt"]));
it("escapes superscript Win32 device names with or without extensions", () => {
  for (const id of superscriptDeviceIds) {
    const name = resourceDirectoryName(id, "win32");
    expect(name).not.toBe(id);
    expect(resourceIdFromDirectoryName(name, "win32")).toBe(id);
    expect(resourceDirectoryName(id, "linux")).toBe(id);
    expect(resourceDirectoryName(name, "win32")).not.toBe(name);
  }
});

it.runIf(process.platform === "win32")("stores superscript device identities through native resource directories", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "resource-device-"));
  try {
    for (const id of superscriptDeviceIds) {
      const directory = path.join(root, resourceDirectoryName(id)); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "SKILL.md"), id);
      expect(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8")).toBe(id);
    }
    expect(fs.readdirSync(root)).toHaveLength(superscriptDeviceIds.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("keeps qualified and literal escape spellings distinct and leaves POSIX names unchanged", () => {
  const ids = ["shared:skill", "Shared:Skill", "shared:Skill", "shared:Ä", "shared:ä", "shared%3Askill", "shared%253Askill", "skill", "con", "CON", "Con", "NUL.txt", "tail.", "tail ", "a/b", "a\\b", "a?b"];
  const names = ids.map(id => resourceDirectoryName(id, "win32"));
  expect(new Set(names).size).toBe(ids.length);
  expect(new Set(names.map(name => name.toLowerCase())).size).toBe(ids.length);
  names.forEach((name, index) => {
    expect(name).not.toMatch(/[<>:"/\\|?*\x00-\x1f]|[. ]$/);
    expect(resourceIdFromDirectoryName(name, "win32")).toBe(ids[index]);
    expect(resourceDirectoryName(ids[index]!, "linux")).toBe(ids[index]);
  });
});

it.runIf(process.platform === "win32")("round-trips compact single-component names through native files, including all padding lengths", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "resource-compact-"));
  try {
    const ids = [90, 91, 92, 248].map(length => "shared:" + "A".repeat(length));
    ids.push("Shared:" + "A".repeat(90), "shared:" + "Ä".repeat(80), "shared:" + "ä".repeat(80), "shared:" + "中文".repeat(40));
    const names = ids.map(id => resourceDirectoryName(id, "win32"));
    expect(new Set(names.map(name => name.toLowerCase())).size).toBe(ids.length);
    expect(new Set(names.slice(0, 3).map(name => name[2]))).toEqual(new Set(["0", "1", "2"]));
    for (let index = 0; index < ids.length; index++) {
      const name = names[index]!;
      expect(name.length).toBeLessThanOrEqual(255); expect(path.basename(name)).toBe(name);
      expect(name).not.toMatch(/[<>:"/\\|?*\x00-\x1f]|[. ]$/);
      expect(resourceIdFromDirectoryName(name, "win32")).toBe(ids[index]);
      expect(resourceDirectoryName(ids[index]!, "linux")).toBe(ids[index]);
      const directory = path.join(root, name); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "SKILL.md"), ids[index]!);
      expect(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8")).toBe(ids[index]);
    }
    for (const name of ["%_0丂", "%_1丁", "%_2丁", "%_9invalid"]) expect(resourceIdFromDirectoryName(name, "win32")).toBe(name);
    expect(resourceDirectoryName("%_1丂", "win32")).not.toBe("%_1丂");
  } finally { fs.rmSync(root, { recursive: true }); }
});

it.skipIf(process.platform !== "win32").each((["claude-code", "codex", "pi", "omp"] as const).flatMap(runtime => ["short", "long"].map(size => ({ runtime, size }))))(
  "projects and replays a qualified $runtime $size skill under its native target", async ({ runtime, size }) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "qualified-skill-")));
    try {
      const cwd = path.join(root, "repo"), source = path.join(root, "source");
      fs.mkdirSync(cwd); fs.mkdirSync(source); fs.writeFileSync(path.join(source, "SKILL.md"), "# Owned skill\n");
      const fsOps = { exists: fs.existsSync, readFile: (file: string) => fs.readFileSync(file, "utf8"),
        writeFile: (file: string, bytes: string) => fs.writeFileSync(file, bytes), mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
        copyFile: fs.copyFileSync, listFiles: walk, homedir: root };
      const stateRoot = path.join(root, "state");
      const deps = { fsOps, tmux: {} as TmuxAdapter, stateRoot, runnerEntryPath: path.join(root, "unused-runner.js") };
      const adapter = runtime === "claude-code" ? new ClaudeCodeAdapter(deps) : runtime === "codex" ? new CodexRuntimeAdapter(deps)
        : runtime === "pi" ? new PiRuntimeAdapter(deps) : new OmpRuntimeAdapter(deps);
      const id = size === "long" ? "shared:" + "A".repeat(90) : "shared:skill";
      const entry = { category: "skill" as const, effectiveId: id, sourceSpec: "shared", sourcePath: root,
        resourcePath: "source", absolutePath: source, classification: "safe_projection" as const };
      const result = await adapter.project({ runtime, cwd, entries: [entry], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        { cwd, tmuxSession: "owned@fixture" } as NodeBinding);
      expect(result.failed).toEqual([]); expect(result.projected).toEqual([id]);
      const skillsRoot = runtime === "claude-code" ? path.join(cwd, ".claude", "skills") : runtime === "codex" ? path.join(cwd, ".agents", "skills")
        : path.join(piSeatPaths(stateRoot, "owned@fixture").agentDir, "skills");
      const directory = size === "long" ? resourceDirectoryName(id) : "shared%3Askill";
      expect(path.basename(directory)).toBe(directory);
      const target = path.join(skillsRoot, directory, "SKILL.md");
      expect(fs.readFileSync(target, "utf8")).toBe("# Owned skill\n");
      expect(await adapter.listInstalled({ cwd, tmuxSession: "owned@fixture" } as NodeBinding))
        .toContainEqual(expect.objectContaining({ effectiveId: id, installedPath: path.dirname(target) }));
      if (runtime === "claude-code") expect(claudeConflictTargetPath("skill", id, cwd)).toBe(target);
      if (runtime === "pi" || runtime === "omp") expect(adapter.skillTargetPath!("owned@fixture", id)).toBe(target);
      fs.writeFileSync(target, "# Operator edit\n");
      const kept = seatSkillsToKeep([entry], { skillsRoot } as SeatSkillPaths);
      expect([...kept.keep]).toEqual([id]); expect(kept.warnings).toHaveLength(1);
      expect(fs.readFileSync(target, "utf8")).toBe("# Operator edit\n");
      const preparation = planCwdPreparation({ runtime, cwd, entries: [entry], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        [], { cwd, tmuxSession: "owned@fixture" } as NodeBinding, adapter, { lastHash: () => undefined } as unknown as ProjectionManifestStore);
      expect(preparation.conflicts).toContainEqual(expect.objectContaining({ targetPath: target }));
      fs.unlinkSync(target);
      const replay = seatSkillReplay({ entries: [entry], files: [], paths: { skillsRoot } as SeatSkillPaths,
        rehydration: { missing: [target], refused: [] } });
      expect([...replay.skipEntryIds]).toEqual([id]);
      expect(fs.existsSync(target)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  },
);

it.skipIf(process.platform !== "win32").each((["claude-code", "codex"] as const).flatMap(runtime => ["short", "long"].map(size => ({ runtime, size }))))(
  "projects a qualified $runtime $size plugin without an invalid NTFS component", async ({ runtime, size }) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "qualified-projection-")));
    try {
      const cwd = path.join(root, "repo"), source = path.join(root, "source");
      fs.mkdirSync(cwd); fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "payload.txt"), "owned plugin bytes");
      const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
      git("init", "-q");
      git("config", "core.quotepath", "false");
      const fsOps = { exists: fs.existsSync, readFile: (file: string) => fs.readFileSync(file, "utf8"),
        writeFile: (file: string, bytes: string) => fs.writeFileSync(file, bytes), mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
        copyFile: fs.copyFileSync, listFiles: walk, homedir: root };
      const adapter = runtime === "codex" ? new CodexRuntimeAdapter({ fsOps, tmux: {} as TmuxAdapter })
        : new ClaudeCodeAdapter({ fsOps, tmux: {} as TmuxAdapter });
      const id = size === "long" ? "shared:" + "A".repeat(90) : "shared:openrig-core";
      const result = await adapter.project({ runtime, cwd, entries: [{ category: "plugin", effectiveId: id,
        sourceSpec: "shared", sourcePath: root, resourcePath: "source", absolutePath: source, classification: "safe_projection",
        pluginType: runtime === "codex" ? "codex" : "claude" }], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      { cwd } as NodeBinding);
      expect(result.failed).toEqual([]);
      expect(result.projected).toEqual([id]);
      const relative = `${runtime === "codex" ? ".codex" : ".claude"}/plugins/${size === "long" ? resourceDirectoryName(id) : "shared%3Aopenrig-core"}/payload.txt`;
      expect(fs.readFileSync(path.join(cwd, relative), "utf8")).toBe("owned plugin bytes");
      // Automatic Git exclusion is specific to the shipped core plugin; the
      // long arbitrary plugin above must not broaden that ownership rule.
      if (runtime === "codex" && size === "short") expect(git("check-ignore", "--", relative).trim()).toBe(relative);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  },
);
