// OPR.0.3.4.3 — no-launch reconcile (adopt a hand-resumed canonical session).
//
// THE NO-INPUT DISCRIMINATOR (guard rev1, load-bearing): a spy tmux adapter
// proves reconcile_session calls NONE of launchNode / createSession /
// killSession / sendText / sendKeys on the target — the input-injection that a
// PID-unchanged proof cannot see. deliverClaimHint is implemented via
// sendText+sendKeys, so zero calls to those subsumes it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExpansionRequest } from "../src/domain/types.js";
import { convergeOp, SUPPORTED_OP_KINDS, isSupportedOpKind } from "../src/domain/topology-converge.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { ClaimService } from "../src/domain/claim-service.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import * as transcriptCapture from "../src/domain/transcript-capture.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

/** Fully-instrumented tmux adapter: records every call by method name. */
function spyTmux(overrides?: Partial<Record<string, unknown>>) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, impl: (...args: unknown[]) => unknown) =>
    vi.fn((...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return impl(...args);
    });
  const adapter = {
    hasSession: record("hasSession", async () => true),
    createSession: record("createSession", async () => ({ ok: true as const })),
    killSession: record("killSession", async () => ({ ok: true as const })),
    sendText: record("sendText", async () => ({ ok: true as const })),
    sendKeys: record("sendKeys", async () => ({ ok: true as const })),
    listSessions: record("listSessions", async () => []),
    listWindows: record("listWindows", async () => []),
    listPanes: record("listPanes", async () => []),
    startPipePane: record("startPipePane", async () => ({ ok: true as const })),
    stopPipePane: record("stopPipePane", async () => ({ ok: true as const })),
    setSessionOption: record("setSessionOption", async () => ({ ok: true as const })),
    getSessionOption: record("getSessionOption", async () => null),
    getPanePid: record("getPanePid", async () => 4242),
    getPaneCommand: record("getPaneCommand", async () => "zsh"),
    ...overrides,
  } as unknown as TmuxAdapter;
  return { adapter, calls };
}

function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
  return {
    id,
    label: "Infrastructure",
    members: [{ id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }],
    edges: [],
  };
}

