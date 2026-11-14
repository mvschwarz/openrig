import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { defaultProbeRuntimes } from "../src/domain/kernel-boot.js";
import { writeFileSync } from "node:fs";

vi.mock("../src/domain/kernel-boot.js", async original => ({
  ...await original<typeof import("../src/domain/kernel-boot.js")>(),
  defaultProbeRuntimes: vi.fn(async () => ({ codex: "ok", claudeCode: "ok" })),
}));

const tokenA = "native-history-A-private";
const tokenB = "native-history-B-private";

describe("selected-history startup", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { appDeps: { terminalBearerToken: "terminal-test-token" } });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "ok", claudeCode: "ok" });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  function fixture(podAware = false, runtime: "codex" | "claude-code" = "codex") {
    const rig = setup.rigRepo.createRig("selected-history-startup");
    if (podAware) db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES ('pod-selected', ?, 'desk', 'Desk')").run(rig.id);
    const node = setup.rigRepo.addNode(rig.id, "desk.lead", { runtime, model: "snapshot-model",
      ...(podAware ? { podId: "pod-selected" } : {}) });
    const sibling = setup.rigRepo.addNode(rig.id, "desk.other", { runtime: "codex" });
    if (podAware) db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', ?)").run(node.id, runtime);
    const old = setup.sessionRegistry.registerSession(node.id, "old@selected-history-startup");
    setup.sessionRegistry.updateStatus(old.id, "exited");
    const active = setup.sessionRegistry.registerSession(node.id, "active@selected-history-startup");
    setup.sessionRegistry.updateStatus(active.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: active.sessionName, tmuxPane: "%1" });
    db.prepare("UPDATE sessions SET resume_type=?, resume_token=? WHERE id=?").run(runtime === "codex" ? "codex_id" : "claude_name", tokenA, old.id);
    db.prepare("UPDATE sessions SET resume_type=?, resume_token=? WHERE id=?").run(runtime === "codex" ? "codex_id" : "claude_name", tokenB, active.id);
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    const path = `/api/startup/${rig.id}/nodes/${node.id}`;
    const refs = { snapshotId: snapshot.id, historySessionId: old.id };
    return { rig, node, sibling, old, active, snapshot, path, refs };
  }
  const request = (path: string, body?: unknown, auth = true) => setup.app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(auth ? { Authorization: "Bearer terminal-test-token" } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function review(f: ReturnType<typeof fixture>) {
    const response = await request(`${f.path}?snapshotId=${f.refs.snapshotId}&historySessionId=${f.refs.historySessionId}`);
    return { response, body: await response.json() as Record<string, unknown> };
  }

  it("reviews older A with no writes, native preparation, or token disclosure", async () => {
    const f = fixture();
    const writes = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const capture = vi.spyOn(setup.snapshotCapture, "captureSnapshot");
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const { response, body } = await review(f);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, nodeId: f.node.id, historySessionId: f.old.id,
      snapshotId: f.snapshot.id, forecast: { occupantSessionId: f.old.id, intendedAction: "resume-original" },
      settingsSource: { model: { value: "snapshot-model", source: "snapshot" } }, mutated: false });
    expect(JSON.stringify(body)).not.toContain(tokenA);
    expect(JSON.stringify(body)).not.toContain(tokenB);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writes);
    expect(capture).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    expect(defaultProbeRuntimes).not.toHaveBeenCalled();
    expect((await request(`${f.path}?snapshotId=${f.refs.snapshotId}&historySessionId=${f.refs.historySessionId}`, undefined, false)).status).toBe(401);
  });

  it.each(["model", "source", "permission", "snapshot"] as const)("refuses %s drift before a terminal effect", async change => {
    const f = fixture(); const { body } = await review(f);
    if (change === "model") db.prepare("UPDATE nodes SET model='later' WHERE id=?").run(f.node.id);
    if (change === "source") db.prepare("UPDATE sessions SET resume_token='later' WHERE id=?").run(f.old.id);
    if (change === "permission") db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES (?, 'codex', 'floor', 'test', 'drift')").run(f.node.id);
    if (change === "snapshot") db.prepare("UPDATE snapshots SET status='invalid' WHERE id=?").run(f.snapshot.id);
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    expect(response.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(tokenA);
  });

  it.each(["token", "type", "provenance", "policy", "harness", "removed"] as const)("refuses a captured history whose live %s already disagrees before review", async change => {
    const f = fixture();
    if (change === "token") db.prepare("UPDATE sessions SET resume_token='other-native-id' WHERE id=?").run(f.old.id);
    if (change === "type") db.prepare("UPDATE sessions SET resume_type='claude_name' WHERE id=?").run(f.old.id);
    if (change === "provenance") db.prepare("UPDATE sessions SET resume_provenance='hook' WHERE id=?").run(f.old.id);
    if (change === "policy") db.prepare("UPDATE sessions SET restore_policy='never' WHERE id=?").run(f.old.id);
    if (change === "harness") db.prepare("UPDATE sessions SET agent_app='codex' WHERE id=?").run(f.old.id);
    if (change === "removed") db.prepare("DELETE FROM sessions WHERE id=?").run(f.old.id);
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    const response = await review(f);
    expect(response.response.status).toBe(409);
    expect(response.body).toMatchObject({ ok: false });
    expect(JSON.stringify(response.body)).not.toContain(tokenA);
    expect(JSON.stringify(response.body)).not.toContain(tokenB);
    expect(create).not.toHaveBeenCalled();
  });

  it("shows the consumed Codex member envelope in a read-only review", async () => {
    const f = fixture();
    db.prepare("UPDATE nodes SET codex_permissions_json=? WHERE id=?")
      .run(JSON.stringify({ sandbox: "read-only", approval: "never" }), f.node.id);
    const writes = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const { response, body } = await review(f);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ settingsSource: { permission: { mode: null, source: "member_envelope",
      plannedOverride: { codexPermissions: { sandbox: "read-only", approval: "never" } } } } });
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writes);
  });

  it("shows Claude's explicit mode and saved tool rules together", async () => {
    const f = fixture(false, "claude-code");
    db.prepare("UPDATE nodes SET claude_permissions_json=? WHERE id=?")
      .run(JSON.stringify({ allow: ["Read"], deny: ["Bash(rm *)"] }), f.node.id);
    db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES (?, 'claude-code', 'acceptEdits', 'test', 'review')")
      .run(f.node.id);
    const { response, body } = await review(f);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ settingsSource: { permission: { mode: "acceptEdits", source: "saved_choice",
      rulesSource: "member_rules", plannedOverride: { permissionMode: "acceptEdits",
        claudePermissions: { allow: ["Read"], deny: ["Bash(rm *)"] } } } } });
  });

  it("reviews the re-derived custom posture consumed at Claude dispatch", async () => {
    const f = fixture(false, "claude-code");
    const dir = process.env.HOME!;
    const target = `${dir}/selected-member.policy.md`;
    setup.rigRepo.setNodePermissionPolicy(f.node.id, "selected-member.policy.md");
    setup.rigRepo.setNodePolicyProvenance(f.node.id, { origin: "custom", resolvedTarget: target,
      declaringDir: dir, launchPosture: "floor" });
    const policy = (posture: string) => `---\nsource: custom\nname: member-policy\nsurface: flag\nlaunch_posture: ${posture}\npolicy_schema_version: 1\ndescription: Selected history fixture\n---\n`;
    writeFileSync(target, policy("full_bypass"));
    const writes = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const { response, body } = await review(f);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ settingsSource: { permission: { mode: "full_bypass", source: "member_spec",
      plannedLaunchPosture: "full_bypass" } } });
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writes);
    const native = vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "fixture" });
    await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    expect(native).toHaveBeenCalledOnce();
    expect(native.mock.calls[0]?.[4]).toBe("full_bypass");

  });

  it("requires re-review when the resolved custom policy decision changes", async () => {
    const f = fixture(false, "claude-code");
    const dir = process.env.HOME!;
    const target = `${dir}/selected-member.policy.md`;
    setup.rigRepo.setNodePermissionPolicy(f.node.id, "selected-member.policy.md");
    setup.rigRepo.setNodePolicyProvenance(f.node.id, { origin: "custom", resolvedTarget: target,
      declaringDir: dir, launchPosture: "floor" });
    const policy = (posture: string) => `---\nsource: custom\nname: member-policy\nsurface: flag\nlaunch_posture: ${posture}\npolicy_schema_version: 1\ndescription: Selected history fixture\n---\n`;
    writeFileSync(target, policy("full_bypass"));
    const accepted = await review(f);
    expect(accepted.response.status).toBe(200);
    writeFileSync(target, policy("floor"));
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    const changed = await request(f.path, { action: "resume", ...f.refs, revision: accepted.body.revision });
    expect(changed.status).toBe(409);
    expect((await changed.json() as { code: string }).code).toBe("selection_changed");
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["creation", "pane observation"] as const)("preserves a real self-attachment during %s", async boundary => {
    const f = fixture(); const { body } = await review(f);
    let replacementBinding: string | undefined;
    const attach = async () => {
      const attached = await setup.selfAttachService.attachToNode({ rigId: f.rig.id, logicalId: f.node.logicalId,
        context: { attachmentType: "tmux", tmuxSession: "claimant@selected-history-startup", tmuxPane: "%99" } });
      expect(attached.ok).toBe(true);
      replacementBinding = setup.sessionRegistry.getBindingForNode(f.node.id)?.id;
    };
    if (boundary === "creation") setup.tmuxAdapter.createSession = vi.fn(async () => { await attach(); return { ok: true as const }; });
    else setup.tmuxAdapter.listPanes = vi.fn(async () => { await attach(); return []; });
    const native = vi.spyOn(CodexResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "fixture" });
    const kill = vi.spyOn(setup.tmuxAdapter, "killSession");
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ ok: false, resultSessionId: null });
    expect(setup.sessionRegistry.getBindingForNode(f.node.id)).toMatchObject({ id: replacementBinding,
      tmuxSession: "claimant@selected-history-startup" });
    expect(native).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("reports a conflicting persisted Codex mode and envelope as an unavailable permission choice", async () => {
    const f = fixture();
    db.prepare("UPDATE nodes SET codex_permissions_json=? WHERE id=?")
      .run(JSON.stringify({ sandbox: "read-only", approval: "never" }), f.node.id);
    db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES (?, 'codex', 'floor', 'test', 'conflict')")
      .run(f.node.id);
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    const result = await review(f);
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false, code: "permission_unavailable",
      message: "The selected seat's saved permission choice needs repair before launch." });
    expect(JSON.stringify(result.body)).not.toContain(tokenA);
    expect(JSON.stringify(result.body)).not.toContain(tokenB);
    expect(launch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("reports permission failure found by the review post-observation recheck", async () => {
    const f = fixture();
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    setup.tmuxAdapter.probeSession = vi.fn(async () => {
      db.prepare("UPDATE nodes SET codex_permissions_json=? WHERE id=?")
        .run(JSON.stringify({ sandbox: "read-only", approval: "never" }), f.node.id);
      db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES (?, 'codex', 'floor', 'test', 'conflict')")
        .run(f.node.id);
      return { state: "absent" as const };
    });
    const result = await review(f);
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false, code: "permission_unavailable",
      message: "The selected seat's saved permission choice needs repair before launch." });
    expect(JSON.stringify(result.body)).not.toContain(tokenA);
    expect(JSON.stringify(result.body)).not.toContain(tokenB);
    expect(launch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("reports a permission conflict before apply can launch a reviewed history", async () => {
    const f = fixture();
    const accepted = await review(f);
    expect(accepted.response.status).toBe(200);
    db.prepare("UPDATE nodes SET codex_permissions_json=? WHERE id=?")
      .run(JSON.stringify({ sandbox: "read-only", approval: "never" }), f.node.id);
    db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES (?, 'codex', 'floor', 'test', 'conflict')")
      .run(f.node.id);
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    const native = vi.spyOn(CodexResumeAdapter.prototype, "resume");
    const response = await request(f.path, { action: "resume", ...f.refs, revision: accepted.body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ ok: false, code: "permission_unavailable",
      message: "The selected seat's saved permission choice needs repair before launch." });
    expect(JSON.stringify(result)).not.toContain(tokenA);
    expect(JSON.stringify(result)).not.toContain(tokenB);
    expect(launch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("keeps typed IDs and outcome intact when a short Claude name appears in diagnostics", async () => {
    const f = fixture(false, "claude-code");
    const saved = db.prepare("SELECT data FROM snapshots WHERE id=?").get(f.snapshot.id) as { data: string };
    const data = JSON.parse(saved.data) as { sessions: Array<{ id: string; resumeToken: string | null }> };
    data.sessions.find(row => row.id === f.old.id)!.resumeToken = "A";
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(data), f.snapshot.id);
    db.prepare("UPDATE sessions SET resume_token='A' WHERE id=?").run(f.old.id);
    const { body } = await review(f);
    expect(body).toMatchObject({ ok: true, nodeId: f.node.id, snapshotId: f.snapshot.id,
      historySessionId: f.old.id });
    vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "Native name A needs attention" });
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, nodeId: f.node.id, snapshotId: f.snapshot.id,
      historySessionId: f.old.id, sourceSessionId: f.old.id, resultSessionId: expect.any(String), code: "attention_required" });
    expect(result.message).toContain("[redacted]");
    expect(result.message).not.toContain("name A");
  });

  it("rejects ambiguous or downgrade requests without effects", async () => {
    const f = fixture(); const { body } = await review(f);
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    for (const invalid of [
      { action: "fresh", ...f.refs, revision: body.revision },
      { action: "resume", ...f.refs, revision: body.revision, resumeToken: tokenB },
      { action: "resume", historySessionId: f.old.id, revision: body.revision },
    ]) expect((await request(f.path, invalid)).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps a reviewed choice valid when only a sibling seat changes", async () => {
    const f = fixture(); const { body } = await review(f);
    db.prepare("UPDATE nodes SET model='sibling-only-change' WHERE id=?").run(f.sibling.id);
    const native = vi.spyOn(CodexResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "fixture native refusal" });
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    expect(response.status).toBe(409);
    expect(native).toHaveBeenCalledOnce();
    expect(native.mock.calls[0]![2]).toBe(tokenA);
  });

  it("passes older A to the legacy native adapter and reports its actual failed attempt", async () => {
    const f = fixture(); const { body } = await review(f);
    const native = vi.spyOn(CodexResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "fixture native refused" });
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(native).toHaveBeenCalled();
    expect(native.mock.calls[0]![2]).toBe(tokenA);
    expect(JSON.stringify(result)).not.toContain(tokenA);
    expect(JSON.stringify(result)).not.toContain(tokenB);
    expect(result).toMatchObject({ ok: false, sourceSessionId: f.old.id, resultSessionId: expect.any(String) });
    expect(setup.sessionRegistry.getSessionsForRig(f.rig.id).some(row => row.id === f.active.id)).toBe(true);
    expect(setup.rigRepo.getRig(f.rig.id)!.nodes.find(node => node.id === f.sibling.id)).toBeTruthy();
  });

  it("keeps exact Claude identity through the selected legacy path without certifying an uncertain launch", async () => {
    const f = fixture(false, "claude-code"); const { body } = await review(f);
    expect(body).toMatchObject({ ok: true, historySessionId: f.old.id,
      forecast: { occupantSessionId: f.old.id, intendedAction: "resume-original" } });
    const native = vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "fixture chooser" });
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(native.mock.calls[0]![2]).toBe(tokenA);
    expect(result).toMatchObject({ ok: false, sourceSessionId: f.old.id, resultSessionId: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(tokenA);
    expect(JSON.stringify(result)).not.toContain(tokenB);
  });

  it("reports a resumed launch as unconfirmed when final ownership detects selection drift", async () => {
    setup = createTestApp(db, { listProcesses: async () => [
      { pid: 1234, ppid: 1, command: "zsh" },
      { pid: 1235, ppid: 1234, command: `claude --resume ${tokenA}` },
    ], appDeps: { terminalBearerToken: "terminal-test-token" } });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    setup.tmuxAdapter.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]);
    setup.tmuxAdapter.getPanePid = vi.fn(async () => 1234);
    setup.tmuxAdapter.getPaneCommand = vi.fn(async () => "claude");
    const f = fixture(false, "claude-code"); const { body } = await review(f);
    const originalLaunch = setup.restoreOrchestrator.launchSingleNode.bind(setup.restoreOrchestrator);
    let actualOutcomeStatus: string | undefined;
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode").mockImplementation(async (rigId, logicalId, opts) => {
      const result = await originalLaunch(rigId, logicalId, opts);
      actualOutcomeStatus = result.launched?.[0]?.status;
      db.prepare("UPDATE nodes SET model='changed-after-resume' WHERE id=?").run(f.node.id);
      return result;
    });
    const native = vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockResolvedValue({ ok: true });
    const kill = vi.spyOn(setup.tmuxAdapter, "killSession");
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ ok: false, sourceSessionId: f.old.id, resultSessionId: expect.any(String), code: "resume_unconfirmed" });
    expect(result.resultSessionId).not.toBe(f.old.id);
    expect(actualOutcomeStatus).toBe("resumed");
    expect(JSON.stringify(result)).not.toContain(tokenA);
    expect(JSON.stringify(result)).not.toContain(tokenB);
    expect(launch).toHaveBeenCalledOnce();
    expect(native).toHaveBeenCalledOnce();
    expect(native.mock.calls[0]![2]).toBe(tokenA);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not call a reported native launch success joined without pane continuity proof", async () => {
    const f = fixture(); const { body } = await review(f);
    vi.spyOn(CodexResumeAdapter.prototype, "resume").mockResolvedValue({ ok: true });
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ ok: false, sourceSessionId: f.old.id, resultSessionId: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(tokenA);
  });

  it("reports success only when older Claude A joins the exact launched pane", async () => {
    setup = createTestApp(db, { listProcesses: async () => [
      { pid: 1234, ppid: 1, command: "zsh" },
      { pid: 1235, ppid: 1234, command: `claude --resume ${tokenA}` },
    ], appDeps: { terminalBearerToken: "terminal-test-token" } });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    setup.tmuxAdapter.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]);
    setup.tmuxAdapter.getPanePid = vi.fn(async () => 1234);
    setup.tmuxAdapter.getPaneCommand = vi.fn(async () => "claude");
    const f = fixture(false, "claude-code"); const { body } = await review(f);
    vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockResolvedValue({ ok: true });
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ ok: true, sourceSessionId: f.old.id, resultSessionId: expect.any(String), code: "resumed" });
    expect(JSON.stringify(result)).not.toContain(tokenA);
  });

  it("passes older A through pod-aware startup and keeps native refusal uncertain", async () => {
    const adapter = { runtime: "codex", listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      launchHarness: vi.fn(async () => ({ ok: false as const, error: "fixture native refused", recovery: "attention_required" as const })),
      checkReady: vi.fn(async () => ({ ready: true })) };
    setup = createTestApp(db, { wireRuntimeAdapters: true, adapters: { codex: adapter },
      appDeps: { terminalBearerToken: "terminal-test-token" } });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const f = fixture(true); const { body } = await review(f);
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(adapter.launchHarness).toHaveBeenCalledOnce();
    expect(adapter.launchHarness.mock.calls[0]![1]).toMatchObject({ resumeToken: tokenA,
      resumeType: "codex_id", beforeNativeDispatch: expect.any(Function) });
    expect(result).toMatchObject({ ok: false, sourceSessionId: f.old.id, resultSessionId: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(tokenA);
  });

  it("refuses a pod-aware policy edit after awaited preparation and before native dispatch", async () => {
    let nodeId = "";
    const adapter = { runtime: "codex", listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => {
        db.prepare("UPDATE nodes SET model='changed-during-preparation' WHERE id=?").run(nodeId);
        return { projected: [], skipped: [], failed: [] };
      }),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
      checkReady: vi.fn(async () => ({ ready: true })) };
    setup = createTestApp(db, { wireRuntimeAdapters: true, adapters: { codex: adapter },
      appDeps: { terminalBearerToken: "terminal-test-token" } });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const f = fixture(true); nodeId = f.node.id;
    const { body } = await review(f);
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    expect(response.status).toBe(409);
    expect(adapter.launchHarness).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: false, resultSessionId: expect.any(String) });
  });

  it("refuses source drift during the awaited liveness check before creating a terminal", async () => {
    const f = fixture(); const { body } = await review(f);
    setup.tmuxAdapter.hasSession = vi.fn(async () => {
      db.prepare("UPDATE sessions SET restore_policy='never' WHERE id=?").run(f.old.id);
      return false;
    });
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: "selection_changed" });
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves an unowned terminal after node drift during shell creation", async () => {
    const f = fixture(); const { body } = await review(f);
    const create = vi.spyOn(setup.tmuxAdapter, "createSession").mockImplementation(async () => {
      db.prepare("UPDATE nodes SET model='replaced-during-shell-creation' WHERE id=?").run(f.node.id);
      return { ok: true };
    });
    const kill = vi.spyOn(setup.tmuxAdapter, "killSession");
    const native = vi.spyOn(CodexResumeAdapter.prototype, "resume");
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    expect(response.status).toBe(409);
    expect(create).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("does not restore prior registry state over a replacement that appears during rollback", async () => {
    const f = fixture(false, "claude-code"); const { body } = await review(f);
    vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "resume_failed", message: "native rejected history" });
    const replacementId = "01M5W6C5D1R5Z1P2A3B4C5D6E7";
    setup.tmuxAdapter.killSession = vi.fn(async () => {
      db.prepare("UPDATE bindings SET id=? WHERE node_id=?").run(replacementId, f.node.id);
      return { ok: true as const };
    });
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ ok: false, code: "attention_required", resultSessionId: expect.any(String) });
    expect(setup.sessionRegistry.getBindingForNode(f.node.id)?.id).toBe(replacementId);
    expect(JSON.stringify(result)).not.toContain(tokenA);
  });

  it("refuses a replaced binding after awaited pod preparation without killing its terminal", async () => {
    let nodeId = "";
    const adapter = { runtime: "codex", listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => {
        db.prepare("UPDATE bindings SET id='01M5W6C5D1R5Z1P2A3B4C5D6E7' WHERE node_id=?").run(nodeId);
        return { projected: [], skipped: [], failed: [] };
      }),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
      checkReady: vi.fn(async () => ({ ready: true })) };
    setup = createTestApp(db, { wireRuntimeAdapters: true, adapters: { codex: adapter },
      appDeps: { terminalBearerToken: "terminal-test-token" } });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const f = fixture(true); nodeId = f.node.id;
    const { body } = await review(f);
    const kill = vi.spyOn(setup.tmuxAdapter, "killSession");
    const response = await request(f.path, { action: "resume", ...f.refs, revision: body.revision });
    expect(response.status).toBe(409);
    expect(adapter.launchHarness).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: false, resultSessionId: expect.any(String) });
  });

  it("shows a recorded runtime home beside the snapshot's, and a newer correction, even to the same home, needs a new review", async () => {
    const f = fixture();
    const recordHome = async (home: string, operationId: string) => {
      const state = await (await setup.app.request("/api/seat/runtime-home/desk.lead")).json() as Record<string, unknown>;
      const res = await setup.app.request("/api/seat/record-runtime-home/desk.lead", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ home, expectedOccupant: state.occupantGeneration, expectedOriginal: state.original,
          expectedRevision: state.revision, operationId, reason: "home after recovery" }) });
      expect(res.status).toBe(200);
    };
    await recordHome("/homes/codex-b", "op-review-home-1");
    const snapshot = setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    const refs = { snapshotId: snapshot.id, historySessionId: f.old.id };
    const first = await review({ ...f, refs });
    expect(first.response.status).toBe(200);
    // The record was made for the seat's newest conversation (B); the selected history is A, so it says so.
    expect(first.body).toMatchObject({ settingsSource: { runtimeHome: { value: "/homes/codex-b", source: "member", authentication: "unconfirmed",
      record: { revision: 1, home: "/homes/codex-b" }, snapshotRecord: { revision: 1 }, recordedFor: "another_conversation" } } });

    await recordHome("/homes/codex-b", "op-review-home-2");
    const second = await review({ ...f, refs });
    expect(second.body).toMatchObject({ settingsSource: { runtimeHome: { record: { revision: 2 }, snapshotRecord: { revision: 1 } } } });
    expect(second.body.revision).not.toBe(first.body.revision);
    expect(JSON.stringify(second.body)).not.toContain(tokenA);
    expect(JSON.stringify(second.body)).not.toContain(tokenB);
    const create = vi.spyOn(setup.tmuxAdapter, "createSession");
    const stale = await request(f.path, { action: "resume", ...refs, revision: first.body.revision });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, code: "selection_changed" });
    expect(create).not.toHaveBeenCalled();
  });

  // A record row as the record verb writes it, for a conversation the seat held then: the verb records only the current one.
  function recordFor(nodeId: string, revision: number, home: string, original: string) {
    db.prepare(`INSERT INTO seat_runtime_home_records (operation_id, node_id, runtime, revision, home, slot, previous_home, previous_source,
      original, occupant_generation, request_hash, reason, operator, created_at) VALUES (?, ?, 'codex', ?, ?, 'member_env', NULL, 'native_default', ?, NULL, 'fixture', 'fixture', NULL, ?)`)
      .run(`op-fixture-${revision}`, nodeId, revision, home, original, new Date().toISOString());
  }
  async function recordCurrent(home: string, operationId: string) {
    const state = await (await setup.app.request("/api/seat/runtime-home/desk.lead")).json() as Record<string, unknown>;
    const res = await setup.app.request("/api/seat/record-runtime-home/desk.lead", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ home, expectedOccupant: state.occupantGeneration, expectedOriginal: state.original,
        expectedRevision: state.revision, operationId, reason: "home after recovery" }) });
    expect(res.status).toBe(200);
  }

  it("resumes the selected original under the newest home recorded for it, not a later record for another conversation, and says which", async () => {
    const f = fixture();
    recordFor(f.node.id, 1, "/homes/codex-a", tokenA);
    const snapshot = setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    // A correction for the same original after that snapshot, then a record for the seat's current conversation (B).
    recordFor(f.node.id, 2, "/homes/codex-a2", tokenA);
    await recordCurrent("/homes/codex-b", "op-home-b-current");
    const refs = { snapshotId: snapshot.id, historySessionId: f.old.id };
    const { body } = await review({ ...f, refs });
    expect(body).toMatchObject({ settingsSource: { runtimeHome: { value: "/homes/codex-b", record: { revision: 3 }, snapshotRecord: { revision: 1 },
      recordedFor: "another_conversation", uses: { plan: "apply_recorded_for_selected", home: "/homes/codex-a2", revision: 2, selectedInHome: "unknown" } } } });
    let launchedUnder: string | undefined;
    vi.spyOn(CodexResumeAdapter.prototype, "resume").mockImplementation(async () => {
      launchedUnder = JSON.parse((db.prepare("SELECT env_json FROM nodes WHERE id = ?").get(f.node.id) as { env_json: string }).env_json).CODEX_HOME;
      return { ok: false, code: "attention_required", message: "fixture native refused" };
    });
    const response = await request(f.path, { action: "resume", ...refs, revision: body.revision });
    const result = await response.json() as Record<string, unknown>;
    expect(launchedUnder).toBe("/homes/codex-a2");
    // The resume didn't take, so B is the seat's conversation again, and the slot goes back to B's home.
    expect(result).toMatchObject({ runtimeHome: { attempted: { home: "/homes/codex-a2", revision: 4, recordedFor: "selected_history", appliedBeforeLaunch: true },
      putBack: { home: "/homes/codex-b", revision: 5 } } });
    expect(db.prepare("SELECT original, home, operation_id FROM seat_runtime_home_records WHERE revision = 4").get())
      .toMatchObject({ original: tokenA, home: "/homes/codex-a2", operation_id: expect.stringMatching(/^resume-/) });
    expect(JSON.parse((db.prepare("SELECT env_json FROM nodes WHERE id = ?").get(f.node.id) as { env_json: string }).env_json).CODEX_HOME).toBe("/homes/codex-b");
    expect(db.prepare("SELECT original, home FROM seat_runtime_home_records WHERE revision = 5").get()).toMatchObject({ original: tokenB, home: "/homes/codex-b" });
    expect(JSON.stringify(result)).not.toContain(tokenA);
  });

  it("reports the home it was bound to when a record lands during the launch, and doesn't put back over that record", async () => {
    const f = fixture();
    recordFor(f.node.id, 1, "/homes/codex-a", tokenA);
    await recordCurrent("/homes/codex-b", "op-home-b-await");
    const snapshot = setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    const refs = { snapshotId: snapshot.id, historySessionId: f.old.id };
    const { body } = await review({ ...f, refs });
    vi.spyOn(CodexResumeAdapter.prototype, "resume").mockImplementation(async () => {
      // Another recording lands while the native resume is awaited.
      recordFor(f.node.id, 4, "/homes/codex-late", tokenB);
      db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ CODEX_HOME: "/homes/codex-late" }), f.node.id);
      return { ok: false, code: "attention_required", message: "fixture native refused" };
    });
    const result = await (await request(f.path, { action: "resume", ...refs, revision: body.revision })).json() as Record<string, unknown>;
    expect(result).toMatchObject({ runtimeHome: { attempted: { home: "/homes/codex-a", revision: 3, appliedBeforeLaunch: true }, putBack: null } });
    expect(JSON.parse((db.prepare("SELECT env_json FROM nodes WHERE id = ?").get(f.node.id) as { env_json: string }).env_json).CODEX_HOME).toBe("/homes/codex-late");
  });

  it("keeps a home a switch set since the selected conversation's record, says it isn't that record's, and gives it no revision", async () => {
    const f = fixture();
    recordFor(f.node.id, 1, "/homes/codex-a", tokenA);
    db.prepare("UPDATE nodes SET env_json = ?, account_home = ? WHERE id = ?").run(JSON.stringify({ CODEX_HOME: "/homes/codex-a" }), "/homes/switched", f.node.id);
    const snapshot = setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    const refs = { snapshotId: snapshot.id, historySessionId: f.old.id };
    const { body } = await review({ ...f, refs });
    const uses = ((body.settingsSource as Record<string, any>).runtimeHome as Record<string, any>).uses;
    expect(uses).toMatchObject({ plan: "as_set", home: "/homes/switched", why: "home_changed_since_record" });
    expect(uses).not.toHaveProperty("revision");
    vi.spyOn(CodexResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "fixture native refused" });
    const result = await (await request(f.path, { action: "resume", ...refs, revision: body.revision })).json() as Record<string, unknown>;
    expect(result).toMatchObject({ runtimeHome: { attempted: { home: "/homes/switched", revision: null, recordedFor: null, why: "home_changed_since_record" } } });
    expect(db.prepare("SELECT account_home FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ account_home: "/homes/switched" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM seat_runtime_home_records").get() as { n: number }).n).toBe(1);
  });

  it("launches as set when only another conversation's home is recorded, and says so without that record's revision as its own", async () => {
    const f = fixture();
    await recordCurrent("/homes/codex-b", "op-home-b-only");
    const snapshot = setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    const refs = { snapshotId: snapshot.id, historySessionId: f.old.id };
    const { body } = await review({ ...f, refs });
    expect(body).toMatchObject({ settingsSource: { runtimeHome: { recordedFor: "another_conversation",
      uses: { plan: "as_set", home: "/homes/codex-b", why: "no_record_for_this_conversation", otherConversationRecord: { revision: 1 } } } } });
    const native = vi.spyOn(CodexResumeAdapter.prototype, "resume").mockResolvedValue({ ok: false, code: "attention_required", message: "fixture native refused" });
    const result = await (await request(f.path, { action: "resume", ...refs, revision: body.revision })).json() as Record<string, unknown>;
    expect(native).toHaveBeenCalled();
    expect(result).toMatchObject({ runtimeHome: { attempted: { home: "/homes/codex-b", revision: null, recordedFor: null,
      why: "no_record_for_this_conversation", otherConversationRecord: { revision: 1 } } } });
    expect(result).not.toHaveProperty("code", "runtime_home_other_conversation");
    expect((db.prepare("SELECT COUNT(*) AS n FROM seat_runtime_home_records").get() as { n: number }).n).toBe(1);
  });
});
