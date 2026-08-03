// OPR skills-vendoring exec-mode QA-blocker (candidate 4c6d8883): CWD plugin
// projection dropped executable mode — real default-profile materialization wrote
// 0755 helper scripts (e.g. claude-compaction-restore/scripts/*.mjs) as 0644 because
// both adapters project via text readFile -> writeFile (writeFileSync utf-8), which
// creates dest files with the process default mode and never reapplies the source mode.
//
// These are REAL-fs pins (actual 0755 exec helper + 0644 non-exec neighbor) exercising
// the same fsOps shape production wires in startup.ts, plus a statMode/chmod pair. They
// cover the fresh-write path AND the content-identical idempotence-skip path (the QA repro
// re-materializes an already-present tree, so mode must be reconciled even when content
// is byte-identical and the write is skipped).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

function mockTmux() {
  return {
    sessionExists: async () => true, sendKeys: async () => undefined,
    capturePaneContent: async () => "", getPaneCommand: async () => "",
    listSessions: async () => [], runCommandInSession: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: async () => undefined,
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
}

// Real-fs ops mirroring startup.ts, PLUS statMode/chmod (the mode-preserving primitives).
function realFsOps() {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    listFiles: (dir: string) => {
      const r: string[] = [];
      const walk = (d: string, pre: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(nodePath.join(d, e.name), nodePath.join(pre, e.name));
          else r.push(pre ? nodePath.join(pre, e.name) : e.name);
        }
      };
      walk(dir, "");
      return r;
    },
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, mode: number) => fs.chmodSync(p, mode),
  };
}

function makeBinding(cwd: string): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makePlan(absolutePath: string): ProjectionPlan {
  const entry: ProjectionEntry = {
    category: "plugin", effectiveId: "openrig-core", sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec", resourcePath: absolutePath, absolutePath,
    classification: "safe_projection",
  };
  return { runtime: "claude-code", cwd: "/cwd", entries: [entry], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

// Build a real plugin source tree: an executable nested helper (0755) + a non-exec neighbor (0644).
function seedPluginTree(root: string) {
  const skillDir = nodePath.join(root, "openrig-core", "skills", "compaction-restore");
  fs.mkdirSync(nodePath.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, "openrig-core", ".claude-plugin"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, "openrig-core", ".codex-plugin"), { recursive: true });
  fs.writeFileSync(nodePath.join(root, "openrig-core", ".claude-plugin", "plugin.json"), "{}");
  fs.writeFileSync(nodePath.join(root, "openrig-core", ".codex-plugin", "plugin.json"), "{}");
  const hook = nodePath.join(skillDir, "scripts", "precompact-hook.mjs");
  const skillMd = nodePath.join(skillDir, "SKILL.md");
  fs.writeFileSync(hook, "#!/usr/bin/env node\nconsole.log('hook');\n");
  fs.writeFileSync(skillMd, "# compaction-restore\n");
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(skillMd, 0o644);
  return { hookRel: "skills/compaction-restore/scripts/precompact-hook.mjs", skillRel: "skills/compaction-restore/SKILL.md" };
}

function perm(p: string): number { return fs.statSync(p).mode & 0o777; }

describe("CWD plugin projection preserves executable mode (skills-vendoring QA blocker)", () => {
  it("Claude: nested exec helper keeps 0755, non-exec neighbor stays 0644", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-claude-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as unknown as ClaudeAdapterFsOps });

    await adapter.project(makePlan(nodePath.join(src, "openrig-core")), makeBinding(cwd));

    const outHook = nodePath.join(cwd, ".claude/plugins/openrig-core", rel.hookRel);
    const outSkill = nodePath.join(cwd, ".claude/plugins/openrig-core", rel.skillRel);
    expect(fs.existsSync(outHook)).toBe(true);
    expect(perm(outHook)).toBe(0o755);
    expect(perm(outSkill)).toBe(0o644);
  });

  it("Codex: nested exec helper keeps 0755, non-exec neighbor stays 0644", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-codex-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as unknown as CodexAdapterFsOps });

    await adapter.project(makePlan(nodePath.join(src, "openrig-core")), makeBinding(cwd));

    const outHook = nodePath.join(cwd, ".codex/plugins/openrig-core", rel.hookRel);
    const outSkill = nodePath.join(cwd, ".codex/plugins/openrig-core", rel.skillRel);
    expect(fs.existsSync(outHook)).toBe(true);
    expect(perm(outHook)).toBe(0o755);
    expect(perm(outSkill)).toBe(0o644);
  });

  it("Claude: re-projection reconciles mode even when content is byte-identical (idempotence-skip path)", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-claude-idem-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as unknown as ClaudeAdapterFsOps });

    // Pre-place a byte-identical projected helper with the WRONG (0644) mode — the exact QA state.
    const outHook = nodePath.join(cwd, ".claude/plugins/openrig-core", rel.hookRel);
    fs.mkdirSync(nodePath.dirname(outHook), { recursive: true });
    fs.copyFileSync(nodePath.join(src, "openrig-core", rel.hookRel), outHook);
    fs.chmodSync(outHook, 0o644);
    expect(perm(outHook)).toBe(0o644);

    await adapter.project(makePlan(nodePath.join(src, "openrig-core")), makeBinding(cwd));

    // Content unchanged (write skipped) but mode must be reconciled to the source 0755.
    expect(perm(outHook)).toBe(0o755);
  });
});