describe("ClaimService.reconcileSession (OPR.0.3.4.3)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmuxCalls: Record<string, unknown[][]>;

  beforeEach(() => {
    db = createFullTestDb();
    const spy = spyTmux();
    tmuxCalls = spy.calls;
    setup = createTestApp(db, { tmux: spy.adapter });
  });

  afterEach(() => { db.close(); });

  /** Seed a managed seat then simulate the outage: the daemon's latest session
   *  row goes non-running while a live tmux session keeps the canonical name
   *  (the operator hand-resumed inside it). */
  async function seedDetachedSeat(podId = "infra", memberId = "server") {
    const rig = setup.rigRepo.createRig("test-rig");
    const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment(podId, memberId) });
    expect(expanded.ok).toBe(true);
    const node = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === `${podId}.${memberId}`)!;
    const sessionName = `${podId}-${memberId}@test-rig`;
    const sessions = setup.sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    for (const s of sessions) setup.sessionRegistry.markDetached(s.id);
    return { rig, node, sessionName };
  }

  function latestSessionStatus(nodeId: string): string | undefined {
    const row = db.prepare("SELECT status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(nodeId) as { status: string } | undefined;
    return row?.status;
  }

  it("adopts the live session back into its persisted node: same node id, projection flips to running", async () => {
    const { rig, node, sessionName } = await seedDetachedSeat();
    expect(latestSessionStatus(node.id)).toBe("detached");

    const result = await setup.claimService.reconcileSession({ sessionName });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No re-key: SAME node id, same logical id, same rig.
    expect(result.result.nodeId).toBe(node.id);
    expect(result.result.logicalId).toBe("infra.server");
    expect(result.result.rigId).toBe(rig.id);
    // Projection flipped: latest session row is running (ps liveness source).
    expect(latestSessionStatus(node.id)).toBe("running");
    // Binding points at the live canonical session.
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe(sessionName);
    // Node table unchanged: no new node minted.
    const nodes = setup.rigRepo.getRig(rig.id)!.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe(node.id);
  });

  it("reconcileSession replaces a NULL binding pane with the live pane and the next identity pass verifies it", async () => {
    const localDb = createFullTestDb();
    const panes = [{ id: "%refreshed", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }];
    const spy = spyTmux({
      listSessions: vi.fn(async () => [{ name: "infra-server@test-rig" }] as never),
      listPanes: vi.fn(async () => panes),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "zsh"),
    });
    const local = createTestApp(localDb, { tmux: spy.adapter });
    const rig = local.rigRepo.createRig("test-rig");
    const expanded = await local.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment() });
    expect(expanded.ok).toBe(true);
    const node = local.rigRepo.getRig(rig.id)!.nodes.find((candidate) => candidate.logicalId === "infra.server")!;
    const sessions = local.sessionRegistry.getSessionsForRig(rig.id).filter((session) => session.nodeId === node.id);
    for (const session of sessions) local.sessionRegistry.markDetached(session.id);
    localDb.prepare("UPDATE bindings SET tmux_pane = NULL WHERE node_id = ?").run(node.id);

    const result = await local.claimService.reconcileSession({ sessionName: "infra-server@test-rig" });

    expect(result.ok).toBe(true);
    expect(local.sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%refreshed");
    await new SeatIdentityReconciler({ db: localDb, tmux: spy.adapter }).reconcileAll();
    const verdict = new SeatIdentityStore(localDb).getForNode(node.id);
    expect(verdict?.verdict).toBe("verified");
    expect(verdict?.evidence.registeredPane).toBe("%refreshed");
    localDb.close();
  });

  it("NO-INPUT DISCRIMINATOR: reconcile calls no launch/kill/create/sendText/sendKeys on the target", async () => {
    const { sessionName } = await seedDetachedSeat();
    const launchSpy = vi.spyOn(setup.nodeLauncher, "launchNode");

    // Reset the call log AFTER seeding (expand legitimately creates sessions).
    for (const key of Object.keys(tmuxCalls)) delete tmuxCalls[key];

    const result = await setup.claimService.reconcileSession({ sessionName });
    expect(result.ok).toBe(true);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(tmuxCalls["createSession"] ?? []).toHaveLength(0);
    expect(tmuxCalls["killSession"] ?? []).toHaveLength(0);
    // Zero keystrokes/text into the pane — subsumes deliverClaimHint.
    expect(tmuxCalls["sendText"] ?? []).toHaveLength(0);
    expect(tmuxCalls["sendKeys"] ?? []).toHaveLength(0);
    // The allowed ops are read/metadata only.
    expect((tmuxCalls["hasSession"] ?? []).length).toBeGreaterThan(0);
  });

  it("emits node.reconciled (not node.claimed) so the operator knows which op happened", async () => {
    const { node, sessionName } = await seedDetachedSeat();
    await setup.claimService.reconcileSession({ sessionName });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.reconciled'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.nodeId).toBe(node.id);
    expect(payload.sessionName).toBe(sessionName);
    expect(db.prepare("SELECT 1 FROM events WHERE type = 'node.claimed'").all()).toHaveLength(0);
  });

  it("HONEST DRIFT: reports unproven metadata separately and never claims continuity", async () => {
    // A claude-code node whose live pane command reads "zsh" cannot be proven.
    const rig = setup.rigRepo.createRig("drift-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/repo", podId: null });
    const sess = setup.sessionRegistry.registerSession(node.id, "dev-impl@drift-rig");
    setup.sessionRegistry.markDetached(sess.id);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@drift-rig" });

    const result = await setup.claimService.reconcileSession({ sessionName: "dev-impl@drift-rig" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.projectionDrift.join(" ")).toContain("runtime unverified");
    expect(result.result.projectionDrift.join(" ")).toContain("cwd unverified");
    // Continuity is NEVER asserted.
    expect(result.result.continuity).toBe("unverified");
  });

  describe("runtime drift for a pane whose command is its launcher", () => {
    const started = "Sat Jan  1 12:00:00 2000";
    const launchScript: NativeProcessRow = { pid: 900, ppid: 1, command: "/bin/sh /tmp/launch.sh", pgid: 900, tpgid: 901, executableName: "sh", startedAt: started };
    const idleSh: NativeProcessRow = { pid: 900, ppid: 1, command: "/bin/sh", pgid: 900, tpgid: 900, executableName: "sh", startedAt: started };
    async function drift(runtime: "claude-code" | "codex", rows: NativeProcessRow[]) {
      const spy = spyTmux({ getPaneCommand: vi.fn(async () => "sh"), getPanePid: vi.fn(async () => 900) });
      const rig = setup.rigRepo.createRig(`launcher-${runtime}`);
      const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime, cwd: "/work/repo", podId: null });
      const sess = setup.sessionRegistry.registerSession(node.id, `dev-impl@launcher-${runtime}`);
      setup.sessionRegistry.markDetached(sess.id);
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: `dev-impl@launcher-${runtime}` });
      const service = new ClaimService({ db, rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry,
        discoveryRepo: setup.discoveryRepo, eventBus: setup.eventBus, tmuxAdapter: spy.adapter, listProcesses: () => rows });
      const result = await service.reconcileSession({ sessionName: `dev-impl@launcher-${runtime}` });
      expect(result.ok).toBe(true);
      return result.ok ? result.result.projectionDrift.filter((entry) => entry.startsWith("runtime unverified")) : [];
    }
    it.each(["claude-code", "codex"] as const)("reports no runtime drift when a %s process holds the pane's foreground under an sh launcher", async (runtime) => {
      const exe = runtime === "claude-code" ? "claude" : "codex";
      expect(await drift(runtime, [launchScript, { pid: 901, ppid: 900, command: exe, pgid: 901, tpgid: 901, executableName: exe, startedAt: started }])).toEqual([]);
    });
    it.each(["claude-code", "codex"] as const)("keeps the unverified note for a %s node whose pane is only an idle shell", async (runtime) => {
      expect(await drift(runtime, [idleSh])).toEqual([`runtime unverified: pane command "sh" does not confirm runtime "${runtime}"`]);
    });
  });

  it("session_not_found when no live tmux session has the canonical name (never adopts a ghost)", async () => {
    const spy = spyTmux({ hasSession: vi.fn(async () => false) });
    const localDb = createFullTestDb();
    const local = createTestApp(localDb, { tmux: spy.adapter });
    const rig = local.rigRepo.createRig("ghost-rig");
    const node = local.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    local.sessionRegistry.registerSession(node.id, "dev-impl@ghost-rig");

    const result = await local.claimService.reconcileSession({ sessionName: "dev-impl@ghost-rig" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("session_not_found");
    localDb.close();
  });

  it("node_not_found for a session name the daemon never managed (points at discover/bind)", async () => {
    const result = await setup.claimService.reconcileSession({ sessionName: "stranger@nowhere" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("node_not_found");
    expect(result.message).toContain("rig discover");
  });

  it("IDENTITY BOUNDARY: explicit --rig/--node cannot bind an arbitrary never-managed session (re-key bypass)", async () => {
    // Guard re-review finding: a live session named outside the node's
    // canonical/managed name, with NO daemon-history mapping, must be refused
    // even with explicit --rig/--node. tmux hasSession is true (spy default).
    const rig = setup.rigRepo.createRig("bypass-rig");
    const podId = "pod-bypass";
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(podId, rig.id, "dev", "Dev");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId });

    const result = await setup.claimService.reconcileSession({
      sessionName: "stranger@nowhere",
      rigId: rig.id,
      logicalId: "dev.impl",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("node_mismatch");
    expect(result.message).toContain("dev-impl@bypass-rig"); // points at the canonical name
    expect(result.message).toContain("rig discover");
    // NOTHING mutated: no binding, no session row, no event.
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(db.prepare("SELECT 1 FROM sessions WHERE node_id = ?").all(node.id)).toHaveLength(0);
    expect(db.prepare("SELECT 1 FROM events WHERE type = 'node.reconciled'").all()).toHaveLength(0);
  });

  it("explicit --rig/--node WITH no history mapping still works for the node's OWN canonical name", async () => {
    // Positive: history purged but the operator names the node's exact
    // canonical session - explicit disambiguation is allowed.
    const rig = setup.rigRepo.createRig("canon-rig");
    const podId = "pod-canon";
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(podId, rig.id, "dev", "Dev");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId });

    const result = await setup.claimService.reconcileSession({
      sessionName: "dev-impl@canon-rig",
      rigId: rig.id,
      logicalId: "dev.impl",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodeId).toBe(node.id);
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@canon-rig");
  });

  it("node_mismatch when explicit --rig/--node disagrees with the daemon's session mapping", async () => {
    const { rig, sessionName } = await seedDetachedSeat();
    // A second node in the same rig that does NOT map to this session.
    const other = setup.rigRepo.addNode(rig.id, "infra.other", { runtime: "terminal", podId: null });

    const result = await setup.claimService.reconcileSession({ sessionName, rigId: rig.id, logicalId: "infra.other" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("node_mismatch");
    // Nothing mutated for the mismatched node.
    expect(setup.sessionRegistry.getBindingForNode(other.id)).toBeNull();
  });

  it("cross-runtime: claude-code, codex, and terminal nodes each reconcile", async () => {
    for (const runtime of ["claude-code", "codex", "terminal"] as const) {
      const rig = setup.rigRepo.createRig(`rt-${runtime}`);
      const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime, podId: null });
      const sess = setup.sessionRegistry.registerSession(node.id, `dev-impl@rt-${runtime}`);
      setup.sessionRegistry.markDetached(sess.id);

      const result = await setup.claimService.reconcileSession({ sessionName: `dev-impl@rt-${runtime}` });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.result.nodeId).toBe(node.id);
      expect(latestSessionStatus(node.id)).toBe("running");
    }
  });
});

