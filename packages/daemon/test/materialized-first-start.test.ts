import { afterEach, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp, mockNativeRuntime, mockTmuxAdapter } from "./helpers/test-app.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import nodePath from "node:path";
import { validateCodexMemberPermissions } from "../src/domain/codex-member-permissions.js";
const root = "/fixture/materialized";
const close: Array<() => void> = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });
async function fixture(captureSnapshot = true, memberPatch: Record<string, unknown> = {}) {
  const db = createFullTestDb(); close.push(() => db.close());
  const files: Record<string, string> = {
    [root]: "",
    [`${root}/agent/agent.yaml`]: 'name: worker\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\nstartup:\n  files:\n    - path: role.md\n      required: true\n      delivery_hint: send_text\n',
    [`${root}/agent/role.md`]: "Read your role and work with the team.",
  };
  const runtime = typeof memberPatch.runtime === "string" ? memberPatch.runtime : "pi";
  const adapter: RuntimeAdapter = { runtime, listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 1, failed: [] })),
    launchHarness: vi.fn(async () => ({ ok: true })), checkReady: vi.fn(async () => ({ ready: true })),
  };
  // A Codex launch checks the pane's process, so its panes run codex.
  const native = runtime === "codex" ? mockNativeRuntime(() => "codex") : undefined;
  const tmux = native?.tmux ?? mockTmuxAdapter(); tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
  const fileAt = (file: string) => Object.keys(files).find(key => nodePath.resolve(key) === nodePath.resolve(file));
  const options = { tmux, ...(native ? { listProcesses: native.listProcesses } : {}), adapters: { [runtime]: adapter }, podInstantiatorFsOps: {
    exists: (file: string) => fileAt(file) !== undefined, readFile: (file: string) => { const key = fileAt(file); if (key === undefined) throw new Error(`Missing ${file}`); return files[key]!; },
  } };
  const app = createTestApp(db, options);
  const source = { version: "0.2", name: "materialized", pods: [{ id: "dev", label: "Dev", members: ["lead", "build", "review", "qa"].map(id => ({ id,
    agent_ref: "local:agent", profile: "default", runtime: "pi", model: "provider/model", cwd: root, ...memberPatch,
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
    expect.objectContaining({ absolutePath: nodePath.resolve(root, "agent", "role.md"), required: true }),
  ]));
  expect(f.tmux.killSession).not.toHaveBeenCalled();
  const newest = f.snapshotRepo.getLatestSnapshot(f.rigId);
  expect(newest?.data.nodeStartupContext?.[sessions[0]!.nodeId]).toBeTruthy();
  expect(await f.podInstantiator.launchFirstMaterializedNode(f.rigId, sessions[0]!.nodeId)).toBeNull();
  expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
});

it.each(["present", "unknown", "history"])("keeps %s targets out of first-start effects", async control => {
  const f = await fixture();
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  if (control === "present" || control === "unknown") vi.mocked(f.tmux.probeSession).mockResolvedValue(control === "present" ? { state: "present" } : { state: "transport_unavailable", cause: "fixture" });
  if (control === "history") f.sessionRegistry.registerSession(node.id, "dev-lead@materialized");
  const changes = f.db.prepare("SELECT total_changes() AS n").get();
  const result = await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id);
  if (control === "history") expect(result).toBeNull();
  else expect(result).toMatchObject({ ok: false, code: control === "present" ? "target_session_present" : "target_liveness_unknown" });
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

it.each(["builtin:locked", "none"])("first launch keeps a subsequently locked permission policy (%s)", async ref => {
  const f = await fixture(false, { permission_policy: "builtin:yolo" });
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  const applied = await f.app.request("/api/seat/set-policy/dev-lead@materialized", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref, reason: "Use restricted permissions", operator: "human" }) });
  expect(await applied.json()).toMatchObject({ ok: true, launchPosture: "floor" });
  const response = await f.app.request(`/api/rigs/${f.rigId}/nodes/dev.lead/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(201);
  expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0]).toMatchObject({ launchPosture: "floor" });
  expect(f.rigRepo.getNodePolicyProvenance(node.id)).toMatchObject({ nodeRef: ref, launchPosture: "floor" });
});
// The setter saves a Codex envelope on the node, and the first start launches with that one (NativePermissionStore at
// startup), so its rig reach warning describes the saved envelope, not the materialized declaration.
const networkOff = { sandbox: "workspace-write", approval: "never" };
const networkOn = { ...networkOff, network_access: true };
it.each<[string, Record<string, unknown> | undefined, Record<string, unknown>, boolean]>([
  ["saving network on over a declared network off", networkOff, { codexPermissions: networkOn }, false],
  ["saving network off over a declared network on", networkOn, { codexPermissions: networkOff }, true],
  ["saving network off over no declared envelope", undefined, { codexPermissions: networkOff }, true],
  ["choosing a mode, which clears a declared network off", networkOff, { mode: "floor" }, false],
])("a Codex seat's first start warns from its current saved permissions after %s", async (_case, declared, choice, warns) => {
  const f = await fixture(false, { runtime: "codex", ...(declared ? { codex_permissions: declared } : {}) });
  const set = await f.app.request("/api/seat/set-permissions/dev-lead@materialized", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...choice, reason: "Change it before the first start", operator: "human" }) });
  expect(await set.json()).toMatchObject({ ok: true });
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  const result = await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const reach = (result!.warnings ?? []).filter(warning => warning.startsWith("dev.lead: network is off in this seat's codex_permissions."));
  expect(reach, JSON.stringify(result!.warnings)).toHaveLength(warns ? 1 : 0);
  // The launch used the same saved envelope, or none once a mode replaced it.
  expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0].codexPermissions).toEqual("mode" in choice ? undefined : validateCodexMemberPermissions(choice.codexPermissions));
});

it("starts an empty tmux server before checking the first target", async () => {
  const f = await fixture(false); let ready = false;
  f.tmux.startServer = vi.fn(async () => { ready = true; });
  vi.mocked(f.tmux.probeSession).mockImplementation(async () => ready ? { state: "absent" } : { state: "transport_unavailable", cause: "no server running" });
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  expect(await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id)).toMatchObject({ ok: true });
  expect(f.adapter.launchHarness).toHaveBeenCalledOnce();
});

it("launches the saved model and effort and explains their changes", async () => {
  const f = await fixture(false, { effort: "high" });
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  f.rigRepo.setNodeModel(node.id, "provider/selected"); f.rigRepo.setNodeEffortChoice(node.id, "low");
  const result = await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id);
  expect(result).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringContaining("current saved model, saved effort choice")]) });
  expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0]).toMatchObject({ model: "provider/selected", effort: "low" });
});
it("keeps an ordinary label edit during preflight without refusing the launch", async () => {
  const f = await fixture(false);
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  vi.mocked(f.tmux.probeSession).mockImplementation(async () => {
    f.db.prepare("UPDATE nodes SET label = 'Current label' WHERE id = ?").run(node.id); return { state: "absent" };
  });
  expect(await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id)).toMatchObject({ ok: true });
  expect(f.rigRepo.getRig(f.rigId)!.nodes.find(entry => entry.id === node.id)?.label).toBe("Current label");
});
it.each(["policy", "history", "rig name"])("does not launch a stale %s after an await", async control => {
  const f = await fixture(false);
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  vi.mocked(f.tmux.probeSession).mockImplementation(async () => {
    if (control === "history") f.sessionRegistry.registerSession(node.id, "dev-lead@materialized");
    if (control === "rig name") f.db.prepare("UPDATE rigs SET name = 'renamed' WHERE id = ?").run(f.rigId);
    if (control === "policy") f.rigRepo.setNodePermissionPolicy(node.id, "builtin:locked");
    return { state: "absent" };
  });
  expect(await f.podInstantiator.launchFirstMaterializedNode(f.rigId, node.id)).toMatchObject({ ok: false, code: "selection_changed" });
  expect(f.adapter.launchHarness).not.toHaveBeenCalled();
});

it("#3253: a pod seat's first start whose limit can't be applied keeps the refusal's code (422 unsupported, 409 unverified)", async () => {
  for (const [kind, status] of [["unsupported", 422], ["unverified", 409]] as const) {
    const f = await fixture(true, { process_limits: { tasks_max: 8 } });
    const problem = { kind, reason: "this host can't make the seat scope", requested: { tasksMax: 8 } };
    f.tmux.createSession = vi.fn(async () => ({ ok: false as const, code: `process_limits_${kind}`, message: "refused for its limit",
      retryable: kind === "unverified", processLimits: problem }));
    const response = await f.app.request(`/api/rigs/${f.rigId}/nodes/dev.lead/launch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await response.json();
    expect({ status: response.status, body }, JSON.stringify(body)).toMatchObject({ status,
      body: { ok: false, code: `process_limits_${kind}`, retryable: kind === "unverified", processLimits: problem } });
  }
});

