import { afterEach, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
const root = "/fixture/materialized";
const close: Array<() => void> = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });
async function fixture(captureSnapshot = true) {
  const db = createFullTestDb(); close.push(() => db.close());
  const files: Record<string, string> = {
    [root]: "",
    [`${root}/agent/agent.yaml`]: 'name: worker\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\nstartup:\n  files:\n    - path: role.md\n      required: true\n      delivery_hint: send_text\n',
    [`${root}/agent/role.md`]: "Read your role and work with the team.",
  };
  const adapter: RuntimeAdapter = { runtime: "pi", listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 1, failed: [] })),
    launchHarness: vi.fn(async () => ({ ok: true })), checkReady: vi.fn(async () => ({ ready: true })),
  };
  const tmux = mockTmuxAdapter(); tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
  const options = { tmux, adapters: { pi: adapter }, podInstantiatorFsOps: {
    exists: (path: string) => path in files, readFile: (path: string) => { if (!(path in files)) throw new Error(`Missing ${path}`); return files[path]!; },
  } };
  const app = createTestApp(db, options);
  const source = { version: "0.2", name: "materialized", pods: [{ id: "dev", label: "Dev", members: ["lead", "build", "review", "qa"].map(id => ({ id,
    agent_ref: "local:agent", profile: "default", runtime: "pi", model: "provider/model", cwd: root,
  })), edges: [] }], edges: [] };
  const materialized = await app.podInstantiator.materialize(JSON.stringify(source), root);
  expect(materialized.ok, JSON.stringify(materialized)).toBe(true);
  if (!materialized.ok) throw new Error("fixture materialization failed");
  const rigId = materialized.result.rigId;
  if (captureSnapshot) app.snapshotCapture.captureSnapshot(rigId, "manual");
  return { ...app, db, adapter, tmux, files, rigId, reopen: () => createTestApp(db, options) };
}
it.each([[false, true], [true, true], [true, false]])("first-starts only the selected seat with authored startup and four records intact (reopened=%s, snapshot=%s)", async (reopened, snapshot) => {
  const f = await fixture(snapshot);
  if (reopened) f.app = f.reopen().app;
  const before = f.rigRepo.getRig(f.rigId)!;
  expect(f.sessionRegistry.getSessionsForRig(f.rigId)).toEqual([]);
  expect(f.adapter.launchHarness).not.toHaveBeenCalled();
  const changes = f.db.prepare("SELECT total_changes() AS n").get();
  const plan = await f.app.request(`/api/rigs/${f.rigId}/nodes/launch-subset`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seats: ["dev.lead"], plan: true, nonTargetMode: "unchanged" }) });
  if (snapshot) expect(await plan.json()).toMatchObject({ ok: true, planOnly: true, targetNodes: [{ logicalId: "dev.lead" }], nonTargetEffects: { mode: "unchanged" } });
  else expect(await plan.json()).toMatchObject({ ok: false });
  expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  const response = await f.app.request(`/api/rigs/${f.rigId}/nodes/dev.lead/launch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await response.json();
  expect({ status: response.status, body }, JSON.stringify(body)).toMatchObject({ status: 201, body: { ok: true, logicalId: "dev.lead" } });
  const after = f.rigRepo.getRig(f.rigId)!;
  expect(after.nodes.map(node => node.id)).toEqual(before.nodes.map(node => node.id));
  for (const node of before.nodes.filter(node => node.logicalId !== "dev.lead")) expect(after.nodes.find(other => other.id === node.id)).toEqual(node);
  const sessions = f.sessionRegistry.getSessionsForRig(f.rigId);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.nodeId).toBe(before.nodes.find(node => node.logicalId === "dev.lead")!.id);
  expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.adapter.deliverStartup).mock.calls.flatMap(call => call[0])).toEqual(expect.arrayContaining([
    expect.objectContaining({ absolutePath: `${root}/agent/role.md`, required: true }),
  ]));
  expect(f.tmux.killSession).not.toHaveBeenCalled();
  const newest = f.snapshotRepo.getLatestSnapshot(f.rigId);
  expect(newest?.data.nodeStartupContext?.[sessions[0]!.nodeId]).toBeTruthy();
  expect(await f.podInstantiator.launchFirstMaterializedNode(f.rigId, sessions[0]!.nodeId)).toBeNull();
  expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
});

it.each(["present", "unknown", "changed", "history"])("keeps %s targets out of first-start effects", async control => {
  const f = await fixture();
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  if (control === "present" || control === "unknown") vi.mocked(f.tmux.probeSession).mockResolvedValue(control === "present" ? { state: "present" } : { state: "transport_unavailable", cause: "fixture" });
  if (control === "changed") f.db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(node.id);
  if (control === "history") f.sessionRegistry.registerSession(node.id, "dev-lead@materialized");
  const changes = f.db.prepare("SELECT total_changes() AS n").get();
  const result = await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id);
  if (control === "history") expect(result).toBeNull();
  else expect(result).toMatchObject({ ok: false, code: control === "changed" ? "first_start_source_changed" : "target_liveness_unknown" });
  expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(f.adapter.project).not.toHaveBeenCalled();
  expect(f.adapter.launchHarness).not.toHaveBeenCalled();
});

it("leaves a seat alone when its selection changes during liveness checks", async () => {
  const f = await fixture();
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  vi.mocked(f.tmux.probeSession).mockImplementation(async () => {
    f.rigRepo.setNodeModel(node.id, "provider/changed");
    return { state: "absent" };
  });
  expect(await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id)).toMatchObject({ ok: false, code: "selection_changed" });
  expect(f.adapter.launchHarness).not.toHaveBeenCalled();
  expect(f.sessionRegistry.getSessionsForRig(f.rigId)).toEqual([]);
});

it.each(["legacy", "explicit snapshot"])("keeps %s launches on the existing restore path", async control => {
  const f = await fixture();
  if (control === "legacy") f.rigRepo.setRigStartupLayers(f.rigId, null);
  const snapshot = f.snapshotRepo.getLatestSnapshot(f.rigId)!;
  const response = await f.app.request(`/api/rigs/${f.rigId}/nodes/dev.lead/launch`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(control === "explicit snapshot" ? { snapshotId: snapshot.id } : {}) });
  expect(await response.json()).toMatchObject({ ok: false, code: "attention_required" });
  expect(f.adapter.launchHarness).not.toHaveBeenCalled();
});