describe("binding-only missing-pane repair", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmux: TmuxAdapter;
  let guard: SeatDeliveryGuard;
  let nodeId: string;
  let sessionId: string;
  const sessionName = "worker@repair-fixture";

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    tmux = spyTmux({
      probeSession: vi.fn(async () => ({ state: "present" })),
      listSessions: vi.fn(async () => [{ name: sessionName, windows: 1, created: "123", attached: false }]),
      listPanes: vi.fn(async () => [{ id: "%1" }]),
    }).adapter;
    setup = createTestApp(db, { tmux, transcriptStore: new TranscriptStore({ enabled: false }), appDeps: { terminalBearerToken: "repair-test-token" } });
    const rig = setup.rigRepo.createRig("repair-fixture");
    nodeId = setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", podId: null }).id;
    sessionId = setup.sessionRegistry.registerSession(nodeId, sessionName).id;
    setup.sessionRegistry.updateStatus(sessionId, "running");
    setup.sessionRegistry.updateBinding(nodeId, { tmuxSession: sessionName });
    db.prepare(`UPDATE sessions SET resume_type='codex_id', resume_token='retained-token',
      resume_provenance='hook', restore_policy='relaunch_fresh' WHERE id=?`).run(sessionId);
    db.prepare("UPDATE bindings SET updated_at='2000-01-01' WHERE node_id=?").run(nodeId);
    guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    tmux.deliveryGuard = guard;
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body)
      VALUES ('pending-work','2000-01-01','2000-01-01','sender@repair-fixture',?,'pending','retain obligation')`).run(sessionName);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  // Every domain table, not a selected list of fields that could overlook adoption side effects.
  function stored() {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
  }
  function repair() {
    const opts = { sessionName, repairMissingPane: true as const };
    return setup.claimService.reconcileSession(opts);
  }
  function post(body: unknown = {}, token: string | null = "repair-test-token") {
    return setup.app.request(`/api/sessions/${encodeURIComponent(sessionName)}/repair-missing-pane`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it.each([false, true])("fills only pane/timestamp; preserves all records and capture hooks (legacy tenure absent=%s)", async absent => {
    if (absent) db.prepare("DELETE FROM occupant_tenures WHERE node_id=?").run(nodeId);
    const capture = vi.spyOn(transcriptCapture, "startTmuxTranscriptCapture");
    const before = stored();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { mode: "repair-missing-pane", sessionId, pane: "%1", continuity: "unverified" } });
    const after = stored();
    const binding = (after.bindings as Record<string, unknown>[])[0]!;
    expect(binding.tmux_pane).toBe("%1");
    expect(binding.updated_at).not.toBe("2000-01-01");
    expect({ ...binding, tmux_pane: null, updated_at: "2000-01-01" }).toEqual((before.bindings as unknown[])[0]);
    expect({ ...after, bindings: before.bindings }).toEqual(before);
    expect(capture).not.toHaveBeenCalled();
    for (const method of ["createSession", "killSession", "sendText", "sendKeys", "setSessionOption", "startPipePane", "stopPipePane"] as const) {
      expect(tmux[method]).not.toHaveBeenCalled();
    }
    expect(tmux.listSessions).toHaveBeenCalledTimes(2);
    expect(tmux.listPanes).toHaveBeenCalledTimes(2);
    expect(tmux.getPanePid).toHaveBeenCalledTimes(2);
  });

  it.each([null, "wrong-token"])("requires terminal auth (%s) before any observation/write", async token => {
    const before = stored();
    expect((await post({}, token)).status).toBe(401);
    expect(stored()).toEqual(before);
    expect(tmux.listPanes).not.toHaveBeenCalled();
  });
  it.each([null, [], { rigId: 7 }, { rigId: "r" }, { logicalId: "worker" }])("rejects malformed/disambiguation request %j", async body => {
    const before = stored();
    expect((await post(body)).status).toBe(400);
    expect(stored()).toEqual(before);
  });
  it("refuses explicit rig/node mismatch without choosing a different seat", async () => {
    const before = stored();
    const res = await post({ rigId: "another-rig", logicalId: "worker" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "node_mismatch" });
    expect(stored()).toEqual(before);
  });
  it("preserves a token refreshed during observation", async () => {
    tmux.getPanePid = vi.fn(async () => {
      db.prepare("UPDATE sessions SET resume_token='newer-hook-token' WHERE id=?").run(sessionId);
      return 4242;
    });
    expect(await repair()).toMatchObject({ ok: true, result: { sessionId } });
    expect(db.prepare("SELECT resume_token, resume_provenance FROM sessions WHERE id=?").get(sessionId))
      .toEqual({ resume_token: "newer-hook-token", resume_provenance: "hook" });
  });

  it.each(["unavailable", "absent", "no panes", "two panes", "two windows", "no pid", "changed pid", "changed pane", "changed session"])("does not write after %s observation", async mode => {
    if (mode === "unavailable") tmux.probeSession = vi.fn(async () => ({ state: "transport_unavailable", cause: "fixture" }));
    if (mode === "absent") tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    if (mode === "no panes") tmux.listPanes = vi.fn(async () => []);
    if (mode === "two panes") tmux.listPanes = vi.fn(async () => [{ id: "%1" }, { id: "%2" }] as never);
    if (mode === "two windows") tmux.listSessions = vi.fn(async () => [{ name: sessionName, windows: 2, created: "123" }] as never);
    if (mode === "no pid") tmux.getPanePid = vi.fn(async () => null);
    if (mode === "changed pid") tmux.getPanePid = vi.fn().mockResolvedValueOnce(4242).mockResolvedValue(4243);
    if (mode === "changed pane") tmux.listPanes = vi.fn().mockResolvedValueOnce([{ id: "%1" }]).mockResolvedValue([{ id: "%2" }]);
    if (mode === "changed session") tmux.listSessions = vi.fn().mockResolvedValueOnce([{ name: sessionName, windows: 1, created: "123" }]).mockResolvedValue([{ name: sessionName, windows: 1, created: "124" }]);
    const before = stored();
    expect(await repair()).toMatchObject({ ok: false });
    expect(stored()).toEqual(before);
  });
  it.each(["%1", "%stale"])("never overwrites a non-NULL pane %s", async pane => {
    db.prepare("UPDATE bindings SET tmux_pane=? WHERE node_id=?").run(pane, nodeId);
    const before = stored();
    expect(await repair()).toMatchObject({ ok: false, code: "repair_not_applicable" });
    expect(stored()).toEqual(before);
  });
  it.each(["detached", "claimed", "external", "missing binding"])("does not adopt an ineligible %s seat", async kind => {
    if (kind === "detached") setup.sessionRegistry.markDetached(sessionId);
    if (kind === "claimed") db.prepare("UPDATE sessions SET origin='claimed' WHERE id=?").run(sessionId);
    if (kind === "external") db.prepare("UPDATE bindings SET attachment_type='external_cli' WHERE node_id=?").run(nodeId);
    if (kind === "missing binding") db.prepare("DELETE FROM bindings WHERE node_id=?").run(nodeId);
    const before = stored();
    expect(await repair()).toMatchObject({ ok: false });
    expect(stored()).toEqual(before);
  });
  it.each(["binding id", "session", "occupant", "target", "name collision"])("fences a concurrent %s change at commit", async kind => {
    let expected: ReturnType<typeof stored>;
    tmux.getPanePid = vi.fn(async () => {
      if (kind === "binding id") db.prepare("UPDATE bindings SET id='replacement-binding' WHERE node_id=?").run(nodeId);
      if (kind === "session") setup.sessionRegistry.registerSession(nodeId, sessionName);
      if (kind === "occupant") db.prepare(`INSERT OR IGNORE INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind)
        VALUES ('replacement',?,99,'new-generation','adopt')`).run(nodeId);
      if (kind === "target") db.prepare("UPDATE bindings SET tmux_session='replacement@repair-fixture' WHERE node_id=?").run(nodeId);
      if (kind === "name collision" && !db.prepare("SELECT 1 FROM nodes WHERE logical_id='other'").get()) {
        const other = setup.rigRepo.addNode(setup.rigRepo.listRigs()[0]!.id, "other", { runtime: "terminal", podId: null });
        setup.sessionRegistry.updateBinding(other.id, { tmuxSession: sessionName });
      }
      expected = stored(); return 4242;
    });
    expect(await repair()).toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(stored()).toEqual(expected!);
  });
  it.each(["hold", "draft-aware"] as const)("does not change active %s protection", async mode => {
    await guard.set(nodeId, { mode }, "person", "retain draft");
    const before = stored();
    expect(await repair()).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(stored()).toEqual(before);
  });
  it.each([[1, 0], [0, 1]])("does not change pending legacy desired/effective protection %j/%j", async (desired, effective) => {
    db.prepare(`INSERT INTO seat_delivery_guards(node_id,desired,effective,actor,reason,changed_at)
      VALUES (?,?,?,'person','pending protection','2000-01-01')`).run(nodeId, desired, effective);
    const before = stored();
    expect(await repair()).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(stored()).toEqual(before);
  });
  it("does not repair through a degraded adapter with no delivery guard", async () => {
    tmux.deliveryGuard = undefined;
    const before = stored();
    expect(await repair()).toMatchObject({ ok: false });
    expect(stored()).toEqual(before);
  });
  it.each(["human", "automatic", "pending protection"])("does not commit during %s work", async kind => {
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(r => { entered = r; }), done = new Promise<void>(r => { finish = r; });
    const work = async () => { entered(); await done; };
    const working = kind === "human" ? guard.humanInput(nodeId, work) : guard.operation(nodeId, work);
    await ready;
    try {
      if (kind === "pending protection") expect(await guard.set(nodeId, true, "person", "draft", 1)).toMatchObject({ pending: true });
      const before = stored();
      expect(await repair()).toMatchObject({ ok: false, code: "guard_operation_in_progress" });
      expect(stored()).toEqual(before);
    } finally { finish(); await working; }
  });
  it("never commits a delayed observation after its five-second deadline", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const delayed = new Promise<void>(r => { finish = r; });
    tmux.listPanes = vi.fn(async () => { await delayed; return [{ id: "%1" }] as never; });
    const before = stored(), pending = repair();
    try {
      await vi.advanceTimersByTimeAsync(5001);
      expect(await Promise.race([pending, Promise.resolve({ stillWaiting: true })])).toMatchObject({ ok: false, code: "repair_timed_out" });
    } finally { finish(); await pending; }
    expect(stored()).toEqual(before);
  });
});

describe("reconcile_session on the converge spine (OPR.0.3.4.3)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { tmux: spyTmux().adapter });
  });
  afterEach(() => { db.close(); });

  it("reconcile_session is a SUPPORTED op kind on the spine", () => {
    expect(SUPPORTED_OP_KINDS).toContain("reconcile_session");
    expect(isSupportedOpKind("reconcile_session")).toBe(true);
  });

  it("convergeOp dispatches reconcile_session to the claim service (on-spine, not a one-off)", async () => {
    const rig = setup.rigRepo.createRig("spine-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    const sess = setup.sessionRegistry.registerSession(node.id, "dev-impl@spine-rig");
    setup.sessionRegistry.markDetached(sess.id);

    const result = await convergeOp(
      { instantiator: setup.podInstantiator, claimService: setup.claimService },
      "",
      { kind: "reconcile_session", sessionName: "dev-impl@spine-rig" },
      ".",
    );

    expect(result.kind).toBe("reconcile_session");
    expect(result.supported).toBe(true);
    if (result.kind !== "reconcile_session" || !result.supported) return;
    expect(result.outcome.ok).toBe(true);
    if (!result.outcome.ok) return;
    expect(result.outcome.result.nodeId).toBe(node.id);
  });

  it("convergeOp without a claim service reports an honest error (no silent skip)", async () => {
    const result = await convergeOp(
      { instantiator: setup.podInstantiator },
      "",
      { kind: "reconcile_session", sessionName: "dev-impl@spine-rig" },
      ".",
    );
    expect(result.kind).toBe("reconcile_session");
    if (result.kind !== "reconcile_session" || !result.supported) return;
    expect(result.outcome.ok).toBe(false);
  });
});

describe("POST /api/sessions/:sessionName/reconcile (OPR.0.3.4.3)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { tmux: spyTmux().adapter });
  });
  afterEach(() => { db.close(); });

  function post(sessionName: string, body: Record<string, unknown> = {}) {
    return setup.app.request(`/api/sessions/${encodeURIComponent(sessionName)}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each(["terminal", "codex"])("returns 200 with capture information for a live detached %s seat", async runtime => {
    const rig = setup.rigRepo.createRig("route-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime, podId: null });
    const sess = setup.sessionRegistry.registerSession(node.id, "dev-impl@route-rig");
    setup.sessionRegistry.markDetached(sess.id);

    const res = await post("dev-impl@route-rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.nodeId).toBe(node.id);
    expect(body.result.continuity).toBe("unverified");
    expect(body.result.resumeMetadata).toMatchObject({
      capture: { outcome: runtime === "terminal" ? "exempt" : "noop" }, status: runtime === "terminal" ? "not_applicable" : "missing",
    });
    if (runtime === "codex") expect(body.result.resumeMetadata.guidance).toContain("rig seat set-resume-token");
  });

  it("returns 404 for an unmapped session name", async () => {
    const res = await post("stranger@nowhere");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("node_not_found");
  });

  it("returns 409 for a node_mismatch", async () => {
    const rig = setup.rigRepo.createRig("route-rig2");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    setup.rigRepo.addNode(rig.id, "dev.other", { runtime: "terminal", podId: null });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@route-rig2");

    const res = await post("dev-impl@route-rig2", { rigId: rig.id, logicalId: "dev.other" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("node_mismatch");
  });

  it("returns 400 when only one of rigId/logicalId is given", async () => {
    const res = await post("dev-impl@route-rig3", { rigId: "some-rig" });
    expect(res.status).toBe(400);
  });

  it("returns 409 for the explicit-rig/node arbitrary-session re-key bypass (nothing mutated)", async () => {
    const rig = setup.rigRepo.createRig("route-bypass");
    const podId = "pod-rb";
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(podId, rig.id, "dev", "Dev");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId });

    const res = await post("stranger@nowhere", { rigId: rig.id, logicalId: "dev.impl" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("node_mismatch");
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
  });
});
