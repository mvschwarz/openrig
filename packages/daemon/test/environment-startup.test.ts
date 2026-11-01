import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { EnvironmentError, EnvironmentPlatform, sha256, type EnvironmentBinding } from "../src/domain/environment-platform.js";
import { EnvironmentLifecycle } from "../src/domain/environment-lifecycle.js";
import { EnvironmentStartup } from "../src/domain/environment-startup.js";
import { OpenShellDriver } from "../src/adapters/openshell-driver.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "environment-startup-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const app = createTestApp(db), rig = app.rigRepo.createRig("startup-fixture");
  const node = app.rigRepo.addNode(rig.id, "team.worker", { runtime: "openshell-claude", cwd: root });
  const files = new Map<string, Buffer>(), resource = { id: "resource-one", name: "worker-one", workspace: "workspace", phase: "Ready", operationId: "create-one" };
  let native: Record<string, unknown> | undefined, losePrepare = false;
  const guest = vi.fn(async (_binding: unknown, args: string[]) => {
    if (args[0] === "--prepare") {
      native = JSON.parse(files.get("/sandbox/openrig/control/launch.pending.json")!.toString());
      if (losePrepare) throw new EnvironmentError("openshell_transport_unconfirmed", "Lost preparation reply");
      return { ok: true, ...native };
    }
    if (!native) throw new EnvironmentError("environment_native_unconfirmed", "Native is not observed");
    return { ok: true, ...native, pid: 1, running: true };
  });
  // The fixed CLI boundary is replaced; no OpenShell executable or provider is invoked.
  const driver = Object.assign(new OpenShellDriver(async () => { throw new Error("unexpected vendor invocation"); }), {
    list: async () => ({ complete: true, resources: [] }), create: async (input: { operationId: string }) => { resource.operationId = input.operationId; return resource; }, inspect: async () => resource,
    upload: async (_binding: unknown, source: string, destination: string) => { files.set(destination, readFileSync(source)); },
    read: async (_binding: unknown, path: string) => { const data = files.get(path); if (!data) throw new EnvironmentError("environment_file_missing", "No file"); return data; },
    guest,
  });
  const platform = new EnvironmentPlatform(db, driver), policy = join(root, "policy.yaml"), connection = join(root, "work.json");
  writeFileSync(policy, "version: 1\n");
  writeFileSync(connection, JSON.stringify({ version: 1, seat: "team-worker@startup-fixture", mcpUrl: "http://guest.test:7781/mcp", token: "fixture-work-token" }), { mode: 0o600 });
  await platform.create({ version: 1, bindingId: "binding-one", operationId: "create-one", nodeId: node.id, seat: "team-worker@startup-fixture", baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: "http://guest.test:7782", coordinationRef: connection,
    placement: { gateway: "gateway", workspace: "workspace", name: "worker-one", image: `image@sha256:${"a".repeat(64)}`, provider: "provider", policy } });
  const activity = vi.fn(async () => ({ grantId: "grant-one", env: { OPENRIG_ACTIVITY_HOOK_TOKEN: "scoped-fixture-token" } }));
  const startup = new EnvironmentStartup(platform, join(root, "stage"), activity);
  const binding = { nodeId: node.id, tmuxSession: "team-worker@startup-fixture", cwd: root, launchGeneration: "generation-one" } as NodeBinding;
  const plan = { runtime: "openshell-claude", cwd: root, entries: [], conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] } } as ProjectionPlan;
  const tmux = { sendShellCommand: vi.fn(async () => ({ ok: true as const })) };
  await startup.project(plan, binding);
  return { root, db, app, node, rig, files, resource, startup, platform, activity, guest, tmux, binding, losePrepare: () => { losePrepare = true; } };
}
it("stages all resolved startup inputs before native dispatch and binds separate work/activity connections", async () => {
  const f = await fixture(), role = join(f.root, "role.md"); writeFileSync(role, "Current nonce and useful task guidance");
  await f.startup.deliverStartup([{ path: "role.md", absolutePath: role, ownerRoot: f.root, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], f.binding);
  const result = await f.startup.launch(f.binding, {}, f.tmux);
  expect(result.ok).toBe(true);
  expect(f.files.get("/sandbox/openrig/work/.openrig/startup/role.md")!.toString()).toBe("Current nonce and useful task guidance");
  expect(f.files.get("/sandbox/openrig/work/CLAUDE.md")!.toString()).toContain("Read /sandbox/openrig/work/.openrig/startup/role.md");
  expect(f.activity).toHaveBeenCalledWith({ nodeId: f.binding.nodeId, generation: "generation-one", seat: "team-worker@startup-fixture", guestBaseUrl: "http://guest.test:7782" });
  const coordination = f.files.get("/sandbox/openrig/control/coordination.json")!.toString();
  expect(coordination).toContain("fixture-work-token"); expect(coordination).not.toContain("scoped-fixture-token");
  const receipt = f.db.prepare("SELECT receipt_json FROM environment_operations WHERE kind='launch'").get() as { receipt_json: string };
  expect(receipt.receipt_json).toContain("grant-one"); expect(receipt.receipt_json).not.toContain("fixture-token");
  expect(f.tmux.sendShellCommand).toHaveBeenCalledTimes(1);
});
it("reconciles a lost latch reply without issuing another grant or rewriting an execution", async () => {
  const f = await fixture(); f.losePrepare();
  await expect(f.startup.launch(f.binding, {}, f.tmux)).rejects.toThrow("Lost preparation reply");
  const before = sha256(f.files.get("/sandbox/openrig/control/launch.pending.json")!);
  expect((await f.startup.launch(f.binding, {}, f.tmux)).ok).toBe(true);
  expect(f.activity).toHaveBeenCalledTimes(1); expect(f.guest.mock.calls.filter(call => call[1][0] === "--prepare")).toHaveLength(1);
  expect(sha256(f.files.get("/sandbox/openrig/control/launch.pending.json")!)).toBe(before);
});
it("blocks a changed required source before issuing a grant or preparing native", async () => {
  const f = await fixture(), role = join(f.root, "role.md"); writeFileSync(role, "selected source");
  await f.startup.deliverStartup([{ path: "role.md", absolutePath: role, ownerRoot: f.root, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], f.binding);
  writeFileSync(role, "changed after resolution");
  await expect(f.startup.launch(f.binding, {}, f.tmux)).rejects.toMatchObject({ code: "environment_projection_source_changed" });
  expect(f.activity).not.toHaveBeenCalled(); expect(f.guest).not.toHaveBeenCalled(); expect(f.tmux.sendShellCommand).not.toHaveBeenCalled();
});
it("refuses an exact-resume request without launching a fresh native", async () => {
  const f = await fixture();
  await expect(f.startup.launch(f.binding, { resumeToken: "saved-conversation", resumeType: "community:openshell-claude" }, f.tmux)).rejects.toMatchObject({ code: "environment_checkpoint_missing" });
  expect(f.activity).not.toHaveBeenCalled(); expect(f.tmux.sendShellCommand).not.toHaveBeenCalled();
});

it("preserves running destination bytes and export generation before an attempted new-generation projection", async () => {
  const f = await fixture(); expect((await f.startup.launch(f.binding, {}, f.tmux)).ok).toBe(true);
  const before = sha256(f.files.get("/sandbox/openrig/work/CLAUDE.md")!);
  const plan = { runtime: "openshell-claude", cwd: f.root, entries: [], conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] } } as ProjectionPlan;
  await expect(f.startup.project(plan, { ...f.binding, launchGeneration: "generation-two" })).rejects.toMatchObject({ code: "environment_prior_execution_unconfirmed" });
  expect(sha256(f.files.get("/sandbox/openrig/work/CLAUDE.md")!)).toBe(before);
  expect(f.platform.get("binding-one")?.generation).toBe("generation-one"); expect(f.activity).toHaveBeenCalledTimes(1);
});

