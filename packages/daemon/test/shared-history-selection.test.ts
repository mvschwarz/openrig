import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";

const secret = "private-native-token-do-not-echo";

describe("authenticated shared history selection", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { appDeps: { terminalBearerToken: "test-terminal-token" } });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  function request(path: string, body?: unknown, authenticated = true) {
    return setup.app.request(path, { method: body ? "POST" : "GET",
      headers: { ...(authenticated ? { Authorization: "Bearer test-terminal-token" } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }

  function fixture(runtime: "codex" | "claude-code" = "codex") {
    const rig = setup.rigRepo.createRig(`selection-${runtime}`);
    const node = setup.rigRepo.addNode(rig.id, "desk.lead", { runtime });
    const other = setup.rigRepo.addNode(rig.id, "desk.other", { runtime });
    const old = setup.sessionRegistry.registerSession(node.id, `desk-old@selection-${runtime}`);
    setup.sessionRegistry.updateStatus(old.id, "exited");
    const current = setup.sessionRegistry.registerSession(node.id, `desk-new@selection-${runtime}`);
    setup.sessionRegistry.updateStatus(current.id, "running");
    const foreign = setup.sessionRegistry.registerSession(other.id, `other-new@selection-${runtime}`);
    setup.sessionRegistry.updateStatus(foreign.id, "running");
    const type = runtime === "codex" ? "codex_id" : "claude_id";
    for (const session of [old, current, foreign]) db.prepare("UPDATE sessions SET resume_type=?, resume_token=? WHERE id=?").run(type, secret, session.id);
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    const path = `/api/startup/${rig.id}/nodes/${node.id}/history`;
    return { rig, node, other, old, current, foreign, snapshot, path };
  }

  it.each(["codex", "claude-code"] as const)("lists old and active %s histories without exposing native tokens or changing state", async (runtime) => {
    const f = fixture(runtime);
    const writesBefore = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const capture = vi.spyOn(setup.snapshotCapture, "captureSnapshot");
    const restore = vi.spyOn(setup.restoreOrchestrator, "restore");
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    const nativeCanResume = runtime === "codex"
      ? vi.spyOn(CodexResumeAdapter.prototype, "canResume")
      : vi.spyOn(ClaudeResumeAdapter.prototype, "canResume");
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const paneProbe = vi.mocked(setup.tmuxAdapter.probeSession);
    const response = await request(f.path);
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain(secret);
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ ok: true, snapshotId: f.snapshot.id, nodeId: f.node.id });
    expect(body.histories.map((item: { historySessionId: string }) => item.historySessionId).sort()).toEqual([f.old.id, f.current.id].sort());
    expect(body.histories.every((item: { resumeType: string; tokenState: string }) => item.resumeType === (runtime === "codex" ? "codex_id" : "claude_id") && item.tokenState === "unverified")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(f.foreign.id);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writesBefore);
    expect(capture).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    expect(nativeCanResume).toHaveBeenCalledWith(runtime === "codex" ? "codex_id" : "claude_id", secret);
    expect(paneProbe).not.toHaveBeenCalled();
    const validated = await request(`${f.path}/validate`, { snapshotId: f.snapshot.id, historySessionId: f.old.id });
    expect(await validated.json()).toMatchObject({ ok: true, eligibleForAttempt: true, history: { historySessionId: f.old.id }, mutated: false });
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writesBefore);
    expect(paneProbe).not.toHaveBeenCalled();
  });

  it("requires terminal auth and validates the exact request body", async () => {
    const f = fixture();
    expect((await request(f.path, undefined, false)).status).toBe(401);
    expect((await request(`${f.path}/validate`, { snapshotId: f.snapshot.id, historySessionId: f.old.id }, false)).status).toBe(401);
    for (const body of [{ snapshotId: f.snapshot.id }, { snapshotId: f.snapshot.id, historySessionId: f.old.id, token: secret }, { snapshotId: secret, historySessionId: f.old.id }]) {
      const response = await request(`${f.path}/validate`, body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(secret);
    }
    expect((await request(`${f.path}?snapshotId=${f.snapshot.id}`)).status).toBe(400);
    expect((await request(`${f.path}/validate?extra=1`, { snapshotId: f.snapshot.id, historySessionId: f.old.id })).status).toBe(400);
    for (const raw of ["null", "[1]", "{"]) {
      const malformed = await setup.app.request(`${f.path}/validate`, { method: "POST",
        headers: { Authorization: "Bearer test-terminal-token", "Content-Type": "application/json" }, body: raw });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain(secret);
    }
  });

  it("shares preview token freshness without treating it as native conversation proof", async () => {
    const f = fixture();
    const data = structuredClone(f.snapshot.data);
    const old = data.sessions.find((row) => row.id === f.old.id)!;
    old.resumeLastProbeStatus = "resumable";
    old.resumeLastVerified = "2020-01-01 00:00:00";
    const current = data.sessions.find((row) => row.id === f.current.id)!;
    current.resumeLastProbeStatus = "resumable";
    current.resumeLastVerified = new Date().toISOString();
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(data), f.snapshot.id);
    const body = await (await request(f.path)).json();
    expect(body.histories.find((row: { historySessionId: string }) => row.historySessionId === f.old.id).tokenState).toBe("stale");
    expect(body.histories.find((row: { historySessionId: string }) => row.historySessionId === f.current.id).tokenState).toBe("present");
  });

  it("refuses implicit Codex last, missing tokens, wrong runtime, and no-resume policy", async () => {
    const f = fixture();
    db.prepare("UPDATE sessions SET resume_type='codex_last' WHERE id=?").run(f.old.id);
    db.prepare("UPDATE sessions SET resume_token=NULL WHERE id=?").run(f.current.id);
    const changed = setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    const list = await request(f.path);
    expect((await list.json()).histories).toEqual([]);
    const validate = await request(`${f.path}/validate`, { snapshotId: changed.id, historySessionId: f.old.id });
    expect(await validate.json()).toMatchObject({ code: "history_unavailable" });
    db.prepare("UPDATE sessions SET resume_type='claude_id', resume_token=? WHERE id=?").run(secret, f.current.id);
    setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    expect((await (await request(f.path)).json()).histories).toEqual([]);
    db.prepare("UPDATE sessions SET resume_type='codex_id', restore_policy='never' WHERE id=?").run(f.current.id);
    setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    expect((await (await request(f.path)).json()).histories).toEqual([]);
  });

  it("revalidates a stale, pruned, or foreign reference without substituting another row", async () => {
    const f = fixture();
    const stale = f.snapshot.id;
    const newer = setup.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    const staleResult = await request(`${f.path}/validate`, { snapshotId: stale, historySessionId: f.old.id });
    expect(await staleResult.json()).toMatchObject({ code: "history_unavailable" });
    expect(newer.id).not.toBe(stale);
    const foreignResult = await request(`${f.path}/validate`, { snapshotId: newer.id, historySessionId: f.foreign.id });
    expect(await foreignResult.json()).toMatchObject({ code: "history_unavailable" });
    db.prepare("DELETE FROM snapshots WHERE id=?").run(newer.id);
    const pruned = await request(`${f.path}/validate`, { snapshotId: newer.id, historySessionId: f.old.id });
    expect(await pruned.json()).toMatchObject({ code: "history_unavailable" });
  });

  it("refuses a captured member removed after listing while retaining another eligible row", async () => {
    const f = fixture();
    const changed = structuredClone(f.snapshot.data);
    changed.sessions = changed.sessions.filter((row) => row.id !== f.old.id);
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(changed), f.snapshot.id);
    const result = await request(`${f.path}/validate`, { snapshotId: f.snapshot.id, historySessionId: f.old.id });
    expect(await result.json()).toMatchObject({ code: "history_unavailable" });
    expect((await (await request(f.path)).json()).histories.map((entry: { historySessionId: string }) => entry.historySessionId)).toEqual([f.current.id]);
  });

  it("honors captured policy, compatibility, and intended roster", async () => {
    const f = fixture("claude-code");
    const data = structuredClone(f.snapshot.data);
    data.sessions.find((row) => row.id === f.old.id)!.resumeType = "claude_name";
    data.sessions.find((row) => row.id === f.current.id)!.restorePolicy = "relaunch_fresh";
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(data), f.snapshot.id);
    expect((await (await request(f.path)).json()).histories).toMatchObject([{ historySessionId: f.old.id, resumeType: "claude_name" }]);
    const mismatch = structuredClone(data);
    mismatch.nodeStartupContext ??= {};
    mismatch.nodeStartupContext[f.node.id] = { runtime: "codex", projectionEntries: [], resolvedStartupFiles: [], startupActions: [] };
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(mismatch), f.snapshot.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
    const excluded = structuredClone(data);
    excluded.topologyRoster!.intendedNodeIds = [f.other.id];
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(excluded), f.snapshot.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
  });

  it("uses the current ranked snapshot and refuses an incompatible higher-ranked source", async () => {
    const f = fixture();
    const manual = setup.snapshotCapture.captureSnapshot(f.rig.id, "manual");
    expect((await (await request(f.path)).json()).snapshotId).toBe(f.snapshot.id);
    const incompatible = structuredClone(f.snapshot.data);
    incompatible.sessions.find((row) => row.id === f.current.id)!.resumeToken = "older-token";
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(incompatible), f.snapshot.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
    // A compatible lower-priority manual capture cannot silently replace the
    // selected source when the preferred snapshot no longer describes now.
    expect(manual.id).not.toBe(f.snapshot.id);
  });

  it("does not present unknown runtimes or launch-only community harnesses", async () => {
    const f = fixture();
    db.prepare("UPDATE nodes SET runtime='community-x' WHERE id=?").run(f.node.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
    db.prepare("UPDATE nodes SET runtime='codex' WHERE id=?").run(f.node.id);
    const data = structuredClone(f.snapshot.data);
    for (const row of data.sessions.filter((row) => row.nodeId === f.node.id)) row.communityHarness = "codex";
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(data), f.snapshot.id);
    expect((await (await request(f.path)).json()).histories).toEqual([]);
  });

  it("keeps the exact node's current source when a sibling changes", async () => {
    const f = fixture();
    db.prepare("UPDATE sessions SET resume_token='sibling-changed' WHERE id=?").run(f.foreign.id);
    const listed = await request(f.path);
    expect(await listed.json()).toMatchObject({ ok: true, nodeId: f.node.id,
      histories: [{ historySessionId: f.old.id }, { historySessionId: f.current.id }] });
    const validated = await request(`${f.path}/validate`, { snapshotId: f.snapshot.id, historySessionId: f.old.id });
    expect(await validated.json()).toMatchObject({ ok: true, eligibleForAttempt: true });
  });

  it("does not retarget a same-name replacement node and excludes archived rigs", async () => {
    const f = fixture();
    setup.rigRepo.deleteNode(f.node.id);
    const replacement = setup.rigRepo.addNode(f.rig.id, f.node.logicalId, { runtime: "codex" });
    expect(replacement.id).not.toBe(f.node.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "seat_unavailable" });
    const replacementPath = `/api/startup/${f.rig.id}/nodes/${replacement.id}/history`;
    expect(await (await request(replacementPath)).json()).toMatchObject({ code: "source_unavailable" });
    setup.rigRepo.archiveRig(f.rig.id);
    expect(await (await request(replacementPath)).json()).toMatchObject({ code: "seat_unavailable" });
  });

  it("refuses duplicate captured session IDs, including a duplicate in another node", async () => {
    const f = fixture();
    const corrupt = structuredClone(f.snapshot.data);
    corrupt.sessions.find((row) => row.id === f.foreign.id)!.id = f.old.id;
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(corrupt), f.snapshot.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
  });

  it("does not echo a corrupt stored reference or native-looking timestamp", async () => {
    const f = fixture();
    const corrupt = structuredClone(f.snapshot.data);
    corrupt.sessions.find((row) => row.id === f.current.id)!.createdAt = "/private/native/history/path";
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(corrupt), f.snapshot.id);
    const listed = await (await request(f.path)).text();
    expect(JSON.parse(listed)).toMatchObject({ ok: true });
    expect(listed).not.toContain("/private/native/history/path");
    corrupt.sessions.find((row) => row.id === f.old.id)!.id = secret;
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(corrupt), f.snapshot.id);
    const response = await request(f.path);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain("/private/native/history/path");
    expect(JSON.parse(body)).toMatchObject({ code: "source_unavailable" });
  });

  it.each(["resumeToken", "resumeLastVerified"] as const)("refuses a historical row with a numeric %s without effects or leakage", async (field) => {
    const f = fixture();
    const changed = structuredClone(f.snapshot.data);
    const old = changed.sessions.find((row) => row.id === f.old.id)!;
    if (field === "resumeToken") old.resumeToken = 123 as never;
    else old.resumeLastVerified = 123 as never;
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(changed), f.snapshot.id);
    const writesBefore = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const capture = vi.spyOn(setup.snapshotCapture, "captureSnapshot");
    const restore = vi.spyOn(setup.restoreOrchestrator, "restore");
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const paneProbe = vi.mocked(setup.tmuxAdapter.probeSession);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listed = await request(f.path);
    const listedRaw = await listed.text();
    expect(listed.status).toBe(200);
    expect(JSON.parse(listedRaw).histories.map((item: { historySessionId: string }) => item.historySessionId)).toEqual([f.current.id]);
    const validated = await request(`${f.path}/validate`, { snapshotId: f.snapshot.id, historySessionId: f.old.id });
    const validationRaw = await validated.text();
    expect(validated.status).toBe(409);
    expect(JSON.parse(validationRaw)).toMatchObject({ code: "history_unavailable" });
    for (const raw of [listedRaw, validationRaw]) expect(raw).not.toContain(secret);
    expect(logged).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writesBefore);
    expect(capture).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    expect(paneProbe).not.toHaveBeenCalled();
    if (field === "resumeToken") expect(setup.restoreOrchestrator.canAttemptRecordedResume("codex", "codex_id", 123 as never)).toBe(false);
  });

  it.each([null, [], "invalid-map", 7])("refuses malformed legacy occupant map %j before current-source compatibility", async (legacy) => {
    const f = fixture();
    const changed = structuredClone(f.snapshot.data);
    delete changed.activeOccupantsByNode;
    changed.activeSessionIdByNode = legacy as never;
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(changed), f.snapshot.id);
    const writesBefore = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const capture = vi.spyOn(setup.snapshotCapture, "captureSnapshot");
    const restore = vi.spyOn(setup.restoreOrchestrator, "restore");
    const launch = vi.spyOn(setup.restoreOrchestrator, "launchSingleNode");
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const paneProbe = vi.mocked(setup.tmuxAdapter.probeSession);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listed = await request(f.path);
    const validated = await request(`${f.path}/validate`, { snapshotId: f.snapshot.id, historySessionId: f.old.id });
    expect(listed.status).toBe(409);
    expect(validated.status).toBe(409);
    for (const response of [listed, validated]) {
      const raw = await response.text();
      expect(JSON.parse(raw)).toMatchObject({ ok: false, code: "source_unavailable" });
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain("invalid-map");
    }
    expect(logged).not.toHaveBeenCalled(); expect(warned).not.toHaveBeenCalled();
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writesBefore);
    expect(capture).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    expect(paneProbe).not.toHaveBeenCalled();
  });

  it("keeps omitted legacy occupancy maps usable with the unique running row", async () => {
    const f = fixture();
    const legacy = structuredClone(f.snapshot.data);
    delete legacy.activeOccupantsByNode;
    delete legacy.activeSessionIdByNode;
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(legacy), f.snapshot.id);
    const listed = await request(f.path);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ ok: true,
      histories: [{ historySessionId: f.old.id }, { historySessionId: f.current.id }] });
    const validated = await request(`${f.path}/validate`, { snapshotId: f.snapshot.id, historySessionId: f.old.id });
    expect(validated.status).toBe(200);
    expect(await validated.json()).toMatchObject({ ok: true, eligibleForAttempt: true });
  });

  it("refuses a changed or ambiguous current source and a same-name replacement", async () => {
    const f = fixture();
    db.prepare("UPDATE sessions SET resume_token='changed' WHERE id=?").run(f.current.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
    db.prepare("UPDATE sessions SET resume_token=? WHERE id=?").run(secret, f.current.id);
    const data = structuredClone(f.snapshot.data);
    data.activeOccupantsByNode![f.node.id] = { kind: "ambiguous", candidateIds: [f.old.id, f.current.id] };
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(data), f.snapshot.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(f.snapshot.data), f.snapshot.id);
    const replacement = { ...f.snapshot.data, nodes: f.snapshot.data.nodes.map((entry) => entry.id === f.node.id ? { ...entry, id: "replacement-id" } : entry) };
    db.prepare("UPDATE snapshots SET data=? WHERE id=?").run(JSON.stringify(replacement), f.snapshot.id);
    expect(await (await request(f.path)).json()).toMatchObject({ code: "source_unavailable" });
  });
});
