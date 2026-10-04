import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { rigNonInterruptiveSchema } from "../src/db/migrations/095_rig_non_interruptive.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { nonInterruptiveArgs, nonInterruptiveNotice } from "../src/adapters/non-interruptive.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), "ni-")); roots.push(dir); return dir; }
function fixture(runtime: string) {
  const tmux = {
    sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
    sendShellCommand: vi.fn(async () => ({ ok: true })),
    getPaneCommand: vi.fn(async () => runtime === "codex" ? "codex" : "claude"),
    capturePaneContent: vi.fn(async () => ""), listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
  const fsOps = { readFile: () => { throw new Error("not found"); }, writeFile: vi.fn(),
    exists: () => false, mkdirp: vi.fn(), copyFile: vi.fn(), listFiles: () => [] };
  const binding = { id: "b", nodeId: "n", cwd: "/work/fixture", tmuxSession: "dev@test",
    launchPosture: "full_bypass", nonInterruptive: true } as NodeBinding;
  return { tmux, fsOps, binding };
}

describe("non-interruptive launch choice", () => {
  it("migration preserves existing rigs as off, survives reopen, and is explicitly clearable", () => {
    const file = join(root(), "rig.db"); let db = createDb(file);
    migrate(db, ALL_MIGRATIONS.filter(m => m.name !== rigNonInterruptiveSchema.name));
    let repo = new RigRepository(db); const rig = repo.createRig("kept");
    migrate(db, ALL_MIGRATIONS);
    expect(repo.getRigNonInterruptive(rig.id)).toBe(false);
    expect(repo.getRig(rig.id)?.rig.name).toBe("kept");
    repo.setRigNonInterruptive(rig.id, true); db.close();
    db = createDb(file); migrate(db, ALL_MIGRATIONS); repo = new RigRepository(db);
    expect(repo.getRigNonInterruptive(rig.id)).toBe(true);
    expect(repo.getRigNonInterruptive(repo.createRig("other").id)).toBe(false);
    repo.setRigNonInterruptive(rig.id, false); expect(repo.getRigNonInterruptive(rig.id)).toBe(false);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]); db.close();
  });

  it("one typed operator default is off and does not mutate rig or harness settings", () => {
    const settings = new SettingsStore(join(root(), "config.json"));
    expect(settings.resolveOne("launch.non_interruptive").value).toBe(false);
    settings.set("launch.non_interruptive", "true");
    expect(settings.resolveOne("launch.non_interruptive").value).toBe(true);
    expect(() => settings.set("launch.non_interruptive", "maybe")).toThrow();
  });

  it.each(["claude-code", "codex", "pi"])("%s leaves off/floor/auto and unrelated runtimes unchanged", runtime => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    for (const launchPosture of [undefined, "floor", "auto"] as const) {
      expect(nonInterruptiveArgs(runtime, { launchPosture, nonInterruptive: true })).toEqual([]);
    }
    expect(nonInterruptiveArgs(runtime, { launchPosture: "full_bypass" })).toEqual([]);
    expect(nonInterruptiveArgs(runtime, { launchPosture: "full_bypass", nonInterruptive: false })).toEqual([]);
    if (runtime === "pi") expect(nonInterruptiveArgs(runtime, { launchPosture: "full_bypass", nonInterruptive: true })).toEqual([]);
  });

  it("does not suppress a Claude warning when an explicit native mode overrides bypass", () => {
    expect(nonInterruptiveArgs("claude-code", { nonInterruptive: true, launchPosture: "full_bypass", permissionMode: "acceptEdits" })).toEqual([]);
    expect(nonInterruptiveNotice("claude-code", { nonInterruptive: true, launchPosture: "full_bypass" })).toContain("accepted Claude's bypass-permissions warning");
  });

  it.each(["fresh", "resume", "fork"] as const)("Claude %s emits only the selected per-launch settings", async mode => {
    const { tmux, fsOps, binding } = fixture("claude-code");
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "fresh-id" });
    const opts = { name: "dev@test", ...(mode === "resume" ? { resumeToken: "old-id" } : {}),
      ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: "old-id" } } : {}) };
    await adapter.launchHarness(binding, opts);
    const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
    expect(command).toContain('--settings \'{"skipDangerousModePermissionPrompt":true}\'');
    expect(command).toContain("--dangerously-skip-permissions");
    expect(fsOps.writeFile).not.toHaveBeenCalled();
    vi.mocked(tmux.sendText).mockClear();
    await adapter.launchHarness({ ...binding, nonInterruptive: false }, opts);
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).toBe(command.replace(' --settings \'{"skipDangerousModePermissionPrompt":true}\'', ""));
  });

  it.each(["fresh", "resume", "fork"] as const)("Codex %s uses the same notices without changing model, sandbox or profile", async mode => {
    const { tmux, fsOps, binding } = fixture("codex");
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps, sleep: async () => {} });
    const opts = { name: "dev@test", ...(mode === "resume" ? { resumeToken: "old-id" } : {}),
      ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: "old-id" } } : {}) };
    await adapter.launchHarness(binding, opts);
    const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
    expect(command).toContain("notice.hide_full_access_warning=true");
    expect(command).toContain("notice.hide_gpt5_1_migration_prompt=true");
    expect(command).toContain('notice."hide_gpt-5.1-codex-max_migration_prompt"=true');
    expect(command).toContain("-s danger-full-access -a never");
    expect(fsOps.writeFile).not.toHaveBeenCalled();
    vi.mocked(tmux.sendText).mockClear();
    await adapter.launchHarness({ ...binding, nonInterruptive: false }, opts);
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).toBe(command.replace(/ -c (?:'[^']*'|notice\.\S+)/g, ""));
  });

  it("legacy restore adapters also receive the launch-only override", async () => {
    const claude = fixture("claude-code"); const codex = fixture("codex");
    await new ClaudeResumeAdapter(claude.tmux, { sleep: async () => {}, maxWaitMs: 1 }).resume("dev@test", "claude_id", "old-id", "/work", "full_bypass", null, undefined, undefined, undefined, true);
    await new CodexResumeAdapter(codex.tmux, { sleep: async () => {}, maxWaitMs: 1 }).resume("dev@test", "codex_id", "old-id", "/work", undefined, "full_bypass", null, undefined, true);
    expect(vi.mocked(claude.tmux.sendText).mock.calls[0]![1]).toContain("skipDangerousModePermissionPrompt");
    expect(vi.mocked(codex.tmux.sendShellCommand).mock.calls[0]![1]).toContain("notice.hide_full_access_warning=true");
  });
});