it("transfers exact retained history onto explicitly recreated compute and requests the original native conversation", async () => {
  const f = await fixture(); const first = await f.startup.launch(f.binding, {}, f.tmux);
  expect(first.ok).toBe(true); if (!first.ok || !first.resumeToken) throw new Error("Missing native receipt");
  const path = `native/projects/-sandbox-openrig-work/${first.resumeToken}.jsonl`;
  const history = Buffer.from(JSON.stringify({ sessionId: first.resumeToken, type: "user", message: { content: "retained earlier context" } }) + "\n");
  f.files.set(`/sandbox/openrig/${path}`, history);
  Object.assign(f.platform.driver, { checkpointFiles: async () => [{ path, sha256: sha256(history), bytes: history.length }],
    captureCleanup: undefined, cleanupState: async () => ({ workload: false, supervisor: false, volumes: false }) });
  const lifecycle = new EnvironmentLifecycle(f.platform, undefined, join(f.root, "retained"));
  const checkpoint = await lifecycle.checkpoint("binding-one", { operationId: "checkpoint-one", generation: "generation-one" });
  f.resource.id = "successor-resource"; f.resource.name = "worker-two"; f.files.clear();
  const placement = { ...f.platform.get("binding-one")!.placement, name: "worker-two" };
  const recreated = await lifecycle.recreate("binding-one", { operationId: "recreate-one", generation: "generation-one", checkpointId: checkpoint.checkpointId,
    resumeType: "community:openshell-claude", resumeToken: first.resumeToken, placement });
  expect(recreated).toMatchObject({ predecessorResourceId: "resource-one", successorResourceId: "successor-resource", nativeId: first.resumeToken });
  const binding = { ...f.binding, launchGeneration: "generation-two" };
  const plan = { runtime: "openshell-claude", cwd: f.root, entries: [], conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] } } as ProjectionPlan;
  await f.startup.preflight(binding, { resumeToken: first.resumeToken, resumeType: "community:openshell-claude" });
  await f.startup.project(plan, binding);
  const result = await f.startup.launch(binding, { resumeToken: first.resumeToken, resumeType: "community:openshell-claude" }, f.tmux);
  expect(result).toMatchObject({ ok: true, resumeToken: first.resumeToken, resumeType: "community:openshell-claude" });
  expect(f.files.get(`/sandbox/openrig/${path}`)).toEqual(history);
  const descriptor = JSON.parse(f.files.get("/sandbox/openrig/control/launch.pending.json")!.toString());
  expect(descriptor.resumeToken).toBe(first.resumeToken); expect(descriptor.nativeId).toBe(first.resumeToken);
  expect(descriptor.checkpoint.files[0]).toMatchObject({ path, sha256: sha256(history), bytes: history.length });
  expect(f.activity).toHaveBeenCalledTimes(2); expect(f.tmux.sendShellCommand).toHaveBeenCalledTimes(2);
});
it("refuses a new generation before projecting over a saved execution", async () => {
  const f = await fixture(); expect((await f.startup.launch(f.binding, {}, f.tmux)).ok).toBe(true);
  const before = [...f.files].map(([key,value]) => [key,value.toString("base64")]);
  const generation = f.platform.get("binding-one")!.generation;
  await expect(f.startup.project({ entries: [] } as unknown as ProjectionPlan, { ...f.binding, launchGeneration: "generation-two" })).rejects.toMatchObject({ code: "environment_prior_execution_unconfirmed" });
  expect([...f.files].map(([key,value]) => [key,value.toString("base64")])).toEqual(before);
  expect(f.platform.get("binding-one")!.generation).toBe(generation);
});
it("refuses startup input replacement before touching a saved execution", async () => {
  const f = await fixture(); expect((await f.startup.launch(f.binding, {}, f.tmux)).ok).toBe(true);
  const before = [...f.files].map(([key,value]) => [key,value.toString("base64")]);
  await expect(f.startup.deliverStartup([], f.binding)).rejects.toMatchObject({ code: "environment_prior_execution_unconfirmed" });
  expect([...f.files].map(([key,value]) => [key,value.toString("base64")])).toEqual(before);
});

