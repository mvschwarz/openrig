import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator, RigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { RigSpecCodec, LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { projectRigToGraph } from "../src/domain/graph-projection.js";
import { normalizeAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import type { RigSpec, LegacyRigSpec } from "../src/domain/types.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Real schema, DB, orchestration and Claude command builders. Only tmux and the
// provider process are simulated; the managed-shell argv effect is tested in s03-bound-launch.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-advisor-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const configDir = path.join(home, ".claude");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  const settings = [path.join(configDir, "settings.json"), path.join(root, ".claude", "settings.local.json")];
  for (const file of settings) fs.writeFileSync(file, '{"advisorModel":"existing-user-choice","custom":true}\n');
  const fsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf8"),
    writeFile: (p: string, value: string) => fs.writeFileSync(p, value),
    exists: fs.existsSync,
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    copyFile: fs.copyFileSync,
    listFiles: (p: string) => fs.readdirSync(p),
    readdir: (p: string) => fs.readdirSync(p),
    homedir: home,
  };
  const writeAgent = (name: string, defaults = {}, preferences = {}) => {
    fs.mkdirSync(path.join(root, "agents", name), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", name, "agent.yaml"), JSON.stringify({
      name, version: "1.0.0", defaults, resources: { skills: [] },
      profiles: { default: { preferences, uses: { skills: [] } } },
    }));
  };
  writeAgent("owner"); writeAgent("reviewer");
  const live = new Set<string>();
  const panes = new Map<string, number>();
  const launched = new Map<string, string>();
  let nextPid = 100;
  const listProcesses = async (): Promise<NativeProcessRow[]> => [...live].flatMap(session => {
    const pid = panes.get(session)!;
    const command = launched.get(session);
    const startedAt = "Sun Oct 11 12:00:00 2026";
    return [
      { pid, ppid: 1, pgid: pid, tpgid: command ? pid + 1 : pid, executableName: "bash", command: "bash", startedAt },
      ...(command ? [{ pid: pid + 1, ppid: pid, pgid: pid + 1, tpgid: pid + 1, executableName: "claude", command, startedAt }] : []),
    ];
  });
  const commands: Array<{ session: string; command: string }> = [];
  const tmux = mockShellCommand({
    createSession: vi.fn(async (session: string) => { live.add(session); panes.set(session, nextPid += 2); launched.delete(session); return { ok: true }; }),
    killSession: vi.fn(async (session: string) => { live.delete(session); launched.delete(session); return { ok: true }; }),
    hasSession: vi.fn(async (session: string) => live.has(session)),
    listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async (session: string) => live.has(session) ? [{ id: `%${panes.get(session)}`, index: 0, active: true, cwd: root, width: 100, height: 30 }] : []),
    getPanePid: vi.fn(async (target: string) => target.startsWith("%") ? Number(target.slice(1)) : panes.get(target) ?? null),
    sendKeys: vi.fn(async () => ({ ok: true })),
    getPaneCommand: vi.fn(async (session: string) => launched.has(session) ? "claude" : "bash"), capturePaneContent: vi.fn(async () => "Claude Code\n>"),
    sendText: vi.fn(async (session: string, command: string) => {
      commands.push({ session, command });
      // ps exposes the launched argv, without the shell quoting around these fixture values.
      const native = command.match(/\bclaude (.*(?:--session-id|--resume).*)/s);
      if (native) launched.set(session, `claude ${native[1]!.replaceAll("'", "")}`);
      if (command.includes("--fork-session")) {
        fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
        fs.writeFileSync(path.join(configDir, "sessions", "fork.json"), JSON.stringify({ name: session, sessionId: "fork-native-id" }));
      }
      return { ok: true };
    }),
  } as unknown as TmuxAdapter);
  const db = createFullTestDb(); cleanups.push(() => db.close());
  const rigRepo = new RigRepository(db), podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sessionIdFactory: randomUUID, sleep: async () => {}, listProcesses });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, listProcesses });
  const inst = new PodRigInstantiator({ db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
    startupOrchestrator, fsOps, adapters: { "claude-code": adapter }, tmuxAdapter: tmux, onboardingEnabledResolver: () => false });
  const snapshotRepo = new SnapshotRepository(db), checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
    nodeLauncher, tmuxAdapter: tmux, listProcesses, claudeResume: new ClaudeResumeAdapter(tmux, { sleep: async () => {}, listProcesses }), codexResume: new CodexResumeAdapter(tmux) });
  const exporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });
  const spec: RigSpec = { version: "0.2", name: "advisor-rig", pods: [{ id: "dev", label: "Dev", edges: [], members: [
    { id: "owner", agentRef: "local:agents/owner", profile: "default", runtime: "claude-code", cwd: root,
      model: "claude-sonnet-5-5", effort: "medium", advisor: "opus" },
    { id: "reviewer", agentRef: "local:agents/reviewer", profile: "default", runtime: "claude-code", cwd: root, model: "claude-sonnet-5-5" },
  ] }], edges: [] };
  return { root, db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, inst, adapter, tmux, fsOps,
    snapshotCapture, restore, exporter, spec, live, commands, settings, writeAgent };
}

