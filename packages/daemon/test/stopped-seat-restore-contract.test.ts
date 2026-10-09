import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createDefaultRestoreRig } from "../src/domain/crash-cart-conductor.js";

const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(opts: { status?: string; noRow?: boolean; token?: string | null; policy?: string; kind?: string } = {}) {
  const db = createFullTestDb(); databases.push(db);
  const live = new Set<string>();
  const tmux = {
    hasSession: vi.fn(async (name: string) => live.has(name)),
    probeSession: vi.fn(async (name: string) => ({ state: live.has(name) ? "present" : "absent" })),
    createSession: vi.fn(async (name: string) => { live.add(name); return { ok: true }; }),
    killSession: vi.fn(async (name: string) => { live.delete(name); return { ok: true }; }),
    listSessions: vi.fn(async () => [...live].map(name => ({ name }))),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%fixture", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 100),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n❯"),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    setSessionOption: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  const setup = createTestApp(db, { tmux, wireRuntimeAdapters: true });
  const { rigRepo, sessionRegistry, snapshotCapture } = setup;
  const rig = rigRepo.createRig("stopped-review");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "Review");
  const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "claude-code", podId: "pod", cwd: "/tmp" });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
  if (!opts.noRow) {
    const row = sessionRegistry.registerSession(node.id, "dev-worker@stopped-review");
    sessionRegistry.updateStatus(row.id, opts.status ?? "exited");
    sessionRegistry.updateStartupStatus(row.id, "ready");
    if (opts.token !== null) sessionRegistry.updateResumeToken(row.id, "claude_id", opts.token ?? "00000000-0000-4000-8000-000000000005", "hook");
    if (opts.policy) db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?").run(opts.policy, row.id);
  }
  const snapshot = snapshotCapture.captureSnapshot(rig.id, (opts.kind ?? "manual") as never);
  const post = (path: string, body: unknown = {}) => setup.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...setup, db, tmux, rig, node, snapshot, post, live };
}

// Backlog finding 5 through the public surfaces: a seat stopped before the snapshot, whose earlier
// occupant left a resume token, stops for a decision on apply, and every forecast says so first
// (launch-plan, POST /api/up plan, rig status, restore-check), while the fresh controls still launch.
// Derived from dev-review's contract probe of 3c0f2cb3.
describe("stopped-seat restore contract", () => {
  it.each(["exited", "detached", "unknown", "superseded"])("manual capture with %s history stops before native effects", async status => {
    const h = fixture({ status });
    expect(h.snapshot.data.activeOccupantsByNode?.[h.node.id]).toEqual({ kind: "absent" });
    const result = await h.restoreOrchestrator.restore(h.snapshot.id);
    expect(result).toMatchObject({ ok: true, result: { nodes: [expect.objectContaining({ status: "awaiting-decision" })] } });
    expect(h.tmux.createSession).not.toHaveBeenCalled();
    expect(h.tmux.sendText).not.toHaveBeenCalled();
  });

  it("stopped seat stays absent in auto-rehydrate capture and asks", async () => {
    const h = fixture({ kind: "auto-rehydrate" });
    expect(h.snapshot.data.activeOccupantsByNode?.[h.node.id]).toEqual({ kind: "absent" });
    expect(await h.restoreOrchestrator.restore(h.snapshot.id)).toMatchObject({ ok: true, result: { nodes: [expect.objectContaining({ status: "awaiting-decision" })] } });
    expect(h.tmux.createSession).not.toHaveBeenCalled();
  });

  it("public preview predicts the same decision as apply", async () => {
    const h = fixture();
    const preview = await h.post(`/api/rigs/${h.rig.id}/launch-plan`);
    const plan = await preview.json();
    const status = await (await h.app.request(`/api/rigs/${h.rig.id}/status`)).json();
    const check = await (await h.app.request("/api/restore-check?rig=stopped-review&no_queue=true&no_hooks=true")).json();
    const upPlan = await (await h.post("/api/up", { sourceRef: "stopped-review", plan: true })).json();
    const applied = await h.post(`/api/rigs/${h.rig.id}/up`);
    const result = await applied.json();
    expect(result).toMatchObject({ nodes: [expect.objectContaining({ status: "awaiting-decision" })] });
    expect(h.tmux.createSession).not.toHaveBeenCalled();
    expect(plan.nodes[0]).toMatchObject({ intendedAction: "awaiting-decision", reason: expect.stringContaining("--fresh dev.worker") });
    expect(upPlan.nodes[0].intendedAction).toBe("awaiting-decision");
    expect(JSON.stringify(status)).toContain('"intendedAction":"awaiting-decision"');
    expect(JSON.stringify(status)).toContain("restore-plan: 1 awaiting-decision");
    expect(check.checks.find((item: { check: string }) => item.check.endsWith(".resume-path")).remediation)
      .toBe("No live session to attach. Preview what restore would do for this seat with: rig up stopped-review --existing --plan");
  });

  it.each(["explicit-fresh", "no-token", "relaunch-policy", "never-occupied", "legacy-zero"])("public apply preserves the fresh control: %s", async mode => {
    const h = fixture(mode === "no-token" ? { token: null } : mode === "relaunch-policy" ? { policy: "relaunch_fresh" } : mode === "never-occupied" || mode === "legacy-zero" ? { noRow: true } : {});
    if (mode === "legacy-zero") {
      const data = structuredClone(h.snapshot.data);
      delete data.activeOccupantsByNode;
      delete data.activeSessionIdByNode;
      h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), h.snapshot.id);
    }
    const response = await h.post(`/api/rigs/${h.rig.id}/up`, mode === "explicit-fresh" ? { freshLogicalIds: ["dev.worker"] } : {});
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.nodes).toEqual([expect.objectContaining({ logicalId: "dev.worker", status: "fresh-primed" })]);
    expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
  });

  it("subset plan remains read-only and subset apply exposes the decision", async () => {
    const h = fixture();
    const path = `/api/rigs/${h.rig.id}/nodes/launch-subset`;
    const planned = await h.post(path, { seats: ["dev.worker"], plan: true });
    const plan = await planned.json();
    expect(h.tmux.createSession).not.toHaveBeenCalled();
    const applied = await h.post(path, { seats: ["dev.worker"] });
    const result = await applied.json();
    expect(plan).toMatchObject({ ok: true, planOnly: true, targetNodes: [{ logicalId: "dev.worker", nodeId: h.node.id }] });
    expect(applied.status).toBe(409);
    expect(result).toMatchObject({ ok: false, launched: [expect.objectContaining({ status: "awaiting-decision", error: expect.stringContaining("--fresh dev.worker") })] });
    expect(h.tmux.createSession).not.toHaveBeenCalled();
    expect(h.tmux.sendText).not.toHaveBeenCalled();
  });

  it("crash-cart surfaces the exact decision without a native launch", async () => {
    const h = fixture();
    const restore = createDefaultRestoreRig({
      findLatestRestoreUsable: rigId => h.snapshotRepo.findLatestRestoreUsable(rigId),
      selectRestoreUsable: rigId => h.snapshotRepo.selectRestoreUsable(rigId),
      restore: (snapshotId, opts) => h.restoreOrchestrator.restore(snapshotId, opts),
    });
    const result = await restore(h.rig.id);
    expect(result.attention).toEqual([expect.objectContaining({ seat: "dev.worker", need: expect.stringContaining("--fresh dev.worker") })]);
    expect(h.tmux.createSession).not.toHaveBeenCalled();
  });
});