it.each(["unchanged", "missing-source", "changed", "added", "removed", "stale-destination", "missing-destination", "missing-history", "changed-history"])("normal exact restore on recreated compute verifies current destination context (%s) without conversation replay", async mode => {
  const f = await fixture();
  // Normal restore reads the installed preset, rather than the adapter constructor alone.
  const home = join(f.root, "openrig-home"), presets = join(home, "community-harnesses");
  mkdirSync(presets, { recursive: true });
  writeFileSync(join(presets, "openshell-claude.yaml"), readFileSync(new URL("../assets/openshell/preset.yaml", import.meta.url)));
  vi.stubEnv("OPENRIG_HOME", home); cleanup.push(() => vi.unstubAllEnvs());
  const role = join(f.root, "role.md"), skill = join(f.root, "skill"), plugin = join(f.root, "plugin"), startupFile = join(f.root, "startup.md");
  mkdirSync(skill); mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(role, "Required restored role"); writeFileSync(join(skill, "SKILL.md"), "Required restored skill");
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), '{"name":"restored-plugin","version":"1.0.0"}');
  writeFileSync(startupFile, "Required filesystem startup, never conversation input");
  writeFileSync(join(skill, "old-reference.md"), "Old declared skill reference");
  const entries = [["guidance", "role", role], ["skill", "skill", skill], ["plugin", "plugin", plugin]].map(([category, effectiveId, absolutePath]) =>
    ({ category, effectiveId, absolutePath, resourcePath: absolutePath, sourcePath: absolutePath, sourceSpec: "fixture", classification: "safe_projection", mergeStrategy: "managed_block" }));
  const files = [{ path: "startup.md", absolutePath: startupFile, ownerRoot: f.root, required: true, deliveryHint: "send_text", appliesOn: ["fresh_start"] }];
  const plan = { runtime: "openshell-claude", cwd: f.root, entries, conflicts: [], noOps: [], diagnostics: [], startup: { files, actions: [] } } as unknown as ProjectionPlan;
  await f.startup.project(plan, f.binding);
  await f.startup.deliverStartup(files as never, f.binding);
  const first = await f.startup.launch(f.binding, {}, f.tmux);
  const nativePath = `native/projects/-sandbox-openrig-work/${first.resumeToken}.jsonl`;
  const history = Buffer.from(JSON.stringify({ sessionId: first.resumeToken, type: "user", message: { content: "unchanged retained history" } }) + "\n");
  f.files.set(`/sandbox/openrig/${nativePath}`, history);
  Object.assign(f.platform.driver, { checkpointFiles: async () => [{ path: nativePath, sha256: sha256(history), bytes: history.length }],
    captureCleanup: async (binding: EnvironmentBinding, socket: string) => ({ version: 1, host: "fixture", uid: 1000, socket, socketDevice: 1, socketInode: 2,
      resourceId: binding.resource!.id, workspace: binding.placement.workspace, workloadId: "a".repeat(64), supervisorId: "b".repeat(64), volumes: [] }),
    cleanupState: async () => ({ workload: false, supervisor: false, volumes: false }) });
  const lifecycle = new EnvironmentLifecycle(f.platform, undefined, join(f.root, "retained"));
  const checkpoint = await lifecycle.checkpoint("binding-one", { operationId: "context-checkpoint", generation: "generation-one" });
  f.db.prepare("INSERT INTO pods(id,rig_id,label) VALUES ('restore-pod',?,'Team')").run(f.rig.id);
  f.db.prepare("UPDATE nodes SET pod_id='restore-pod' WHERE id=?").run(f.node.id);
  const session = f.app.sessionRegistry.registerSession(f.node.id, f.binding.tmuxSession!);
  f.app.sessionRegistry.updateStatus(session.id, "running");
  f.app.sessionRegistry.recordLauncherReportedToken(session.id, "community:openshell-claude", first.resumeToken!);
  f.app.sessionRegistry.recordCommunityHarnessSelection(session.id, "openshell-claude", false);
  f.db.prepare("INSERT INTO node_startup_context(node_id,projection_entries_json,resolved_files_json,startup_actions_json,runtime) VALUES (?,?,?,?,?)")
    .run(f.node.id, JSON.stringify(entries), JSON.stringify(files), JSON.stringify([{ type: "send_text", text: "NEVER REPLAY", phase: "after_ready" }]), "openshell-claude");
  const snapshot = f.app.snapshotCapture.captureSnapshot(f.rig.id, "manual");
  // Delete captures the predecessor's actual host/engine before recreate compares its successor.
  expect(await lifecycle.effect("binding-one", { operationId: "context-delete", generation: "generation-one", effect: "delete-owned", engineSocket: "/owned/engine.sock" }))
    .toMatchObject({ state: "confirmed", remaining: { workload: false, supervisor: false, volumes: false } });
  const inventory = f.db.prepare("SELECT receipt_json FROM environment_operations WHERE operation_id='inventory-resource-one'").get() as { receipt_json: string };
  expect(JSON.parse(inventory.receipt_json)).toMatchObject({ host: "fixture", uid: 1000, socket: "/owned/engine.sock", socketDevice: 1, socketInode: 2, resourceId: "resource-one" });
  f.resource.id = "successor-resource"; f.resource.name = "worker-successor";
  await lifecycle.recreate("binding-one", { operationId: "context-recreate", generation: "generation-one", checkpointId: checkpoint.checkpointId,
    resumeType: "community:openshell-claude", resumeToken: first.resumeToken!, placement: { ...f.platform.get("binding-one")!.placement, name: "worker-successor" } });
  f.files.clear();
  f.app.sessionRegistry.updateStatus(session.id, "exited"); f.app.sessionRegistry.clearBinding(f.node.id);
  if (mode === "missing-source") rmSync(startupFile);
  if (mode === "changed") writeFileSync(join(skill, "SKILL.md"), "Current skill revision for report 2");
  if (mode === "added") writeFileSync(join(skill, "new-reference.md"), "Current added skill reference");
  if (mode === "removed") rmSync(join(skill, "old-reference.md"));
  if (mode === "missing-history") rmSync(checkpoint.files[0].source);
  if (mode === "changed-history") writeFileSync(checkpoint.files[0].source, "Changed retained history");
  const upload = f.platform.driver.upload.bind(f.platform.driver);
  if (mode === "stale-destination" || mode === "missing-destination") {
    vi.spyOn(f.platform.driver, "upload").mockImplementation(async (...args) => {
      await upload(...args);
      if (args[2] === "/sandbox/openrig/work/.claude/skills/skill/SKILL.md") {
        if (mode === "stale-destination") f.files.set(args[2], Buffer.from("Stale destination revision"));
        else f.files.delete(args[2]);
      }
    });
  }
  const nativePrepare = f.guest.getMockImplementation()!;
  let restored = false;
  f.guest.mockImplementation(async (binding, args) => {
    if (args[0] === "--prepare") {
      restored = true;
      expect(f.files.get("/sandbox/openrig/work/.openrig/context/role")?.toString()).toBe("Required restored role");
      expect(f.files.get("/sandbox/openrig/work/.claude/skills/skill/SKILL.md")?.toString()).toBe(mode === "changed" ? "Current skill revision for report 2" : "Required restored skill");
      if (mode === "added") expect(f.files.get("/sandbox/openrig/work/.claude/skills/skill/new-reference.md")?.toString()).toBe("Current added skill reference");
      if (mode === "removed") expect(f.files.has("/sandbox/openrig/work/.claude/skills/skill/old-reference.md")).toBe(false);
      expect(f.files.get("/sandbox/openrig/work/.claude/plugins/plugin/.claude-plugin/plugin.json")).toBeDefined();
      expect(f.files.get("/sandbox/openrig/work/.openrig/startup/startup.md")?.toString()).toBe("Required filesystem startup, never conversation input");
      expect(f.files.get(`/sandbox/openrig/${nativePath}`)).toEqual(history);
      const descriptor = JSON.parse(f.files.get("/sandbox/openrig/control/launch.pending.json")!.toString());
      expect(descriptor.resumeToken).toBe(first.resumeToken); expect(descriptor.plugins).toHaveLength(1);
    }
    return nativePrepare(binding, args);
  });
  // The host viewer is a rig process, not evidence of the guest's native conversation.
  Object.assign(f.app.tmuxAdapter, {
    listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: f.root, width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 7001), getPaneCommand: vi.fn(async () => "rig"),
  });
  vi.spyOn(f.app.tmuxAdapter, "sendShellCommand").mockResolvedValue({ ok: true });
  const textInput = vi.spyOn(f.app.tmuxAdapter, "sendText");
  const adapter = new CommunityHarnessRuntimeAdapter("openshell-claude", { tmux: f.app.tmuxAdapter, environmentStartup: f.startup });
  vi.spyOn(adapter, "checkReady").mockResolvedValue({ ready: true });
  const result = await f.app.restoreOrchestrator.restore(snapshot.id, { adapters: { "openshell-claude": adapter }, fsOps: { exists: existsSync } });
  const restoredNode = result.ok ? result.result.nodes.find(node => node.nodeId === f.node.id) : undefined;
  if (["unchanged", "changed", "added", "removed"].includes(mode)) { expect(restoredNode?.status, JSON.stringify(result)).toBe("resumed"); expect(restored).toBe(true); }
  else { expect(restored).toBe(false); expect(restoredNode?.status).not.toBe("resumed"); }
  expect(textInput).not.toHaveBeenCalled();
});
