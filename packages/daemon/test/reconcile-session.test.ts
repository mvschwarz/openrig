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

  it("returns 200 with the reconcile result for a live detached seat", async () => {
    const rig = setup.rigRepo.createRig("route-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    const sess = setup.sessionRegistry.registerSession(node.id, "dev-impl@route-rig");
    setup.sessionRegistry.markDetached(sess.id);

    const res = await post("dev-impl@route-rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.nodeId).toBe(node.id);
    expect(body.result.continuity).toBe("unverified");
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
