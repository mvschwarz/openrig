import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { observeClaudePaneProcess } from "../src/domain/native-process-lineage.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const dbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.unstubAllEnvs(); });
function fixture(runtime: string, name = "kernel") {
  vi.stubEnv("OPENRIG_YOLO", "0");
  const db = createFullTestDb(); dbs.push(db);
  const rigRepo = new RigRepository(db), rig = rigRepo.createRig(name);
  const node = rigRepo.addNode(rig.id, "operator.agent", { runtime, cwd: "/inert/kernel" });
  const store = new NativePermissionStore(db), registry = new SessionRegistry(db);
  const session = registry.registerSession(node.id, "operator.agent@kernel");
  const binding = { id: "binding", nodeId: node.id, cwd: "/inert/kernel", tmuxSession: session.sessionName,
    launchPosture: "floor" } as NodeBinding;
  return { db, rigRepo, rig, node, store, registry, session, binding };
}
function transport() {
  const send = vi.fn(async () => ({ ok: false as const, message: "inert transport: no native execution" }));
  const tmux = { sendShellCommand: send, sendText: send } as unknown as TmuxAdapter;
  const fsOps = { readFile: () => { throw new Error("missing"); }, exists: () => false,
    writeFile: vi.fn(() => { throw new Error("unexpected permission write"); }), mkdirp: vi.fn(), copyFile: vi.fn() };
  return { send, tmux, fsOps };
}
function assertGrant(command: string, runtime: string) {
  if (runtime === "claude-code") {
    expect(command).toContain("--permission-mode acceptEdits");
    expect(command).toContain("Bash(rig:*)"); expect(command).toContain("Bash(tmux:*)");
    expect(command).toContain('"Skill"'); expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).not.toContain("skipDangerousModePermissionPrompt");
    const json = command.match(/'--settings' '([^']+)'/)?.[1];
    expect(json).toBeDefined();
    expect(Object.keys(JSON.parse(json!))).toEqual(["permissions"]);
    expect(Object.keys(JSON.parse(json!).permissions)).toEqual(["allow"]); // no reset of user ask/deny
    expect(JSON.parse(json!).permissions.allow).toContain("Read(~/**)");
  } else {
    expect(command).toContain("-s danger-full-access -a never");
    expect(command).toContain("notice.hide_full_access_warning=true");
    expect(command).toContain("notice.hide_gpt5_1_migration_prompt=true");
  }
}
const modes = ["fresh", "resume", "fork"] as const;
const variants = ["rig.yaml", "rig-claude-only.yaml", "rig-codex-only.yaml"];
describe("kernel operational launch default", () => {
  for (const variant of variants) for (const mode of modes) {
    it(`${variant} ${mode}: all shipped agent seats reach the real command builder without shared permission writes`, async () => {
      const spec = parse(readFileSync(join(__dirname, "../specs/rigs/launch/kernel", variant), "utf8"));
      for (const pod of spec.pods) for (const member of pod.members) {
        if (member.runtime === "terminal") continue;
        const f = fixture(member.runtime, spec.name), t = transport();
        const b = f.store.apply(f.binding, member.runtime);
        const adapter = member.runtime === "claude-code" ? new ClaudeCodeAdapter(t) : new CodexRuntimeAdapter(t);
        await adapter.launchHarness(b, { name: "seat", ...(mode === "resume" ? { resumeToken: "original" } : {}),
          ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
        assertGrant(t.send.mock.calls[0]![1], member.runtime);
        expect(b.kernelAuthority).toBe(true);
        expect(f.store.resolve(f.node.id, member.runtime).source).toBe("kernel_default");
        expect(t.fsOps.writeFile).not.toHaveBeenCalled();
      }
    });
  }
  it.each(["codex", "claude-code"])("%s other rigs with kernel-like cwd/pane keep the floor, even with a stale marker", async runtime => {
    const f = fixture(runtime, "project"), t = transport();
    const b = f.store.apply({ ...f.binding, kernelAuthority: true }, runtime);
    expect(b.kernelAuthority).toBe(false); expect(b.launchPosture).toBe("floor");
    const adapter = runtime === "codex" ? new CodexRuntimeAdapter(t) : new ClaudeCodeAdapter(t);
    await adapter.launchHarness(b, { name: "seat" }); const cmd = t.send.mock.calls[0]![1];
    expect(cmd).not.toContain("--settings"); expect(cmd).not.toContain("notice.");
    expect(cmd).toContain(runtime === "codex" ? "-s workspace-write" : "--permission-mode acceptEdits");
  });
  it.each(["codex", "claude-code"])("%s explicit choices and authored policies precede the default", runtime => {
    const f = fixture(runtime);
    f.store.write(f.node.id, { runtime: runtime as "codex" | "claude-code", mode: runtime === "codex" ? "floor" : "plan" }, "operator", "deliberate choice");
    expect(f.store.apply(f.binding, runtime).kernelAuthority).toBe(false);
    expect(f.store.resolve(f.node.id, runtime).source).toBe("explicit");
    f.store.write(f.node.id, null, "operator", "inherit");
    f.rigRepo.setRigPermissionPolicy(f.rig.id, "builtin:locked");
    expect(f.store.apply(f.binding, runtime).kernelAuthority).toBe(false);
    f.rigRepo.setRigPermissionPolicy(f.rig.id, null);
    f.db.prepare("UPDATE nodes SET permission_policy='builtin:locked' WHERE id=?").run(f.node.id);
    expect(f.store.apply(f.binding, runtime).kernelAuthority).toBe(false);
    f.db.prepare("UPDATE nodes SET permission_policy=NULL WHERE id=?").run(f.node.id);
    expect(f.store.apply(f.binding, runtime).kernelAuthority).toBe(true);
  });
  it.each(["claude-code", "codex"])("%s unavailable kernel lookup keeps the floor without a kernel grant", runtime => {
    const f = fixture(runtime);
    const prepare = f.db.prepare.bind(f.db);
    const lookup = vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SELECT r.name")) throw new Error("kernel metadata unavailable");
      return prepare(sql);
    });
    try {
      expect(f.store.apply(f.binding, runtime)).toMatchObject({ kernelAuthority: false, launchPosture: "floor" });
      expect(f.store.resolve(f.node.id, runtime)).toMatchObject({ source: "system_default", launchPosture: "floor" });
    } finally { lookup.mockRestore(); }
  });
  it("named Codex profiles remain selected and terminal/Pi never receive a kernel native grant", () => {
    const f = fixture("codex");
    f.db.prepare("UPDATE nodes SET codex_config_profile='operator-choice' WHERE id=?").run(f.node.id);
    expect(f.store.apply(f.binding, "codex").kernelAuthority).toBe(false);
    for (const runtime of ["terminal", "pi"]) expect(f.store.apply(f.binding, runtime).kernelAuthority).toBe(false);
  });
  for (const runtime of ["claude-code", "codex"]) for (const mode of modes) {
    it(`${runtime} startup recomputes the kernel default on ${mode}`, async () => {
      const f = fixture(runtime);
      const launchHarness = vi.fn(async () => ({ ok: false as const, error: "inert boundary" }));
      const adapter = { runtime, project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async () => ({ delivered: [], failed: [] }), launchHarness } as unknown as RuntimeAdapter;
      const orchestrator = new StartupOrchestrator({ db: f.db, sessionRegistry: f.registry, eventBus: new EventBus(f.db), tmuxAdapter: {} as TmuxAdapter });
      await orchestrator.startNode({ rigId: f.rig.id, nodeId: f.node.id, sessionId: f.session.id,
        binding: { ...f.binding, kernelAuthority: false }, adapter, plan: { entries: [] } as never,
        resolvedStartupFiles: [], startupActions: [], isRestore: mode === "resume",
        ...(mode === "resume" ? { resumeToken: "retained", resumeType: runtime === "codex" ? "codex_id" : "claude_id" } : {}),
        ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent" } } : {}) });
      expect(launchHarness).toHaveBeenCalledWith(expect.objectContaining({ kernelAuthority: true,
        launchPosture: runtime === "codex" ? "full_bypass" : "floor" }), expect.anything());
    });
  }
  it.each(["codex", "claude-code"])("legacy restore threads %s kernel choice into the real resume adapter", async runtime => {
    const f = fixture(runtime), t = transport();
    const actual = runtime === "codex" ? new CodexResumeAdapter(t.tmux) : new ClaudeResumeAdapter(t.tmux);
    const resume = vi.fn((...args: unknown[]) => (actual.resume as (...args: unknown[]) => unknown)(...args));
    const ctx = { db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.registry, appliedLaunchStore: new AppliedLaunchObservationStore(f.db),
      claudeResume: { canResume: () => runtime === "claude-code", resume }, codexResume: { canResume: () => runtime === "codex", resume } };
    await (RestoreOrchestrator.prototype as any).attemptResume.call(ctx, f.node.id, "seat", runtime === "codex" ? "codex_id" : "claude_id", "original", "/inert", null, "model", "floor");
    assertGrant(t.send.mock.calls[0]![1], runtime);
  });
  it.each(["--settings", "--settings --unknown"])("strict identity rejects malformed settings value: %s", async settings => {
    const row = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "claude", startedAt: "start",
      command: `claude --session-id native-id ${settings}` };
    expect(await observeClaudePaneProcess({ target: "seat", tmux: { getPanePid: async () => 10 },
      expectedToken: "native-id", listProcesses: async () => [row] })).toBeNull();
  });
  it("launch-only settings do not obscure exact Claude process identity; unrelated args still fail", async () => {
    const root = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "claude", startedAt: "start" };
    const input = { target: "seat", tmux: { getPanePid: async () => 10 }, expectedToken: "native-id" };
    for (const settings of ['--settings \'{"permissions":{"allow":["Bash(rig:*)"]}}\'', "--settings=/inert/settings.json"]) {
      const command = `claude --permission-mode acceptEdits ${settings} --session-id native-id`;
      expect(await observeClaudePaneProcess({ ...input, listProcesses: async () => [{ ...root, command }] })).not.toBeNull();
      expect(await observeClaudePaneProcess({ ...input, listProcesses: async () => [{ ...root, command: command + " --unknown" }] })).toBeNull();
      expect(await observeClaudePaneProcess({ ...input, expectedToken: "other", listProcesses: async () => [{ ...root, command }] })).toBeNull();
    }
  });
});