// #3395, spec section 5, "Stored": the first start launches from the seat's stored settings, so it reads the stored
// pool block from the node.
it("The first start of a never-occupied model seat reports its stored pool block that can't be used once in its warnings", async () => {
  const advisory = "dev.lead pool.max: must be a whole number of 0 or more; pool not used";
  const f = await fixture(false);
  const node = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.lead")!;
  // Stored as a re-apply writes a block that can't be used: as authored.
  expect(f.rigRepo.setNodePool(node.id, { raw: { max: -1 } })).toBe(true);
  const response = await f.app.request(`/api/rigs/${f.rigId}/nodes/dev.lead/launch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await response.json() as { ok: boolean; warnings?: string[] };
  expect({ status: response.status, body }, JSON.stringify(body)).toMatchObject({ status: 201, body: { ok: true, logicalId: "dev.lead" } });
  expect(body.warnings?.filter(w => w === advisory)).toHaveLength(1);
  expect(JSON.stringify(body).split(advisory).length - 1).toBe(1);
  expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
  // A seat whose node stores no block says nothing about a pool.
  const other = f.rigRepo.getRig(f.rigId)!.nodes.find(node => node.logicalId === "dev.build")!;
  const plain = await f.podInstantiator.launchFirstMaterializedNode(f.rigId, other.id);
  expect(plain).toMatchObject({ ok: true });
  expect(JSON.stringify(plain)).not.toContain("pool not used");
});