describe("per-seat Claude Advisor (#1152)", () => {
  it("upgrades existing seats with no Advisor and retains their primary model", () => {
    const db = new Database(":memory:"); cleanups.push(() => db.close());
    migrate(db, ALL_MIGRATIONS.filter(m => m.name !== "102_node_advisor.sql"));
    const oldRepo = new RigRepository(db);
    const rig = oldRepo.createRig("pre-advisor");
    const node = oldRepo.addNode(rig.id, "owner", { runtime: "claude-code", model: "claude-sonnet-5-5" });
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT model, advisor FROM nodes WHERE id = ?").get(node.id)).toEqual({ model: "claude-sonnet-5-5", advisor: null });
    const upgraded = new RigRepository(db);
    expect(upgraded.setNodeAdvisor(node.id, "opus")).toBe(true);
    expect(upgraded.getRig(rig.id)!.nodes[0]).toMatchObject({ model: "claude-sonnet-5-5", advisor: "opus" });
  });

  it.each(["bootstrap", "materialize"])("%s preserves independent primary/Advisor models through export, snapshot and resume", async mode => {
    const f = setup();
    f.writeAgent("owner", { advisor: "default-advisor" }, { advisor: "profile-advisor" });
    const yaml = RigSpecCodec.serialize(f.spec);
    const start = mode === "bootstrap" ? await f.inst.instantiate(yaml, f.root) : await f.inst.materialize(yaml, f.root);
    expect(start, JSON.stringify(start)).toMatchObject({ ok: true });
    if (!start.ok) throw Error("fixture failed to start");
    const rigId = start.result.rigId;
    if (mode === "materialize") expect(await f.inst.launchMaterialized(yaml, f.root, rigId)).toMatchObject({ ok: true });
    const rig = f.rigRepo.getRig(rigId)!;
    const owner = rig.nodes.find(n => n.logicalId === "dev.owner")!;
    const reviewer = rig.nodes.find(n => n.logicalId === "dev.reviewer")!;
    expect(owner).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", advisor: "opus", cwd: reviewer.cwd });
    expect(reviewer.advisor).toBeNull();
    const ownerLaunch = f.commands.find(c => c.session.startsWith("dev-owner") && c.command.includes("--session-id"))!.command;
    expect(ownerLaunch).toContain("--model 'claude-sonnet-5-5'");
    expect(ownerLaunch).toContain("--effort 'medium'");
    expect(ownerLaunch).toContain("--advisor 'opus'");
    expect(f.commands.filter(c => c.session.startsWith("dev-reviewer")).some(c => c.command.includes("--advisor"))).toBe(false);
    expect(projectRigToGraph({ ...rig, sessions: f.sessionRegistry.getSessionsForRig(rigId) }).nodes.find(n => n.id === owner.id)?.data.advisor).toBe("opus");
    const exported = f.exporter.exportRig(rigId) as RigSpec;
    const roundTrip = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(exported)) as Record<string, unknown>);
    expect(roundTrip.pods[0]!.members.find(m => m.id === "owner")?.advisor).toBe("opus");
    expect(roundTrip.pods[0]!.members.find(m => m.id === "reviewer")?.advisor).toBeUndefined();
    const snapshot = f.snapshotCapture.captureSnapshot(rigId, "manual");
    expect(snapshot.data.nodes.find(n => n.id === owner.id)?.advisor).toBe("opus");
    const tokens = new Map(snapshot.data.sessions.map(s => [s.nodeId, s.resumeToken]));
    expect(tokens.get(owner.id)).toBeTruthy();
    f.live.clear(); f.commands.length = 0;
    const restored = await f.restore.restore(snapshot.id, { adapters: { "claude-code": f.adapter }, fsOps: f.fsOps });
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    if (restored.ok) expect(restored.result.nodes.map(n => n.status), JSON.stringify(restored)).toEqual(["resumed", "resumed"]);
    const resumes = f.commands.filter(c => c.command.includes("claude ") && c.command.includes("--resume"));
    expect(resumes).toHaveLength(2);
    expect(resumes.find(c => c.session.startsWith("dev-owner"))!.command).toContain(`--resume '${tokens.get(owner.id)}'`);
    expect(resumes.find(c => c.session.startsWith("dev-owner"))!.command).toContain("--advisor 'opus'");
    expect(resumes.find(c => c.session.startsWith("dev-reviewer"))!.command).not.toContain("--advisor");
    for (const file of f.settings) expect(fs.readFileSync(file, "utf8")).toBe('{"advisorModel":"existing-user-choice","custom":true}\n');
  });

  it.each([
    { member: "opus", profile: "profile-advisor", defaults: "default-advisor", expected: "opus" },
    { member: undefined, profile: "profile-advisor", defaults: "default-advisor", expected: "profile-advisor" },
    { member: undefined, profile: undefined, defaults: "default-advisor", expected: "default-advisor" },
  ])("materialization retains the resolved Advisor before launch: %j", async values => {
    const f = setup();
    f.spec.pods[0]!.members[0]!.advisor = values.member;
    f.writeAgent("owner", { advisor: values.defaults }, { advisor: values.profile });
    const yaml = RigSpecCodec.serialize(f.spec);
    const result = await f.inst.materialize(yaml, f.root);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw Error("fixture failed to materialize");
    const rigId = result.result.rigId;
    const rig = f.rigRepo.getRig(rigId)!;
    const owner = rig.nodes.find(n => n.logicalId === "dev.owner")!;
    expect(owner.advisor).toBe(values.expected);
    expect(rig.nodes.find(n => n.logicalId === "dev.reviewer")!.advisor).toBeNull();
    expect(f.commands).toEqual([]);
    expect(projectRigToGraph({ ...rig, sessions: [] }).nodes.find(n => n.id === owner.id)?.data.advisor).toBe(values.expected);
    const exported = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(f.exporter.exportRig(rigId))) as Record<string, unknown>);
    expect(exported.pods[0]!.members.find(m => m.id === "owner")?.advisor).toBe(values.expected);
    expect(f.snapshotCapture.captureSnapshot(rigId, "manual").data.nodes.find(n => n.id === owner.id)?.advisor).toBe(values.expected);

    f.writeAgent("owner", { advisor: "updated-default" }, { advisor: "updated-profile" });
    expect(await f.inst.launchMaterialized(yaml, f.root, rigId)).toMatchObject({ ok: true });
    const expectedAtLaunch = values.member ?? "updated-profile";
    expect(f.rigRepo.getRig(rigId)!.nodes.find(n => n.id === owner.id)?.advisor).toBe(expectedAtLaunch);
    expect(f.commands.find(c => c.session.startsWith("dev-owner") && c.command.includes("--session-id"))?.command)
      .toContain(`--advisor '${expectedAtLaunch}'`);
  });

  it("re-resolves Advisor for a fork and keeps the new conversation identity", async () => {
    const f = setup();
    const member = f.spec.pods[0]!.members[0]!;
    member.advisor = "fork-advisor";
    member.sessionSource = { mode: "fork", ref: { kind: "native_id", value: "parent-native-id" } };
    const result = await f.inst.instantiate(RigSpecCodec.serialize(f.spec), f.root);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw Error("fixture failed to start");
    const command = f.commands.find(c => c.command.includes("--fork-session"))!.command;
    expect(command).toContain("--resume 'parent-native-id' --fork-session");
    expect(command).toContain("--advisor 'fork-advisor'");
    expect(command).toContain("--model 'claude-sonnet-5-5'");
    const owner = f.rigRepo.getRig(result.result.rigId)!.nodes.find(n => n.logicalId === "dev.owner")!;
    expect(f.sessionRegistry.getSessionsForRig(result.result.rigId).find(s => s.nodeId === owner.id)?.resumeToken).toBe("fork-native-id");
  });

  it("removing Advisor from the spec clears persistence and the next launch", async () => {
    const f = setup();
    const start = await f.inst.instantiate(RigSpecCodec.serialize(f.spec), f.root);
    if (!start.ok) throw Error(JSON.stringify(start));
    const rigId = start.result.rigId;
    delete f.spec.pods[0]!.members[0]!.advisor;
    f.live.clear(); f.commands.length = 0;
    for (const session of f.sessionRegistry.getSessionsForRig(rigId)) {
      f.sessionRegistry.markDetached(session.id);
      f.sessionRegistry.clearBinding(session.nodeId);
    }
    const relaunch = await f.inst.launchMaterialized(RigSpecCodec.serialize(f.spec), f.root, rigId);
    expect(relaunch, JSON.stringify(relaunch)).toMatchObject({ ok: true });
    if (relaunch.ok) expect(relaunch.result.nodes, JSON.stringify(relaunch)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "launched" })]));
    expect(f.rigRepo.getRig(rigId)!.nodes.every(n => n.advisor === null)).toBe(true);
    expect(f.commands.some(c => c.command.includes("--session-id"))).toBe(true);
    expect(f.commands.some(c => c.command.includes("--advisor"))).toBe(false);
    expect(RigSpecCodec.serialize(f.exporter.exportRig(rigId))).not.toContain("advisor:");
    expect(f.snapshotCapture.captureSnapshot(rigId, "manual").data.nodes.every(n => n.advisor === null)).toBe(true);
  });

  it("legacy import/export and restore carry Advisor without replacing the resume token", async () => {
    const f = setup();
    const raw = { version: "0.1", name: "legacy-advisor", nodes: [{ id: "owner", runtime: "claude-code", cwd: f.root,
      model: "claude-sonnet-5-5", advisor: "opus" }], edges: [] };
    expect(LegacyRigSpecSchema.validate(raw).valid).toBe(true);
    const legacy = LegacyRigSpecSchema.normalize(raw);
    const preflight = new RigSpecPreflight({ rigRepo: f.rigRepo, tmuxAdapter: f.tmux, exec: async () => "", cmuxExec: async () => "" });
    const inst = new RigInstantiator({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus, nodeLauncher: f.nodeLauncher, preflight });
    const result = await inst.instantiate(legacy);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw Error("fixture failed to start");
    const rigId = result.result.rigId;
    const session = f.sessionRegistry.getSessionsForRig(rigId)[0]!;
    f.db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'legacy-token', startup_status = 'ready' WHERE id = ?").run(session.id);
    expect(LegacyRigSpecCodec.serialize(f.exporter.exportRig(rigId) as LegacyRigSpec)).toContain("advisor: opus");
    const snapshot = f.snapshotCapture.captureSnapshot(rigId, "manual");
    f.live.clear(); f.commands.length = 0;
    const restored = await f.restore.restore(snapshot.id);
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    expect(f.commands.find(c => c.command.includes("--resume"))?.command).toContain("--advisor 'opus' --resume 'legacy-token'");
  });

  it("does not pass the Claude-only Advisor flag to Codex", async () => {
    const f = setup();
    const rig = f.rigRepo.createRig("codex-advisor");
    const node = f.rigRepo.addNode(rig.id, "coder", { runtime: "codex", cwd: f.root, model: "gpt-5.4", advisor: "opus" });
    f.sessionRegistry.registerSession(node.id, "coder@codex-advisor");
    f.sessionRegistry.updateBinding(node.id, { tmuxSession: "coder@codex-advisor", tmuxPane: "%1" });
    const adapter = new CodexRuntimeAdapter({ tmux: f.tmux, fsOps: f.fsOps, sleep: async () => {} });
    const result = await adapter.launchHarness({ ...f.sessionRegistry.getBindingForNode(node.id)!, cwd: f.root, model: "gpt-5.4", advisor: "opus" }, { name: "coder@codex-advisor" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const command = f.commands.find(c => c.command.includes("codex"))!.command;
    expect(command).toContain("-m 'gpt-5.4'");
    expect(command).not.toContain("--advisor");
  });

  it.each([
    { member: " ", profile: " profile-advisor ", defaults: "default-advisor", expected: "profile-advisor" },
    { member: "\t", profile: " ", defaults: " default-advisor ", expected: "default-advisor" },
    { member: undefined, profile: " ", defaults: "default-advisor", expected: "default-advisor" },
    { member: " ", profile: "\t", defaults: " ", expected: undefined },
  ])("direct resolution skips blank Advisor candidates: %j", values => {
    const f = setup();
    const spec = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(f.spec)) as Record<string, unknown>);
    const pod = spec.pods[0]!;
    const member = { ...pod.members[0]!, advisor: values.member };
    const agent = normalizeAgentSpec({ name: "owner", version: "1.0.0", defaults: {}, resources: { skills: [] },
      profiles: { default: { preferences: {}, uses: { skills: [] } } } });
    agent.defaults!.advisor = values.defaults;
    agent.profiles.default!.preferences!.advisor = values.profile;
    const config = resolveNodeConfig({ baseSpec: { spec: agent, sourcePath: f.root, hash: "fixture" },
      importedSpecs: [], collisions: [], profileName: "default", member, pod, rig: spec });
    expect(config.ok).toBe(true);
    if (config.ok) expect(config.config.advisor).toBe(values.expected);
  });

  it.each([
    { member: " opus ", profile: "profile-advisor", defaults: "default-advisor", expected: "opus" },
    { member: undefined, profile: " profile-advisor ", defaults: "default-advisor", expected: "profile-advisor" },
    { member: undefined, profile: undefined, defaults: " default-advisor ", expected: "default-advisor" },
    { member: undefined, profile: undefined, defaults: undefined, expected: undefined },
    { member: false, profile: "", defaults: 42, expected: undefined },
  ])("resolves and normalizes launch preferences: %j", values => {
    const raw = { version: "0.2", name: "test", pods: [{ id: "dev", label: "Dev", edges: [], members: [
      { id: "owner", agent_ref: "local:agents/owner", profile: "default", runtime: "claude-code", cwd: "/workspace",
        ...(values.member !== undefined ? { advisor: values.member } : {}) },
    ] }], edges: [] };
    const spec = RigSpecSchema.normalize(raw);
    const agent = { name: "owner", version: "1.0.0", defaults: { advisor: values.defaults }, resources: { skills: [] },
      profiles: { default: { preferences: { advisor: values.profile }, uses: { skills: [] } } } };
    expect(RigSpecSchema.validate(raw).valid).toBe(true);
    expect(validateAgentSpec(agent).valid).toBe(true);
    if (values.member === false) {
      expect(RigSpecSchema.validate(raw).advisories?.join(" ")).toContain("advisor");
      expect(validateAgentSpec(agent).advisories?.join(" ")).toContain("advisor");
    }
    const config = resolveNodeConfig({ baseSpec: { spec: normalizeAgentSpec(agent), sourcePath: "/agents/owner", hash: "fixture" },
      importedSpecs: [], collisions: [], profileName: "default", member: spec.pods[0]!.members[0]!, pod: spec.pods[0]!, rig: spec });
    expect(config.ok).toBe(true);
    if (config.ok) expect(config.config.advisor).toBe(values.expected);
  });
});
