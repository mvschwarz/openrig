import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { codexCommandResumeToken } from "../src/domain/native-process-lineage.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const dbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.unstubAllEnvs(); });
function fixture(runtime: string, name = "workshop") {
  vi.stubEnv("OPENRIG_YOLO", "0");
  const db = createFullTestDb(); dbs.push(db);
  const rigRepo = new RigRepository(db), rig = rigRepo.createRig(name);
  const node = rigRepo.addNode(rig.id, "dev.builder", { runtime, cwd: "/inert/project" });
  const store = new NativePermissionStore(db), registry = new SessionRegistry(db);
  const session = registry.registerSession(node.id, `dev-builder@${name}`);
  const binding = { id: "binding", nodeId: node.id, cwd: "/inert/project", tmuxSession: session.sessionName,
    launchPosture: "floor" } as NodeBinding;
  return { db, rigRepo, rig, node, store, registry, session, binding };
}
function transport() {
  const send = vi.fn(async () => ({ ok: false as const, message: "inert boundary" }));
  const tmux = { sendShellCommand: send, sendText: send } as unknown as TmuxAdapter;
  const fsOps = { readFile: () => { throw new Error("missing"); }, exists: () => false,
    writeFile: vi.fn(() => { throw new Error("unexpected permission file write"); }), mkdirp: vi.fn(), copyFile: vi.fn() };
  const prepareTeamWorkspace = vi.fn(() => ["/configured/work space", "/configured/shared/rigs/workshop/state/dev"]);
  return { send, tmux, fsOps, prepareTeamWorkspace };
}
function assertDefault(cmd: string, runtime: string) {
  if (runtime === "claude-code") {
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, launchPosture: "floor" });
    expect(cmd, "team settings must reach the native command").toContain(args.map(arg => ` ${shellQuote(arg)}`).join(""));
    const settings = JSON.parse(args[1]);
    expect(Object.keys(settings)).toEqual(["permissions", "hooks"]);
    expect(settings.permissions.allow).toContain("Bash(rig:*)");
    expect(settings.permissions.allow).toContain("Bash(npm test:*)");
    expect(settings.permissions.allow).not.toContain("Bash(tmux:*)");
    expect(settings.permissions.allow).not.toContain("Bash(node:*)");
    expect(settings.permissions.ask).toBeUndefined();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("claude-team-permissions.cjs");
    expect(settings.permissions.deny).toBeUndefined();
    expect(cmd).toContain("--permission-mode acceptEdits");
  } else {
    expect(cmd, "configured workspace must reach native command").toContain("--add-dir '/configured/work space'");
    expect(cmd).toContain("--add-dir '/configured/shared/rigs/workshop/state/dev'");
    expect(cmd).toContain("-s workspace-write");
    expect(cmd).not.toContain("-a never");
    expect(cmd).not.toContain("danger-full-access");
  }
}
describe("team launch permission defaults", () => {
  for (const runtime of ["claude-code", "codex"]) for (const mode of ["fresh", "resume", "fork"] as const) for (const policy of [null, "builtin:standard", "builtin:open"]) {
    it(`${runtime} ${mode}${policy ? ` with ${policy} recorded` : ""}: default reaches real launch command without permission files`, async () => {
      const f = fixture(runtime), t = transport();
      if (policy) f.db.prepare("UPDATE rigs SET permission_policy=? WHERE id=?").run(policy, f.rig.id);
      const b = f.store.apply(f.binding, runtime);
      const adapter = runtime === "claude-code" ? new ClaudeCodeAdapter(t) : new CodexRuntimeAdapter(t);
      await adapter.launchHarness(b, { name: f.session.sessionName,
        ...(mode === "resume" ? { resumeToken: "original" } : {}),
        ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
      assertDefault(t.send.mock.calls[0]![1], runtime);
      expect(t.fsOps.writeFile).not.toHaveBeenCalled();
      if (runtime === "codex") expect(t.prepareTeamWorkspace).toHaveBeenCalledExactlyOnceWith(f.session.sessionName);
    });
  }
  for (const runtime of ["claude-code", "codex"]) {
    it(`${runtime}: authored rig/member choices including none take precedence`, () => {
      const f = fixture(runtime);
      for (const policy of ["none", "builtin:locked", "builtin:yolo", "builtin:auto", "policy/custom.md"]) {
        for (const table of ["rigs", "nodes"]) {
          f.db.prepare(`UPDATE ${table} SET permission_policy=? WHERE id=?`).run(policy, table === "rigs" ? f.rig.id : f.node.id);
          expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: false });
          f.db.prepare(`UPDATE ${table} SET permission_policy=NULL WHERE id=?`).run(table === "rigs" ? f.rig.id : f.node.id);
        }
      }
      expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: true });
    });
    it(`${runtime}: a recorded standard or open keeps the team default, and the member's own choice decides over the rig's`, () => {
      const f = fixture(runtime);
      const set = (table: "rigs" | "nodes", policy: string | null) =>
        f.db.prepare(`UPDATE ${table} SET permission_policy=? WHERE id=?`).run(policy, table === "rigs" ? f.rig.id : f.node.id);
      for (const policy of ["builtin:standard", "builtin:open"]) {
        for (const table of ["rigs", "nodes"] as const) {
          set(table, policy);
          expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: true });
          set(table, null);
        }
      }
      // A member's locked, none or custom policy wins over the rig's standard; a member's standard wins over the rig's locked.
      set("rigs", "builtin:standard");
      for (const member of ["builtin:locked", "none", "policy/custom.md"]) {
        set("nodes", member);
        expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: false });
      }
      set("rigs", "builtin:locked");
      set("nodes", "builtin:open");
      expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: true });
      // An explicit seat choice still replaces it.
      f.store.write(f.node.id, { runtime: runtime as "codex" | "claude-code", mode: runtime === "codex" ? "floor" : "plan" }, "person", "selected");
      expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: false });
    });
    it(`${runtime}: an explicit seat choice overrides a stale team marker`, () => {
      const f = fixture(runtime);
      f.store.write(f.node.id, { runtime: runtime as "codex" | "claude-code", mode: runtime === "codex" ? "floor" : "plan" }, "person", "selected");
      expect(f.store.apply({ ...f.binding, teamPermissionDefault: true } as NodeBinding, runtime)).toMatchObject({ teamPermissionDefault: false });
      f.store.write(f.node.id, null, "person", "inherit");
      expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: true });
    });
    it(`${runtime}: startup derives the default before launch`, async () => {
      const f = fixture(runtime);
      const launchHarness = vi.fn(async (_binding: NodeBinding) => ({ ok: false as const, error: "inert boundary" }));
      const adapter = { runtime, project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async () => ({ delivered: [], failed: [] }), launchHarness } as unknown as RuntimeAdapter;
      const orchestrator = new StartupOrchestrator({ db: f.db, sessionRegistry: f.registry, eventBus: new EventBus(f.db), tmuxAdapter: {} as TmuxAdapter });
      await orchestrator.startNode({ rigId: f.rig.id, nodeId: f.node.id, sessionId: f.session.id, binding: f.binding,
        adapter, plan: { entries: [] } as never, resolvedStartupFiles: [], startupActions: [] });
      expect(launchHarness.mock.calls[0]![0]).toMatchObject({ teamPermissionDefault: true, kernelAuthority: false });
    });
    it(`${runtime}: legacy restore reaches the same real command`, async () => {
      const f = fixture(runtime), t = transport();
      const actual = runtime === "codex" ? new CodexResumeAdapter(t.tmux, t) : new ClaudeResumeAdapter(t.tmux);
      const resume = (...args: unknown[]) => (actual.resume as (...args: unknown[]) => unknown)(...args);
      const ctx = { db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.registry,
        claudeResume: { canResume: () => runtime === "claude-code", resume }, codexResume: { canResume: () => runtime === "codex", resume } };
      await (RestoreOrchestrator.prototype as any).attemptResume.call(ctx, f.node.id, f.session.sessionName,
        runtime === "codex" ? "codex_id" : "claude_id", "original", "/inert", null, "model", "floor");
      assertDefault(t.send.mock.calls[0]![1], runtime);
      if (runtime === "codex") {
        const command = t.send.mock.calls[0]![1];
        // A spaced team workspace must not hide the conversation in an unquoted process line.
        expect(codexCommandResumeToken(command.replace(/'/g, ""))).toBe("original");
        expect(command).toContain("resume 'original' --add-dir '/configured/work space' --add-dir '/configured/shared/rigs/workshop/state/dev'");
        expect(t.prepareTeamWorkspace).toHaveBeenCalledExactlyOnceWith(f.session.sessionName);
      }
    });
  }
  it("named Codex profiles, kernel, Pi and terminal keep their previous path", () => {
    const f = fixture("codex");
    f.db.prepare("UPDATE nodes SET codex_config_profile='chosen' WHERE id=?").run(f.node.id);
    expect(f.store.apply(f.binding, "codex")).toMatchObject({ teamPermissionDefault: false });
    for (const runtime of ["pi", "terminal"]) expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: false });
    const kernel = fixture("codex", "kernel");
    expect(kernel.store.apply(kernel.binding, "codex")).toMatchObject({ teamPermissionDefault: false, kernelAuthority: true, launchPosture: "full_bypass" });
  });
  it("a recorded standard leaves the kernel's seats, a named Codex profile and a Claude seat's own rules as they were", () => {
    for (const runtime of ["codex", "claude-code"]) {
      const kernel = fixture(runtime, "kernel");
      kernel.db.prepare("UPDATE rigs SET permission_policy='builtin:standard' WHERE id=?").run(kernel.rig.id);
      expect(kernel.store.apply(kernel.binding, runtime)).toMatchObject({ teamPermissionDefault: false, kernelAuthority: false });
    }
    const codex = fixture("codex");
    codex.db.prepare("UPDATE rigs SET permission_policy='builtin:standard' WHERE id=?").run(codex.rig.id);
    codex.db.prepare("UPDATE nodes SET codex_config_profile='chosen' WHERE id=?").run(codex.node.id);
    expect(codex.store.apply(codex.binding, "codex")).toMatchObject({ teamPermissionDefault: false });
    // A seat's own native rules may be the policy applied, so they keep their meaning alone.
    const claude = fixture("claude-code");
    claude.db.prepare("UPDATE rigs SET permission_policy='builtin:standard' WHERE id=?").run(claude.rig.id);
    claude.db.prepare("UPDATE nodes SET claude_permissions_json=? WHERE id=?").run(JSON.stringify({ allow: ["Bash(rig ps *)"], deny: [] }), claude.node.id);
    expect(claude.store.apply(claude.binding, "claude-code")).toMatchObject({ teamPermissionDefault: false, claudePermissions: { allow: ["Bash(rig ps *)"] } });
  });
  it("an unavailable default lookup keeps existing behavior", () => {
    const f = fixture("codex"), prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SELECT r.name")) throw new Error("metadata unavailable");
      return prepare(sql);
    });
    expect(f.store.apply(f.binding, "codex")).toMatchObject({ teamPermissionDefault: false, launchPosture: "floor" });
  });
  it("explicit native mode and non-interruptive flags are preserved", () => {
    expect(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, permissionMode: "plan" } as any)).toEqual([]);
    const choice = { teamPermissionDefault: true, launchPosture: "full_bypass", nonInterruptive: true } as any;
    expect(operationalLaunchArgs("claude-code", choice)).toEqual(["--settings", '{"skipDangerousModePermissionPrompt":true}']);
  });
});
