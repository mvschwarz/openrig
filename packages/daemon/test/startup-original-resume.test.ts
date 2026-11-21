import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { deriveSessionName } from "../src/domain/session-name.js";
const live = vi.hoisted(() => ({ original: false, reason: "The exact current native identity is unavailable", code: undefined as string | undefined, afterResolve: undefined as (() => void) | undefined }));
vi.mock("../src/domain/expected-conversation.js", async original => ({
  ...await original<typeof import("../src/domain/expected-conversation.js")>(),
  resolveExpectedConversation: vi.fn(async () => {
    if (!live.original) throw Object.assign(new Error(live.reason), live.code ? { code: live.code } : {});
    live.afterResolve?.();
    return { assertCurrent() {}, generation: "fixture-generation", pane: "%1" };
  }),
}));

// Real SQLite, snapshot/history selection, selected native path and ownership checks;
// runtime launch and current-native observation are scripted, with no provider/account operation.
describe("opt-in original conversation resume", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  const token = "banked-private-native-original";
  beforeEach(() => {
    live.original = false; live.afterResolve = undefined; live.reason = "The exact current native identity is unavailable"; live.code = undefined;
    db = createFullTestDb();
    setup = createTestApp(db, { listProcesses: async () => [
      { pid: 1234, ppid: 1, command: "zsh" },
      { pid: 1235, ppid: 1234, command: `claude --resume ${token}` },
    ], appDeps: { terminalBearerToken: "terminal-test-token" } });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    setup.tmuxAdapter.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]);
    setup.tmuxAdapter.getPanePid = vi.fn(async () => 1234);
    setup.tmuxAdapter.getPaneCommand = vi.fn(async () => "claude");
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  const request = (path: string, body?: unknown) => setup.app.request(path, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer terminal-test-token", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  function fixture() {
    const rig = setup.rigRepo.createRig("original-resume");
    const oldCwd = mkdtempSync(join(tmpdir(), "original-snapshot-cwd-"));
    const node = setup.rigRepo.addNode(rig.id, "lead", { runtime: "claude-code", model: "old-model", cwd: oldCwd });
    const sibling = setup.rigRepo.addNode(rig.id, "unselected", { runtime: "claude-code" });
    const source = setup.sessionRegistry.registerSession(node.id, deriveSessionName(rig.name, node.logicalId));
    setup.sessionRegistry.updateStatus(source.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: source.sessionName, tmuxPane: "%1" });
    db.prepare("UPDATE sessions SET resume_type='claude_name',resume_token=? WHERE id=?").run(token, source.id);
    const other = setup.sessionRegistry.registerSession(sibling.id, "unselected@original-resume");
    setup.sessionRegistry.updateStatus(other.id, "exited");
    db.prepare("UPDATE nodes SET effort='low' WHERE id=?").run(node.id);
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    setup.sessionRegistry.updateStatus(source.id, "exited");
    setup.sessionRegistry.clearBinding(node.id);
    const currentCwd = mkdtempSync(join(tmpdir(), "original-cwd-"));
    db.prepare("UPDATE nodes SET model='current-model',effort='high',cwd=?,account_home='/fixture-current-account' WHERE id=?").run(currentCwd, node.id);
    const path = `/api/startup/${rig.id}/nodes/${node.id}/original`;
    const refs = { snapshotId: snapshot.id, historySessionId: source.id };
    const expectedOriginal = { nodeId: node.id, sessionName: source.sessionName, runtime: "claude-code", nativeId: token };
    return { rig, node, sibling, source, other, snapshot, currentCwd, path, refs, expectedOriginal };
  }
  async function review(f: ReturnType<typeof fixture>) {
    const r = await request(f.path + `?snapshotId=${f.refs.snapshotId}&historySessionId=${f.refs.historySessionId}`);
    expect(r.status).toBe(200);
    return await r.json() as { revision: string; settingsSource: Record<string, unknown> };
  }
  function apply(f: ReturnType<typeof fixture>, revision: string, operationId = randomUUID()) {
    return { action: "resume", ...f.refs, revision, operationId, expectedOriginal: f.expectedOriginal };
  }
  it("reviews an explicitly retained older snapshot and current choices without replacing it", async () => {
    const f = fixture();
    const newer = setup.snapshotCapture.captureSnapshot(f.rig.id, "manual");
    expect(newer.id).not.toBe(f.snapshot.id);
    const r = await request(f.path + `?snapshotId=${f.refs.snapshotId}&historySessionId=${f.refs.historySessionId}`);
    const b = await r.json() as Record<string, any>;
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ snapshotId: f.snapshot.id, intent: "resume-original", mutated: false,
      settingsSource: { model: { value: "current-model", source: "current_node" }, cwd: { value: f.currentCwd, source: "current_node" },
        accountHome: { value: "/fixture-current-account", source: "account-switch", authentication: "unconfirmed" } } });
    expect(JSON.stringify(b)).not.toContain(token);
  });
  it("resumes the selected original once, keeps current cwd/model/account and leaves a stopped sibling unchanged", async () => {
    const f = fixture(); const b = await review(f);
    const siblingBefore = db.prepare("SELECT * FROM sessions WHERE id=?").get(f.other.id);
    const native = vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockImplementation(async () => { live.original = true; return { ok: true }; });
    const args = apply(f, b.revision);
    const r = await request(f.path, args); const out = await r.json() as Record<string, any>;
    expect(r.status).toBe(200); expect(out).toMatchObject({ ok: true, code: "resumed", sourceSessionId: f.source.id, operationId: args.operationId });
    expect(native).toHaveBeenCalledOnce(); expect(native.mock.calls[0]![2]).toBe(token);
    expect(native.mock.calls[0]![3]).toBe(f.currentCwd);
    expect(native.mock.calls[0]![5]).toBe("current-model");
    expect(native.mock.calls[0]![8]).toBe("high");
    expect(db.prepare("SELECT * FROM sessions WHERE id=?").get(f.other.id)).toEqual(siblingBefore);
    expect(db.prepare("SELECT model,cwd,account_home FROM nodes WHERE id=?").get(f.node.id)).toMatchObject({ model: "current-model", cwd: f.currentCwd, account_home: "/fixture-current-account" });
    const repeat = await request(f.path, args);
    expect(await repeat.json()).toMatchObject({ ok: true, code: "already_running_original", operationId: args.operationId });
    expect(native).toHaveBeenCalledOnce();
    expect(JSON.stringify(out)).not.toContain(token);
  });
  it("binds an original-only resume to its reviewed recorded home while keeping current model and cwd", async () => {
    const f = fixture();
    // The seat previously recorded A's home, then B's; its slot still contains B's last record.
    const record = db.prepare(`INSERT INTO seat_runtime_home_records
      (operation_id,node_id,runtime,revision,home,slot,previous_home,previous_source,original,
       occupant_generation,request_hash,reason,operator,created_at)
      VALUES (?,?,'claude-code',?,?,'account_home',NULL,'native_default',?,NULL,'fixture','fixture',NULL,?)`);
    record.run("composition-home-a", f.node.id, 1, "/fixture-original-account", token, new Date().toISOString());
    record.run("composition-home-b", f.node.id, 2, "/fixture-current-account", "other-retained-original", new Date().toISOString());
    const b = await review(f);
    expect(b.settingsSource).toMatchObject({ runtimeHome: { uses: {
      plan: "apply_recorded_for_selected", home: "/fixture-original-account", revision: 1,
    } } });
    let launchedHome: unknown;
    const native = vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockImplementation(async () => {
      launchedHome = (db.prepare("SELECT account_home FROM nodes WHERE id=?").get(f.node.id) as { account_home: string }).account_home;
      live.original = true;
      return { ok: true };
    });
    const args = apply(f, b.revision);
    const r = await request(f.path, args);
    const out = await r.json() as Record<string, any>;
    expect(r.status).toBe(200);
    expect(out).toMatchObject({ ok: true, code: "resumed", operationId: args.operationId,
      runtimeHome: { attempted: { home: "/fixture-original-account", revision: 3, appliedBeforeLaunch: true },
        sessionRegistered: true, putBack: null, notPutBack: "resume_confirmed" } });
    expect(launchedHome).toBe("/fixture-original-account");
    expect(native.mock.calls[0]![2]).toBe(token);
    expect(native.mock.calls[0]![3]).toBe(f.currentCwd);
    expect(native.mock.calls[0]![5]).toBe("current-model");
    expect(await (await request(f.path, args)).json()).toMatchObject({ code: "already_running_original" });
    expect(native).toHaveBeenCalledOnce();
    expect(JSON.stringify(out)).not.toContain(token);
  });
  it("a positively matching original already running is a no-op even on the first operation", async () => {
    const f = fixture(); const b = await review(f); live.original = true;
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const r = await request(f.path, apply(f, b.revision));
    expect(await r.json()).toMatchObject({ ok: true, code: "already_running_original" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("leaves a different or unconfirmed current occupant untouched", async () => {
    const f = fixture(); const b = await review(f);
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "present" as const }));
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode"); const kill = vi.spyOn(setup.tmuxAdapter, "killSession");
    const r = await request(f.path, apply(f, b.revision));
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ ok: false, partial: true });
    expect(launch).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
  });
  it.each(["missing", "invalid"])("returns truthful partial for a %s retained source with zero fresh substitution", async kind => {
    const f = fixture(); const b = await review(f); const args = apply(f, b.revision);
    if (kind === "missing") args.snapshotId = "00000000000000000000000000";
    else db.prepare("UPDATE snapshots SET status='invalid' WHERE id=?").run(f.snapshot.id);
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const r = await request(f.path, args);
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ ok: false, partial: true }); expect(launch).not.toHaveBeenCalled();
  });
  it("rejects a changed expected original before native effect and does not expose native ids", async () => {
    const f = fixture(); const b = await review(f); const args = apply(f, b.revision); args.expectedOriginal.nativeId = "other-original";
    live.original = true; // Even a positive live reader cannot bypass the selected snapshot/history join.
    const native = vi.spyOn(ClaudeResumeAdapter.prototype, "resume");
    const r = await request(f.path, args); const out = await r.json();
    expect(r.status).toBe(409); expect(out).toMatchObject({ ok: false, partial: true });
    expect(native).not.toHaveBeenCalled(); expect(JSON.stringify(out)).not.toContain(token); expect(JSON.stringify(out)).not.toContain("other-original");
  });
  it("records an uncertain effect by operation and never repeats it after timeout", async () => {
    const f = fixture(); const b = await review(f); const args = apply(f, b.revision);
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode").mockRejectedValue(new Error("fixture timeout"));
    const first = await request(f.path, args); expect(await first.json()).toMatchObject({ ok: false, partial: true, operationId: args.operationId });
    const repeat = await request(f.path, args); expect(await repeat.json()).toMatchObject({ ok: false, partial: true, code: "operation_unconfirmed" });
    expect(launch).toHaveBeenCalledOnce();
  });
  it("a restoring-only outcome remains partial and cannot become a useful-running claim", async () => {
    const f = fixture(); const b = await review(f);
    vi.spyOn(setup.restoreOrchestrator, "launchSingleNode").mockResolvedValue({ ok: true, launched: [{ nodeId: f.node.id, logicalId: f.node.logicalId, status: "restoring" }], alreadyRunning: [], failedTargets: [] } as never);
    const r = await request(f.path, apply(f, b.revision));
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ ok: false, partial: true });
  });
  it("keeps a changed current account selection rather than applying a stale review", async () => {
    const f = fixture(); const b = await review(f);
    db.prepare("UPDATE nodes SET account_home='/fixture-new-account' WHERE id=?").run(f.node.id);
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const r = await request(f.path, apply(f, b.revision));
    expect(await r.json()).toMatchObject({ ok: false, partial: true, code: "selection_changed" });
    expect(launch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT account_home FROM nodes WHERE id=?").get(f.node.id)).toEqual({ account_home: "/fixture-new-account" });
  });
  it("reconciles a persisted uncertain operation from a reopened database without redispatch", async () => {
    const f = fixture(); const b = await review(f); const args = apply(f, b.revision);
    vi.spyOn(setup.restoreOrchestrator, "launchSingleNode").mockRejectedValue(new Error("fixture timeout"));
    expect(await (await request(f.path, args)).json()).toMatchObject({ ok: false, partial: true });
    const reopened = new Database(db.serialize()); db.close(); db = reopened;
    setup = createTestApp(db, { appDeps: { terminalBearerToken: "terminal-test-token" } });
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    expect(await (await request(f.path, args)).json()).toMatchObject({ ok: false, partial: true, code: "operation_unconfirmed" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("serializes a competing request without a second native attempt", async () => {
    const f = fixture(); const b = await review(f); const args = apply(f, b.revision);
    let release!: () => void;
    const waiting = new Promise<void>(done => { release = done; });
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode").mockImplementation(async () => {
      entered(); await waiting; throw new Error("fixture uncertain effect");
    });
    const first = request(f.path, args); await started;
    const second = await request(f.path, args);
    expect(await second.json()).toMatchObject({ ok: false, code: "operation_in_progress" });
    release(); await first; expect(launch).toHaveBeenCalledOnce();
  });

  it("keeps the existing terminal authentication boundary for this opt-in operation", async () => {
    const f = fixture(); const b = await review(f);
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const r = await setup.app.request(f.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(apply(f, b.revision)) });
    expect(r.status).toBe(401); expect(launch).not.toHaveBeenCalled();
  });

  it("rechecks current choices after awaited original identity evidence", async () => {
    const f = fixture(); const b = await review(f);
    vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockImplementation(async () => {
      live.original = true;
      live.afterResolve = () => db.prepare("UPDATE nodes SET account_home='/changed-after-identity' WHERE id=?").run(f.node.id);
      return { ok: true };
    });
    const r = await request(f.path, apply(f, b.revision));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, partial: true, code: "resume_unconfirmed" });
    expect(db.prepare("SELECT account_home FROM nodes WHERE id=?").get(f.node.id)).toEqual({ account_home: "/changed-after-identity" });
  });

  describe("the preview compares the seat's current conversation with the saved one, not only the saved history row", () => {
    const preview = async (f: ReturnType<typeof fixture>) => {
      const r = await request(f.path + `?snapshotId=${f.refs.snapshotId}&historySessionId=${f.refs.historySessionId}`);
      return { status: r.status, body: await r.json() as Record<string, any> };
    };
    // Another session launched in the seat since the snapshot, with its conversation (or none) and status; the saved row is unchanged.
    const launchedSince = (f: ReturnType<typeof fixture>, conversation: string | null, status?: string) => {
      const later = setup.sessionRegistry.registerSession(f.node.id, f.source.sessionName);
      if (conversation) db.prepare("UPDATE sessions SET resume_type='claude_name',resume_token=? WHERE id=?").run(conversation, later.id);
      if (status) db.prepare("UPDATE sessions SET status=? WHERE id=?").run(status, later.id);
    };
    // An agent is present: a live terminal whose foreground is Claude, showing `screen` (nothing drawn by default).
    const present = (screen = "") => {
      setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "present" as const }));
      setup.tmuxAdapter.capturePaneContent = vi.fn(async () => screen);
      if (setup.tmuxAdapter.capturePaneScreen) setup.tmuxAdapter.capturePaneScreen = vi.fn(async () => screen);
    };

    it("answers selection_changed when the seat's current session names another conversation", async () => {
      const f = fixture(); launchedSince(f, "post-clear-other-conversation");
      const { status, body } = await preview(f);
      expect(status).toBe(409);
      expect(body).toMatchObject({ ok: false, code: "selection_changed" });
      expect(body.message).toContain("This seat's record changed since it was saved");
      expect(JSON.stringify(body)).not.toContain(token); expect(JSON.stringify(body)).not.toContain("post-clear-other-conversation");
    });

    it("previews the saved one, reporting it unknown, when the seat's current session records no conversation", async () => {
      const f = fixture(); launchedSince(f, null);
      const { status, body } = await preview(f);
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, revision: expect.any(String), currentConversation: { state: "unknown" } });
      expect(body.forecast).toBeDefined();
    });

    it("skips the row a rolled-back restore left (superseded, no conversation): the saved one previews as the same", async () => {
      const f = fixture(); launchedSince(f, null, "superseded");
      const { status, body } = await preview(f);
      expect(status).toBe(200);
      expect(body.currentConversation).toEqual({ state: "same", basis: "record" });
    });

    it("previews the saved one as the same when a newer session resumed that same conversation", async () => {
      const f = fixture(); launchedSince(f, token);
      const { status, body } = await preview(f);
      expect(status).toBe(200);
      expect(body.currentConversation).toEqual({ state: "same", basis: "record" });
    });

    it("answers selection_changed when a /clear moved the running agent's identity while the saved history row is unchanged", async () => {
      const f = fixture(); present();
      live.code = "expected_identity_mismatch"; live.reason = "The current native conversation differs from the expected original.";
      const { status, body } = await preview(f);
      expect(status).toBe(409);
      expect(body).toMatchObject({ ok: false, code: "selection_changed", identityEvidence: { code: "expected_identity_mismatch" } });
      expect(db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.source.id)).toEqual({ resume_token: token });
      expect(JSON.stringify(body)).not.toContain(token);
    });

    it("compares a present agent behind a prompt too: another identity behind a login screen answers selection_changed", async () => {
      const f = fixture(); present("● Not logged in · Please run /login");
      live.code = "expected_identity_mismatch"; live.reason = "The current native conversation differs from the expected original.";
      const { status, body } = await preview(f);
      expect(status).toBe(409);
      expect(body).toMatchObject({ ok: false, code: "selection_changed", identityEvidence: { code: "expected_identity_mismatch" } });
    });

    it("reports unknown, still previewing the saved one, when the terminal can't be read", async () => {
      const f = fixture();
      setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "transport_unavailable" as const }));
      const { status, body } = await preview(f);
      expect(status).toBe(200);
      expect(body).toMatchObject({ revision: expect.any(String), currentConversation: { state: "unknown",
        identityEvidence: { code: "expected_identity_unavailable", detail: "The exact current native identity is unavailable" } } });
    });

    it("reports unknown, never claiming the saved one, when a present agent's identity can't be established", async () => {
      const f = fixture(); present();
      const { status, body } = await preview(f);
      expect(status).toBe(200);
      expect(body.currentConversation).toMatchObject({ state: "unknown", identityEvidence: { code: "expected_identity_unavailable" } });
    });

    it("keeps the evidence free of native ids, the saved one's and any other the resolver names", async () => {
      const f = fixture(); present();
      const other = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
      live.reason = `multiple claude session ids under verified pane %1: ${other}, ${token}`;
      const { status, body } = await preview(f);
      expect(status).toBe(200);
      expect(body.currentConversation.identityEvidence.detail).toBe("multiple claude session ids under verified pane %1: [redacted], [redacted]");
      expect(JSON.stringify(body)).not.toContain(other); expect(JSON.stringify(body)).not.toContain(token);
    });

    it("previews the saved one as the same while the present agent is proved to be that conversation", async () => {
      const f = fixture(); present(); live.original = true;
      const { status, body } = await preview(f);
      expect(status).toBe(200);
      expect(body.currentConversation).toEqual({ state: "same", basis: "running_agent" });
    });
  });

  it("names the missing fresh native evidence after a reported successful resume", async () => {
    const f = fixture(); const b = await review(f);
    vi.spyOn(ClaudeResumeAdapter.prototype, "resume").mockImplementation(async () => {
      live.reason = "Fresh original-native record is not yet verified"; return { ok: true };
    });
    const r = await request(f.path, apply(f, b.revision)); const out = await r.json();
    expect(r.status).toBe(409);
    expect(out).toMatchObject({ ok: false, partial: true, code: "resume_unconfirmed",
      identityEvidence: { code: "expected_identity_unavailable", detail: "Fresh original-native record is not yet verified" } });
    expect(JSON.stringify(out)).not.toContain(token);
  });

});