describe("persisted choice at the launch boundary", () => {
  it("persists before pod launch, keeps member posture and survives a later fresh startup", async () => {
    const db = createFullTestDb();
    const bindings: NodeBinding[] = [];
    const adapter = { runtime: "claude-code", listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (b: NodeBinding) => { bindings.push(b); return { ok: true }; },
      checkReady: async () => ({ ready: true }) } as RuntimeAdapter;
    const agent = 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n';
    const setup = createTestApp(db, { adapters: { "claude-code": adapter }, podInstantiatorFsOps: {
      exists: (p: string) => p.includes("agents/impl"),
      readFile: (p: string) => { if (p.includes("agents/impl")) return agent; throw new Error("missing"); },
    } });
    try {
      const spec = `version: "0.2"
name: ni-pod
permission_policy: builtin:yolo
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        cwd: .
      - id: locked
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        permission_policy: builtin:locked
        cwd: .
    edges: []
edges: []
`;
      const result = await setup.podInstantiator.instantiate(spec, "/work/fixture", { nonInterruptive: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(bindings).toHaveLength(2);
      expect(bindings.map(b => [b.nonInterruptive, b.launchPosture])).toEqual([[true, "full_bypass"], [true, "floor"]]);
      const rigId = (result as { ok: true; result: { rigId: string } }).result.rigId;
      expect(setup.rigRepo.getRigNonInterruptive(rigId)).toBe(true);
      expect(nonInterruptiveArgs("claude-code", bindings[1]!)).toEqual([]);
      const rig = setup.rigRepo.getRig(rigId)!;
      const node = rig.nodes.find(n => n.logicalId === "dev.impl")!;
      const session = setup.sessionRegistry.getSessionsForRig(rigId).find(s => s.nodeId === node.id)!;
      const replay = { rigId, nodeId: node.id, sessionId: session.id, binding: { ...bindings[0]!, nonInterruptive: false },
        adapter, plan: { runtime: "claude-code", cwd: "/work/fixture", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [], startupActions: [], isRestore: true, resumeToken: "retained-history" };
      await setup.startupOrchestrator.startNode(replay);
      expect(bindings.at(-1)!.nonInterruptive).toBe(true);
      setup.rigRepo.setRigNonInterruptive(rigId, false);
      await setup.startupOrchestrator.startNode({ ...replay, binding: { ...replay.binding, nonInterruptive: true } });
      expect(bindings.at(-1)!.nonInterruptive).toBe(false);
    } finally { db.close(); }
  });
});
