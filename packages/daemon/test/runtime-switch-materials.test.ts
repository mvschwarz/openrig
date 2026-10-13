import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { planRuntimeSwitchMaterials } from "../src/domain/runtime-switch-materials.js";
import { claudeConflictTargetPath } from "../src/domain/projection-planner.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ParsedStartupContext } from "../src/domain/seat-lifecycle-service.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

describe("runtime-switch target materials", () => {
  function fixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-materials-")));
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    cleanup.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const repo = new RigRepository(db), rig = repo.createRig("kernel");
    const source = fileURLToPath(new URL("../specs/rigs/launch/kernel/agents/operator/agent", import.meta.url));
    const node = { ...repo.addNode(rig.id, "operator.agent", { runtime: "codex", cwd: root }),
      agentRef: `path:${source}`, resolvedSpecName: "operator.agent", profile: "default" };
    const culture = path.join(root, "culture.md"); fs.writeFileSync(culture, "# Team culture\nKeep the durable queue current.\n");
    const saved: ParsedStartupContext = { runtime: "codex", hash: "saved-context",
      plan: { runtime: "codex", cwd: root, entries: [], conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] } },
      resolvedStartupFiles: [
        { path: "guidance/role.md", absolutePath: path.join(source, "guidance/role.md"), ownerRoot: source, orientation: "role", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] },
        { path: "culture.md", absolutePath: culture, ownerRoot: root, deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] },
      ], startupActions: [] };
    const input = { db, node, rigName: "kernel", session: "operator-agent@kernel", saved,
      materialContext: { homedir: root, skillsRoot: path.join(root, "managed-skills"), systemSkills: [] } };
    const writable = (file: string) => { expect(path.relative(root, file)).not.toMatch(/^\.\.(?:[/\\]|$)/); };
    const fsOps = { homedir: root, exists: fs.existsSync, readFile: (file: string) => fs.readFileSync(file, "utf8"),
      writeFile: (file: string, text: string) => { writable(file); fs.writeFileSync(file, text); },
      mkdirp: (dir: string) => { writable(dir); fs.mkdirSync(dir, { recursive: true }); },
      copyFile: (from: string, to: string) => { writable(to); fs.copyFileSync(from, to); },
      listFiles: (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name))) };
    const binding: NodeBinding = { id: "binding", nodeId: node.id, cwd: root, tmuxSession: "openrig-switch-fixture", tmuxPane: "%2",
      tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", launchGeneration: "reserved" };
    return { root, source, saved, input, fsOps, binding };
  }

  it.each(["claude-code", "codex"] as const)("re-resolves the shipped kernel AgentSpec and projects actual %s materials", async runtime => {
    const f = fixture();
    // First save the source-runtime projection. It deliberately lacks the
    // target's runtime resources; merely relabelling it would fail this test.
    const from = runtime === "codex" ? "claude-code" : "codex";
    f.saved.plan = planRuntimeSwitchMaterials({ ...f.input, runtime: from }).plan;
    const target = planRuntimeSwitchMaterials({ ...f.input, runtime });
    const expectedType = runtime === "codex" ? "codex_config_fragment" : "claude_activity_hooks";
    expect(f.saved.plan.entries.some(entry => entry.resourceType === expectedType)).toBe(false);
    expect(target.plan.entries.some(entry => entry.resourceType === expectedType)).toBe(true);
    expect(target.context).toContain(fs.readFileSync(path.join(f.source, "guidance/role.md"), "utf8"));
    expect(target.files[0]!.orientation).toBe("role");
    const adapter = runtime === "codex" ? new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps: f.fsOps })
      : new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps: f.fsOps });
    await target.prepare(f.binding, adapter);
    expect(fs.readFileSync(path.join(f.root, runtime === "codex" ? "AGENTS.md" : "CLAUDE.md"), "utf8")).toContain("Keep the durable queue current");
    if (runtime === "claude-code") {
      expect(fs.existsSync(path.join(f.root, ".claude.json"))).toBe(true);
      expect(fs.existsSync(path.join(f.root, ".claude", "settings.local.json"))).toBe(true);
    } else expect(fs.existsSync(path.join(f.root, ".codex", "config.toml"))).toBe(true);
  });

  it("refuses an edited target skill before projection", () => {
    const f = fixture();
    const target = planRuntimeSwitchMaterials({ ...f.input, runtime: "claude-code" });
    const skill = target.plan.entries.find(entry => entry.category === "skill")!;
    expect(skill).toBeDefined();
    const file = claudeConflictTargetPath("skill", skill.effectiveId, f.root, skill.absolutePath)!;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "# Operator-owned skill\nPreserve my changes.\n");
    expect(() => planRuntimeSwitchMaterials({ ...f.input, runtime: "claude-code" })).toThrow(/conflict/i);
    expect(fs.readFileSync(file, "utf8")).toContain("Preserve my changes");
  });

  it("requires an unambiguous saved source and required role context", () => {
    const f = fixture();
    const noSource = { ...f.input, node: { ...f.input.node, agentRef: "local:missing" }, saved: { ...f.saved, resolvedStartupFiles: [] } };
    expect(() => planRuntimeSwitchMaterials({ ...noSource, runtime: "claude-code" })).toThrow(/source is missing/);
    f.saved.resolvedStartupFiles[0]!.absolutePath = path.join(f.root, "missing-role.md");
    expect(() => planRuntimeSwitchMaterials({ ...f.input, runtime: "claude-code" })).toThrow(/Required startup file/);
  });
});
