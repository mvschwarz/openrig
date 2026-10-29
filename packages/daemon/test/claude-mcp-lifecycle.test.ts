import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
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
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { LegacyRigSpec } from "../src/domain/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Real persistence and launch/restore orchestration; only tmux and Claude are simulated.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), configDir = path.join(home, ".claude");
  fs.mkdirSync(configDir, { recursive: true });
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  const mcp = { mcpServers: { existing: { command: "never-run-this-fixture" } } };
  // Pre-trust the fixture so ordinary onboarding writes don't obscure MCP isolation.
  const shared = new Map([
    [path.join(home, ".claude.json"), JSON.stringify({ ...mcp, projects: { [root]: { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true })],
    [path.join(root, ".mcp.json"), JSON.stringify(mcp) + "\n"],
  ]);
  for (const [file, bytes] of shared) fs.writeFileSync(file, bytes);
  for (const name of ["owner", "reviewer"]) {
    fs.mkdirSync(path.join(root, "agents", name), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", name, "agent.yaml"), JSON.stringify({ name, version: "1.0.0",
      resources: { skills: [] }, profiles: { default: { uses: { skills: [] } } } }));
  }
  const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, value: string) => fs.writeFileSync(p, value),
    exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); }, copyFile: fs.copyFileSync,
    listFiles: (p: string) => fs.readdirSync(p), readdir: (p: string) => fs.readdirSync(p), homedir: home };
  const live = new Set<string>(), panes = new Map<string, number>(), launched = new Map<string, string>();
  const commands: Array<{ session: string; command: string }> = [];
  let nextPid = 100;
  const listProcesses = async (): Promise<NativeProcessRow[]> => [...live].flatMap(session => {
    const pid = panes.get(session)!, command = launched.get(session), startedAt = "Sun Oct 11 12:00:00 2026";
    return [{ pid, ppid: 1, pgid: pid, tpgid: command ? pid + 1 : pid, executableName: "bash", command: "bash", startedAt },
      ...(command ? [{ pid: pid + 1, ppid: pid, pgid: pid + 1, tpgid: pid + 1, executableName: "claude", command, startedAt }] : [])];
  });
  const tmux = mockShellCommand({
    createSession: vi.fn(async (session: string) => { live.add(session); panes.set(session, nextPid += 2); launched.delete(session); return { ok: true }; }),
    killSession: vi.fn(async (session: string) => { live.delete(session); launched.delete(session); return { ok: true }; }),
    hasSession: vi.fn(async (session: string) => live.has(session)), listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async (session: string) => live.has(session) ? [{ id: `%${panes.get(session)}`, index: 0, active: true, cwd: root, width: 100, height: 30 }] : []),
    getPanePid: vi.fn(async (target: string) => target.startsWith("%") ? Number(target.slice(1)) : panes.get(target) ?? null),
    sendKeys: vi.fn(async () => ({ ok: true })), getPaneCommand: vi.fn(async (session: string) => launched.has(session) ? "claude" : "bash"),
    capturePaneContent: vi.fn(async () => "Claude Code\n>"),
    sendText: vi.fn(async (session: string, command: string) => {
      commands.push({ session, command });
      const native = command.match(/\bclaude (.*(?:--session-id|--resume).*)/s);
      if (native) launched.set(session, `claude ${native[1]!.replaceAll("'", "")}`);
      return { ok: true };
    }),
  } as unknown as TmuxAdapter);
  const db = createFullTestDb(); cleanups.push(() => db.close());
  const rigRepo = new RigRepository(db), podRepo = new PodRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sessionIdFactory: randomUUID, sleep: async () => {}, listProcesses });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
  const inst = new PodRigInstantiator({ db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps, adapters: { "claude-code": adapter }, tmuxAdapter: tmux, onboardingEnabledResolver: () => false });
  const snapshotRepo = new SnapshotRepository(db), checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
    nodeLauncher, tmuxAdapter: tmux, listProcesses, claudeResume: new ClaudeResumeAdapter(tmux, { sleep: async () => {}, listProcesses }), codexResume: new CodexResumeAdapter(tmux) });
  const exporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });
  const raw = { version: "0.2", name: "mcp-rig", pods: [{ id: "dev", label: "Dev", edges: [], members: [
    { id: "owner", agent_ref: "local:agents/owner", profile: "default", runtime: "claude-code", cwd: root, claude_mcp: "none" as string | undefined },
    { id: "reviewer", agent_ref: "local:agents/reviewer", profile: "default", runtime: "claude-code", cwd: root },
  ] }], edges: [] };
  return { root, db, rigRepo, sessionRegistry, eventBus, inst, adapter, tmux, fsOps, snapshotCapture, restore, exporter, raw, live, commands,
    shared, nodeLauncher };
}

