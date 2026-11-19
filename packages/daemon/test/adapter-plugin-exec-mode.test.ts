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
import { OmpTuiRuntimeAdapter } from "../src/adapters/omp-tui-runtime-adapter.js";
import { OmpSeatLauncher } from "../src/adapters/omp-seat-launch.js";
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
  fs.mkdirSync(nodePath.join(root, "openrig-core", "hooks"), { recursive: true });
  fs.writeFileSync(nodePath.join(root, "openrig-core", "hooks", "hooks.json"), JSON.stringify({
    hooks: { PreCompact: [{ hooks: [{ type: "command", command: '"$PLUGIN_ROOT/skills/compaction-restore/scripts/precompact-hook.mjs"' }] }] },
  }));
  const hook = nodePath.join(skillDir, "scripts", "precompact-hook.mjs");
  const skillMd = nodePath.join(skillDir, "SKILL.md");
  fs.writeFileSync(hook, "#!/usr/bin/env node\nconsole.log('hook');\n");
  fs.writeFileSync(skillMd, "# compaction-restore\n");
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(skillMd, 0o644);
  fs.writeFileSync(nodePath.join(root, "openrig-core", "package.json"), JSON.stringify({ omp: { extensions: ["./index.js"] } }));
  fs.writeFileSync(nodePath.join(root, "openrig-core", "index.js"), "export default function activate() {}");
  return { hookRel: "skills/compaction-restore/scripts/precompact-hook.mjs", skillRel: "skills/compaction-restore/SKILL.md" };
}

function perm(p: string): number { return fs.statSync(p).mode & 0o777; }

describe.each(["claude-code", "codex", "omp-tui"] as const)("%s plugin projection preserves executable mode", runtime => {
  it.each([false, true])("preserves executable helpers and non-executable files, existing copy=%s", async existing => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), `execmode-${runtime}-`));
    try {
      const src = nodePath.join(base, "src");
      const rel = seedPluginTree(src);
      const cwd = nodePath.join(base, "cwd");
      const ops = realFsOps();
      const tmux = mockTmux();
      const launcher = new OmpSeatLauncher({ tmux, fsOps: ops, stateRoot: nodePath.join(base, "omp-state"), seatExtensionPath: "/assets/omp/openrig-seat.js" });
      const adapter = runtime === "claude-code"
        ? new ClaudeCodeAdapter({ tmux, fsOps: ops as unknown as ClaudeAdapterFsOps })
        : runtime === "codex"
          ? new CodexRuntimeAdapter({ tmux, fsOps: ops as unknown as CodexAdapterFsOps })
          : new OmpTuiRuntimeAdapter({ tmux, fsOps: ops, launcher });
      const root = runtime === "omp-tui" ? nodePath.join(launcher.paths("test").pluginsDir, "openrig-core")
        : nodePath.join(cwd, runtime === "codex" ? ".codex" : ".claude", "plugins/openrig-core");
      const outHook = nodePath.join(root, rel.hookRel);
      const outSkill = nodePath.join(root, rel.skillRel);
      if (existing) {
        fs.mkdirSync(nodePath.dirname(outHook), { recursive: true });
        fs.copyFileSync(nodePath.join(src, "openrig-core", rel.hookRel), outHook);
        fs.chmodSync(outHook, 0o644);
      }
      const result = await adapter.project({ ...makePlan(nodePath.join(src, "openrig-core")), runtime }, makeBinding(cwd));
      expect(result.failed).toEqual([]);
      expect(perm(outHook)).toBe(0o755);
      expect(perm(outSkill)).toBe(0o644);
      expect(fs.readFileSync(outHook, "utf8")).toBe(fs.readFileSync(nodePath.join(src, "openrig-core", rel.hookRel), "utf8"));
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});