describe("per-agent Claude MCP selection (#1478)", () => {
  it.each(["none", undefined, "unreadable"] as const)("the shutdown fallback probe keeps the saved MCP choice and resume token: %s", async selection => {
    const f = setup(), start = await f.inst.materialize(JSON.stringify(f.raw), f.root);
    if (!start.ok) throw Error(JSON.stringify(start));
    const node = f.rigRepo.getRig(start.result.rigId)!.nodes.find(node => node.logicalId === "dev.owner")!;
    f.rigRepo.setNodeClaudeMcp(node.id, selection === "none" ? "none" : null);
    if (selection === "unreadable") {
      f.db.pragma("ignore_check_constraints = ON");
      f.db.prepare("UPDATE nodes SET claude_mcp = 'corrupt' WHERE id = ?").run(node.id);
    }
    const session = f.sessionRegistry.registerSession(node.id, "dev-owner@mcp-rig");
    f.sessionRegistry.updateResumeToken(session.id, "claude_id", "mcp-history", "operator");
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry: f.sessionRegistry, tmuxAdapter: f.tmux, sleep: async () => {},
      listClaudeProcesses: async () => [], homeDir: f.root,
    });
    await refresher.refresh([{
      nodeId: node.id, sessionId: session.id, sessionName: session.sessionName,
      runtime: "claude-code", resumeType: "claude_id", resumeToken: "mcp-history", cwd: f.root,
    }]);
    const probes = f.commands.filter(entry => entry.command.includes("--resume"));
    expect(f.sessionRegistry.getSessionsForRig(start.result.rigId)[0]?.resumeToken).toBe("mcp-history");
    if (selection === "unreadable") {
      expect(probes).toEqual([]);
      expect(f.tmux.createSession).not.toHaveBeenCalled();
      return;
    }
    expect(probes).toHaveLength(1);
    const argv = execFileSync("/bin/sh", ["-c", `claude() { printf '%s\\n' "$@"; }; ${probes[0]!.command}`], { encoding: "utf8" }).trim().split("\n");
    expect(argv).toContain("mcp-history");
    expect(argv.filter(arg => arg === "--strict-mcp-config")).toHaveLength(selection === "none" ? 1 : 0);
    expect(argv.filter(arg => arg === "--mcp-config")).toHaveLength(selection === "none" ? 1 : 0);
    if (selection === "none") expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(f.tmux.killSession).toHaveBeenCalledWith(probes[0]!.session);
  });

  it.each(["claude_mcp", "claudeMcp"])("the expansion HTTP route preserves %s through validation, persistence and launch", async key => {
    const f = setup();
    const { app, rigRepo } = createTestApp(f.db, { podInstantiatorFsOps: f.fsOps });
    const rig = rigRepo.createRig("expanded-mcp"), pod = f.raw.pods[0]!;
    const member = pod.members[0]! as Record<string, unknown>;
    delete member.claude_mcp;
    member[key] = "none";
    const response = await app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod, rigRoot: f.root }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result.nodes.map((node: { status: string }) => node.status)).toEqual(["launched", "launched"]);
    const nodes = rigRepo.getRig(rig.id)!.nodes;
    expect(nodes.find(node => node.logicalId === "dev.owner")?.claudeMcp).toBe("none");
    expect(nodes.find(node => node.logicalId === "dev.reviewer")?.claudeMcp).toBeNull();
  });

  it.each([
    ["claude_mcp", null, "claude-code"], ["claudeMcp", null, "claude-code"],
    ["claude_mcp", "all", "claude-code"], ["claudeMcp", false, "claude-code"],
    ["claude_mcp", "none", "codex"], ["claudeMcp", "none", "codex"],
  ])("the expansion HTTP route rejects %s=%j on %s without creating members", async (key, value, runtime) => {
    const f = setup();
    const { app, rigRepo, tmuxAdapter } = createTestApp(f.db, { podInstantiatorFsOps: f.fsOps });
    const rig = rigRepo.createRig("invalid-expansion"), pod = f.raw.pods[0]!;
    const member = pod.members[0]! as Record<string, unknown>;
    delete member.claude_mcp;
    member[key as string] = value;
    member.runtime = runtime;
    const response = await app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod, rigRoot: f.root }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("claude_mcp");
    expect(rigRepo.getRig(rig.id)!.nodes).toEqual([]);
    expect(tmuxAdapter.createSession).not.toHaveBeenCalled();
  });

  it.each(["bootstrap", "materialize"])("%s keeps same-cwd agents independent through export, snapshot and saved-context resume", async mode => {
    const f = setup(), yaml = JSON.stringify(f.raw);
    const start = mode === "bootstrap" ? await f.inst.instantiate(yaml, f.root) : await f.inst.materialize(yaml, f.root);
    expect(start, JSON.stringify(start)).toMatchObject({ ok: true });
    if (!start.ok) throw Error("fixture did not start");
    const rigId = start.result.rigId;
    if (mode === "materialize") expect(await f.inst.launchMaterialized(yaml, f.root, rigId)).toMatchObject({ ok: true });
    const rig = f.rigRepo.getRig(rigId)!, owner = rig.nodes.find(n => n.logicalId === "dev.owner")!, reviewer = rig.nodes.find(n => n.logicalId === "dev.reviewer")!;
    expect(owner).toMatchObject({ claudeMcp: "none", cwd: reviewer.cwd });
    expect(reviewer.claudeMcp).toBeNull();
    expect(f.commands.find(c => c.session.startsWith("dev-owner") && c.command.includes("--session-id"))!.command).toContain("--strict-mcp-config");
    expect(f.commands.filter(c => c.session.startsWith("dev-reviewer")).some(c => c.command.includes("--mcp-config"))).toBe(false);
    const exported = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(f.exporter.exportRig(rigId))) as Record<string, unknown>);
    expect(exported.pods[0]!.members.find(m => m.id === "owner")?.claudeMcp).toBe("none");
    expect(exported.pods[0]!.members.find(m => m.id === "reviewer")?.claudeMcp).toBeUndefined();
    const snapshot = f.snapshotCapture.captureSnapshot(rigId, "manual");
    expect(snapshot.data.nodes.find(n => n.id === owner.id)?.claudeMcp).toBe("none");
    // Restore must use saved startup context, even after the original agent files disappear.
    for (const name of ["owner", "reviewer"]) fs.unlinkSync(path.join(f.root, "agents", name, "agent.yaml"));
    f.live.clear(); f.commands.length = 0;
    const restored = await f.restore.restore(snapshot.id, { adapters: { "claude-code": f.adapter }, fsOps: f.fsOps });
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    if (restored.ok) expect(restored.result.nodes.map(n => n.status), JSON.stringify(restored)).toEqual(["resumed", "resumed"]);
    const resumes = f.commands.filter(c => c.command.includes("claude ") && c.command.includes("--resume"));
    expect(resumes).toHaveLength(2);
    expect(resumes.find(c => c.session.startsWith("dev-owner"))!.command).toContain("--strict-mcp-config");
    expect(resumes.find(c => c.session.startsWith("dev-reviewer"))!.command).not.toContain("--mcp-config");
    for (const [file, bytes] of f.shared) expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });

  it("retains the opt-out through legacy instantiation, export and resume without startup context", async () => {
    const f = setup();
    const raw = { version: "0.1", name: "legacy-mcp", nodes: [{ id: "owner", runtime: "claude-code", cwd: f.root, claude_mcp: "none" }], edges: [] };
    const preflight = new RigSpecPreflight({ rigRepo: f.rigRepo, tmuxAdapter: f.tmux, exec: async () => "", cmuxExec: async () => "" });
    const start = await new RigInstantiator({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus,
      nodeLauncher: f.nodeLauncher, preflight }).instantiate(LegacyRigSpecSchema.normalize(raw));
    expect(start, JSON.stringify(start)).toMatchObject({ ok: true });
    if (!start.ok) throw Error("legacy fixture did not start");
    const rigId = start.result.rigId, owner = f.rigRepo.getRig(rigId)!.nodes[0]!;
    expect(owner.claudeMcp).toBe("none");
    const exported = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(f.exporter.exportRig(rigId) as LegacyRigSpec));
    expect(LegacyRigSpecSchema.validate(exported).valid).toBe(true);
    expect(LegacyRigSpecSchema.normalize(exported as Record<string, unknown>).nodes[0]!.claudeMcp).toBe("none");
    const session = f.sessionRegistry.getSessionsForRig(rigId)[0]!;
    f.db.prepare("UPDATE sessions SET resume_type='claude_id', resume_token='legacy-history', startup_status='ready' WHERE id=?").run(session.id);
    const snapshot = f.snapshotCapture.captureSnapshot(rigId, "manual");
    f.live.clear(); f.commands.length = 0;
    const restored = await f.restore.restore(snapshot.id);
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    const command = f.commands.find(c => c.command.includes("--resume 'legacy-history'"))!.command;
    expect(command).toContain("--strict-mcp-config");
    expect(command).toContain('{"mcpServers":{}}');
  });

  // A Claude member may also name its own subscription token (#2246): each setting is stored, launched and exported
  // beside the other, on pod members and on legacy flat nodes.
  it("keeps the opt-out beside the member's own subscription token through creation, launch and export", async () => {
    const f = setup(), ref = { label: "owner-sub", tokenFile: path.join(f.root, "owner.token") };
    Object.assign(f.raw.pods[0]!.members[0]!, { claude_token: { label: ref.label, file: ref.tokenFile } });
    expect(RigSpecSchema.validate(f.raw).errors).toEqual([]);
    const start = await f.inst.instantiate(JSON.stringify(f.raw), f.root);
    expect(start, JSON.stringify(start)).toMatchObject({ ok: true });
    if (!start.ok) throw Error("fixture did not start");
    const owner = f.rigRepo.getRig(start.result.rigId)!.nodes.find(n => n.logicalId === "dev.owner")!;
    expect(owner).toMatchObject({ claudeMcp: "none", claudeTokenRef: ref });
    expect(f.commands.find(c => c.session.startsWith("dev-owner") && c.command.includes("--session-id"))!.command).toContain("--strict-mcp-config");
    const member = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(f.exporter.exportRig(start.result.rigId))) as Record<string, unknown>)
      .pods[0]!.members.find(m => m.id === "owner");
    expect(member).toMatchObject({ claudeMcp: "none", claudeTokenRef: ref });

    const flat = f.rigRepo.createRig("flat");
    f.rigRepo.addNode(flat.id, "owner", { runtime: "claude-code", cwd: f.root, claudeMcp: "none", claudeTokenRef: ref });
    const exported = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(f.exporter.exportRig(flat.id) as LegacyRigSpec));
    expect(LegacyRigSpecSchema.validate(exported).errors).toEqual([]);
    expect(LegacyRigSpecSchema.normalize(exported as Record<string, unknown>).nodes[0]).toMatchObject({ claudeMcp: "none", claudeTokenRef: ref });
  });

  it.each([
    ["already bound", "none"], ["already bound", undefined],
    ["tmux failure", "none"], ["tmux failure", undefined],
  ] as const)("a launch rejected by %s preserves the saved choice: %s", async (failure, selection) => {
    const f = setup();
    f.raw.pods[0]!.members[0]!.claude_mcp = selection;
    const start = await f.inst.instantiate(JSON.stringify(f.raw), f.root);
    if (!start.ok) throw Error(JSON.stringify(start));
    const rigId = start.result.rigId;
    f.raw.pods[0]!.members[0]!.claude_mcp = selection === "none" ? undefined : "none";
    if (failure === "tmux failure") {
      f.live.clear();
      for (const session of f.sessionRegistry.getSessionsForRig(rigId)) {
        f.sessionRegistry.markDetached(session.id); f.sessionRegistry.clearBinding(session.nodeId);
      }
      vi.spyOn(f.tmux, "createSession").mockResolvedValue({ ok: false, code: "unknown", message: "fixture tmux failure" });
    }
    f.commands.length = 0;
    const result = await f.inst.launchMaterialized(JSON.stringify(f.raw), f.root, rigId);
    expect(result).toMatchObject({ ok: true, result: { nodes: expect.arrayContaining([
      expect.objectContaining({ logicalId: "dev.owner", status: "failed", error: expect.stringContaining(failure) }),
    ]) } });
    expect(f.commands).toEqual([]);
    expect(f.rigRepo.getRig(rigId)!.nodes.find(node => node.logicalId === "dev.owner")?.claudeMcp).toBe(selection ?? null);
  });

  it("clears the saved selection when a later authored launch omits it", async () => {
    const f = setup(), start = await f.inst.instantiate(JSON.stringify(f.raw), f.root);
    expect(start, JSON.stringify(start)).toMatchObject({ ok: true });
    if (!start.ok) throw Error("fixture did not start");
    f.raw.pods[0]!.members[0]!.claude_mcp = undefined;
    f.live.clear(); f.commands.length = 0;
    for (const session of f.sessionRegistry.getSessionsForRig(start.result.rigId)) {
      f.sessionRegistry.markDetached(session.id); f.sessionRegistry.clearBinding(session.nodeId);
    }
    expect(await f.inst.launchMaterialized(JSON.stringify(f.raw), f.root, start.result.rigId)).toMatchObject({ ok: true });
    expect(f.rigRepo.getRig(start.result.rigId)!.nodes.every(n => n.claudeMcp === null)).toBe(true);
    expect(f.commands.some(c => c.command.includes("--session-id"))).toBe(true);
    expect(f.commands.some(c => c.command.includes("--mcp-config"))).toBe(false);
  });

  it.each([null, "none"] as const)("a saved launch recipe uses the current selection, including clearing it: %s", async selection => {
    const f = setup(), start = await f.inst.materialize(JSON.stringify(f.raw), f.root);
    expect(start, JSON.stringify(start)).toMatchObject({ ok: true });
    if (!start.ok) throw Error("fixture did not materialize");
    const rigId = start.result.rigId, owner = f.rigRepo.getRig(rigId)!.nodes.find(n => n.logicalId === "dev.owner")!;
    expect(f.rigRepo.getNodeLaunchRecipe(owner.id)?.rigSpec.pods[0]!.members[0]!.claudeMcp).toBe("none");
    f.rigRepo.setNodeClaudeMcp(owner.id, selection);
    const result = await f.inst.launchPersistedFresh(rigId, owner.id);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "launched" });
    expect(f.commands.find(c => c.command.includes("--session-id"))!.command.includes("--strict-mcp-config")).toBe(selection === "none");
    expect(f.rigRepo.getRig(rigId)!.nodes.find(n => n.id === owner.id)!.claudeMcp).toBe(selection);
  });

  it("a first-start retry must retain the recorded MCP choice", async () => {
    const f = setup(), member = f.raw.pods[0]!.members.shift()!;
    const start = await f.inst.instantiate(JSON.stringify(f.raw), f.root);
    if (!start.ok) throw Error(JSON.stringify(start));
    const rigId = start.result.rigId;
    vi.spyOn(f.adapter, "project").mockResolvedValueOnce({ projected: [], skipped: [], failed: [{ effectiveId: "fixture", error: "EACCES: projection ancestor" }] });
    expect(await f.inst.addMemberToPod(rigId, "dev", member, f.root)).toMatchObject({ ok: true, result: { node: { status: "failed" } } });
    const owner = f.rigRepo.getRig(rigId)!.nodes.find(n => n.logicalId === "dev.owner")!;
    const session = f.sessionRegistry.getSessionsForRig(rigId).find(s => s.nodeId === owner.id)!;
    f.sessionRegistry.updateStatus(session.id, "exited"); f.sessionRegistry.clearBinding(owner.id); f.live.delete(session.sessionName);
    (f.tmux as { probeSession?: unknown }).probeSession = vi.fn(async () => ({ state: "absent" as const }));
    f.commands.length = 0;
    expect(await f.inst.retryFirstStart(rigId, owner.id, { ...member, claude_mcp: undefined }, f.root)).toMatchObject({ ok: false, code: "first_start_retry_refused" });
    expect(f.commands).toEqual([]);
    const retried = await f.inst.retryFirstStart(rigId, owner.id, member, f.root);
    expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, status: "launched" });
    expect(f.commands.find(c => c.command.includes("--session-id"))!.command).toContain("--strict-mcp-config");
  });

  it("refuses an unreadable saved choice before projection or native launch", async () => {
    const f = setup(), rig = f.rigRepo.createRig("invalid-mcp"), node = f.rigRepo.addNode(rig.id, "owner", { runtime: "claude-code", claudeMcp: "none" });
    f.db.pragma("ignore_check_constraints = ON");
    f.db.prepare("UPDATE nodes SET claude_mcp='corrupt' WHERE id=?").run(node.id);
    const session = f.sessionRegistry.registerSession(node.id, "owner@invalid-mcp"), project = vi.fn(), launchHarness = vi.fn();
    const result = await new StartupOrchestrator({ db: f.db, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus, tmuxAdapter: f.tmux }).startNode({
      rigId: rig.id, nodeId: node.id, sessionId: session.id, binding: { nodeId: node.id, tmuxSession: session.sessionName } as never,
      adapter: { runtime: "claude-code", project, launchHarness } as never, plan: { entries: [] } as never, resolvedStartupFiles: [], startupActions: [],
    });
    expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).toContain("claude_mcp");
    expect(project).not.toHaveBeenCalled(); expect(launchHarness).not.toHaveBeenCalled();
  });

  it.each(["codex", "pi", "terminal"])("rejects the setting on %s before creating nodes", async runtime => {
    const f = setup(); f.raw.pods[0]!.members[0]!.runtime = runtime;
    const result = RigSpecSchema.validate(f.raw);
    expect(result.valid).toBe(false); expect(result.errors.join(" ")).toMatch(/claude_mcp.*claude-code/);
  });

  it.each([null, true, false, "", "all", "NONE", [], { mode: "none" }])("rejects invalid authored values: %j", value => {
    const f = setup(); (f.raw.pods[0]!.members[0]! as Record<string, unknown>).claude_mcp = value;
    expect(RigSpecSchema.validate(f.raw)).toMatchObject({ valid: false, errors: expect.arrayContaining([expect.stringContaining("claude_mcp")]) });
    expect(LegacyRigSpecSchema.validate({ version: "0.1", name: "invalid", nodes: [{ id: "owner", runtime: "claude-code", claude_mcp: value }], edges: [] }).valid).toBe(false);
  });

  it("upgrades existing nodes without changing their default and persists a new opt-out atomically", () => {
    const db = new Database(":memory:"); cleanups.push(() => db.close());
    migrate(db, ALL_MIGRATIONS.filter(m => m.name !== "142_node_claude_mcp.sql"));
    const repo = new RigRepository(db), rig = repo.createRig("upgrade");
    const old = repo.addNode(rig.id, "old", { runtime: "claude-code" });
    expect(() => repo.addNode(rig.id, "unmigrated", { runtime: "claude-code", claudeMcp: "none" })).toThrow();
    expect(db.prepare("SELECT id FROM nodes WHERE logical_id='unmigrated'").get()).toBeUndefined();
    migrate(db, ALL_MIGRATIONS);
    expect(repo.getRig(rig.id)!.nodes.find(n => n.id === old.id)!.claudeMcp).toBeNull();
    expect(repo.addNode(rig.id, "new", { runtime: "claude-code", claudeMcp: "none" }).claudeMcp).toBe("none");
    expect(() => repo.addNode(rig.id, "wrong-runtime", { runtime: "codex", claudeMcp: "none" })).toThrow(/claude-code/);
  });
});
