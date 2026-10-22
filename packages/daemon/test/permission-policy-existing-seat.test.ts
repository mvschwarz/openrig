// `rig policy apply <name> --seat <seat>`: a seat's permission_policy can change after the rig was
// instantiated. Restore, resume and launches that read the seat's stored state use its STORED
// attachment, so editing the spec alone never reached an existing seat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createTestApp, migrationsForFullTestDb, mockTmuxAdapter } from "./helpers/test-app.js";
import type { Hono } from "hono";
import type { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { validatePermissionPolicyRef } from "../src/domain/permission-policy/policy-ref.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

const fsOps = {
  readFile: (p: string) => {
    if (p.includes("agents/builder")) return agentYaml("builder");
    throw new Error(`Not found: ${p}`);
  },
  exists: (p: string) => p.includes("agents/builder"),
};

function spec(name: string, builderPolicy?: string): Record<string, unknown> {
  return {
    version: "0.2",
    name,
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "builder", agent_ref: "local:agents/builder", profile: "default", runtime: "omp", cwd: ".",
        ...(builderPolicy ? { permission_policy: builderPolicy } : {}),
      }],
      edges: [],
    }],
    edges: [],
  };
}

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "omp"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter);
}

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-existing-seat-"));
  db = createDb(join(dir, "d.sqlite"));
  migrate(db, migrationsForFullTestDb);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function materialize(setup: { podInstantiator: PodRigInstantiator; rigRepo: RigRepository }, name: string, builderPolicy?: string) {
  const outcome = await setup.podInstantiator.materializeStructured(spec(name, builderPolicy), "/project/rigs/spark");
  if (!outcome.ok) throw new Error(`materialize failed: ${JSON.stringify(outcome)}`);
  const rigId = outcome.result.rigId;
  const builder = setup.rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.builder")!;
  return { rigId, builder };
}

async function applyToSeat(setup: { app: Hono }, seat: string, body: Record<string, unknown>) {
  const res = await setup.app.request(`/api/seat/set-policy/${encodeURIComponent(seat)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "builder needs to run unattended", operator: "operator@spark", ...body }),
  });
  const json: Record<string, unknown> = await res.json();
  return { status: res.status, body: json };
}
describe("rig policy apply --seat: an existing seat's policy reaches its next restore", () => {
  it("an OMP seat created with no policy restores at full_bypass after builtin:yolo is applied to it", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    // A seat created with no policy: nothing is attached, so every launch path binds the floor.
    // (No pod: the legacy resume path is the one a test can drive without a live runtime; the pod-aware
    // path reads the same RestoreOrchestrator.resolveRestorePosture.)
    const rigId = setup.rigRepo.createRig("spark-rig").id;
    const builder = setup.rigRepo.addNode(rigId, "dev.builder", { runtime: "omp", cwd: "/w" });
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toBeNull();
    const session = setup.sessionRegistry.registerSession(builder.id, "dev-builder@spark-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'omp_session_file', resume_token = '/state/builder.jsonl' WHERE id = ?").run(session.id);
    const snap = setup.snapshotCapture.captureSnapshot(rigId, "manual");

    const applied = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "builtin:yolo" });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ ok: true, changed: true, from: null, to: "builtin:yolo", launchPosture: "full_bypass" });

    // The stored seat now carries exactly what instantiating `permission_policy: builtin:yolo` stores.
    const reference = await materialize(setup, "reference-rig", "builtin:yolo");
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toEqual(setup.rigRepo.getNodePolicyProvenance(reference.builder.id));
    // The seat's own ref (what export and `rig seat status` read) is the new one too.
    expect(setup.rigRepo.getRig(rigId)!.nodes.find((n) => n.id === builder.id)!.permissionPolicy).toBe("builtin:yolo");
    const event = db.prepare("SELECT payload FROM events WHERE type = 'node.policy_changed'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ nodeId: builder.id, from: null, to: "builtin:yolo", reason: "builder needs to run unattended", operator: "operator@spark" });

    // The next restore hands the resume adapter the new posture (OMP: --approval-mode yolo).
    const tmux = mockTmux();
    const ompResume = {
      canResume: vi.fn((type: string | null) => type === "omp_session_file"),
      resume: vi.fn(async () => ({ ok: true as const })),
    } as unknown as OmpResumeAdapter;
    const orch = new RestoreOrchestrator({
      db, rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, eventBus: setup.eventBus,
      snapshotRepo: setup.snapshotRepo, snapshotCapture: setup.snapshotCapture, checkpointStore: setup.checkpointStore,
      nodeLauncher: new NodeLauncher({ db, rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, eventBus: setup.eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
      ompResume,
    });
    await orch.restore(snap.id);
    const call = vi.mocked(ompResume.resume).mock.calls.find((c) => c[2] === "/state/builder.jsonl");
    expect(call, "the builder's resume should have been attempted").toBeDefined();
    expect(call![5]).toBe("full_bypass");
  });

  it("validates the ref exactly like a spec does and changes nothing on refusal", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    const { builder } = await materialize(setup, "spark-rig");
    setup.sessionRegistry.registerSession(builder.id, "dev-builder@spark-rig");
    for (const ref of ["yolo", "builtin:mystery", "../escape.md", ""]) {
      const applied = await applyToSeat(setup, "dev-builder@spark-rig", { ref });
      expect(applied.status).toBe(400);
      expect(applied.body).toMatchObject({ ok: false, code: "invalid_policy", message: validatePermissionPolicyRef(ref, "permission_policy") });
    }
    // A custom policy file resolves relative to the spec that declares it; a seat has no such directory.
    const custom = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "policies/operator.md" });
    expect(custom).toMatchObject({ status: 400, body: { ok: false, code: "invalid_policy" } });
    expect(String(custom.body["message"])).toContain("rig spec");
    const noReason = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "builtin:yolo", reason: " " });
    expect(noReason).toMatchObject({ status: 400, body: { ok: false, code: "missing_reason" } });
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.policy_changed'").get()).toEqual({ n: 0 });
  });

  it("refuses a terminal seat, as spec validation does", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    const rig = setup.rigRepo.createRig("term-rig");
    const terminal = setup.rigRepo.addNode(rig.id, "dev.shell", { runtime: "terminal", cwd: "/w" });
    setup.sessionRegistry.registerSession(terminal.id, "dev-shell@term-rig");
    const applied = await applyToSeat(setup, "dev-shell@term-rig", { ref: "builtin:yolo" });
    expect(applied).toMatchObject({ status: 400, body: { ok: false, code: "invalid_policy" } });
    expect(String(applied.body["message"])).toContain("not valid on terminal members");
    expect(setup.rigRepo.getNodePolicyProvenance(terminal.id)).toBeNull();
  });

  it("records `none` as the deliberate choice (not absence) and an unchanged re-apply is a no-op", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    const { builder } = await materialize(setup, "spark-rig", "builtin:yolo");
    setup.sessionRegistry.registerSession(builder.id, "dev-builder@spark-rig");
    const applied = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "none" });
    expect(applied).toMatchObject({ status: 200, body: { ok: true, changed: true, from: "builtin:yolo", to: "none", launchPosture: "floor" } });
    const reference = await materialize(setup, "reference-rig", "none");
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toEqual(setup.rigRepo.getNodePolicyProvenance(reference.builder.id));
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toMatchObject({ origin: "deliberate_none", nodeRef: "none" });

    const again = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "none" });
    expect(again).toMatchObject({ status: 200, body: { ok: true, changed: false } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.policy_changed'").get()).toEqual({ n: 1 });
  });
});

function readyAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true as const })),
  } as unknown as RuntimeAdapter;
}

// The boundary of what `--seat` stores. A launch from a spec that declares a policy re-applies the
// spec's policy (existing behaviour): it rewrites the seat's stored attachment, which later restores
// read, but not the seat's raw ref, which export reads. These pin that split as it is today; they do
// not fix it.
describe("rig policy apply --seat, then a launch from a spec that declares a policy", () => {
  it("the launch and later restores use the spec's policy, while the stored ref and export keep the --seat value", async () => {
    const adapter = readyAdapter("omp");
    const setup = createTestApp(db, { tmux: mockTmuxAdapter(), adapters: { omp: adapter }, podInstantiatorFsOps: fsOps });
    const { rigId, builder } = await materialize(setup, "spark-rig");
    const applied = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "builtin:yolo" });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    // The reported effect says so instead of promising that --seat wins every next launch.
    expect(String(applied.body["effect"])).toContain("a launch from a spec that declares a policy replaces it with the spec's policy, which later restores then use");
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toMatchObject({ origin: "builtin", launchPosture: "full_bypass", nodeRef: "builtin:yolo" });

    // Launch the same seat from a spec whose member declares `permission_policy: none` (the
    // materialized-seat launch, launchBinding, which the kernel first start also uses).
    const declared = PodRigSpecSchema.normalize(spec("spark-rig", "none"));
    const pod = declared.pods[0]!;
    const launched = await setup.podInstantiator.launchBinding({
      rigId, rigSpec: declared, rigRoot: "/project/rigs/spark", pod, member: pod.members[0]!, qualifiedId: "dev.builder", nodeId: builder.id,
    });
    expect(launched.status, JSON.stringify(launched)).toBe("launched");
    // The launch input carries the spec's policy, not the --seat one.
    expect(vi.mocked(adapter.launchHarness)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapter.launchHarness).mock.calls[0]![0]).toMatchObject({ nodeId: builder.id, launchPosture: "floor" });
    // The stored provenance is now the spec's; the stored raw ref still holds the --seat value.
    const reference = await materialize(setup, "reference-rig", "none");
    const referenceProvenance = setup.rigRepo.getNodePolicyProvenance(reference.builder.id)!;
    expect(referenceProvenance).toMatchObject({ origin: "deliberate_none", launchPosture: "floor", nodeRef: "none" });
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toEqual({ ...referenceProvenance, nodeRef: "builtin:yolo" });
    expect(setup.rigRepo.getRig(rigId)!.nodes.find((n) => n.id === builder.id)!.permissionPolicy).toBe("builtin:yolo");

    // A later restore reads the stored provenance, so it resumes with the spec's policy too.
    const session = setup.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === builder.id)!;
    db.prepare("UPDATE sessions SET resume_type = 'omp_session_file', resume_token = '/state/builder.jsonl' WHERE id = ?").run(session.id);
    const snap = setup.snapshotCapture.captureSnapshot(rigId, "manual");
    setup.sessionRegistry.updateStatus(session.id, "exited");
    await setup.restoreOrchestrator.restore(snap.id, { adapters: { omp: adapter }, fsOps: { exists: () => true } });
    const resumed = vi.mocked(adapter.launchHarness).mock.calls.find((c) => c[1]?.resumeToken === "/state/builder.jsonl");
    expect(resumed, "the restore should have resumed the builder").toBeDefined();
    expect(resumed![0]).toMatchObject({ nodeId: builder.id, launchPosture: "floor" });

    // Export reads the raw ref, so it emits the --seat value, not the policy the seat last launched with.
    const exported = setup.rigSpecExporter.exportRig(rigId) as { pods: Array<{ members: Array<{ id: string; permissionPolicy?: string }> }> };
    expect(exported.pods[0]!.members.find((m) => m.id === "builder")!.permissionPolicy).toBe("builtin:yolo");
  });

  // `rig launch --retry-startup-from <file>` compares the file's policy with the seat's stored ref,
  // so after --seat the file has to carry the new policy.
  async function failedFirstStart() {
    const root = "/fixture/spark";
    const files: Record<string, string> = {
      [root]: "",
      [`${root}/agent/agent.yaml`]: `name: builder\nversion: "1.0.0"\nresources:\n  skills:\n    - id: build\n      path: skills/build\nprofiles:\n  default:\n    uses:\n      skills: [build]\n`,
      [`${root}/agent/skills/build`]: "",
      [`${root}/agent/skills/build/SKILL.md`]: "# build",
    };
    let projectionBlocked = true;
    const adapter = readyAdapter("omp");
    vi.mocked(adapter.project).mockImplementation(async () => ({
      projected: [], skipped: [], failed: projectionBlocked ? [{ effectiveId: "build", error: "EACCES: projection ancestor" }] : [],
    }) as never);
    const tmux = mockTmuxAdapter();
    const setup = createTestApp(db, {
      tmux, adapters: { omp: adapter },
      podInstantiatorFsOps: { exists: (p) => p in files, readFile: (p) => { if (!(p in files)) throw new Error(`Missing ${p}`); return files[p]!; } },
    });
    const rig = setup.rigRepo.createRig("spark-retry");
    const seeded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "dev", label: "Dev", members: [{ id: "shell", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: root }], edges: [] } });
    expect(seeded.ok).toBe(true);
    const member = { id: "builder", agent_ref: "local:agent", profile: "default", runtime: "omp", cwd: root };
    const added = await setup.podInstantiator.addMemberToPod(rig.id, "dev", member, root);
    expect(added).toMatchObject({ ok: true, result: { node: { status: "failed", logicalId: "dev.builder" } } });
    const node = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "dev.builder")!;
    expect(adapter.launchHarness).not.toHaveBeenCalled();
    // The failed shell has exited and the seat is cleaned, as the retry requires.
    tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const clean = await new SeatLifecycleService({ ...setup, db, tmuxAdapter: tmux }).cleanSeat({ seatRef: "dev-builder@spark-retry", reason: "Projection failed before native launch; shell has exited" });
    expect(clean.ok).toBe(true);
    projectionBlocked = false;

    const applied = await applyToSeat(setup, "dev-builder@spark-retry", { ref: "builtin:yolo" });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const retry = (retryMember: Record<string, unknown>) => setup.app.request(`/api/rigs/${rig.id}/nodes/dev.builder/launch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ retryStartupFrom: { member: retryMember, rigRoot: root } }),
    });
    return { setup, adapter, node, member, retry };
  }

  it("a first-start retry whose file carries the new policy goes ahead with it", async () => {
    const f = await failedFirstStart();
    const res = await f.retry({ ...f.member, permission_policy: "builtin:yolo" });
    const body = await res.json();
    expect({ status: res.status, body }, JSON.stringify(body)).toMatchObject({ status: 201, body: { ok: true, nodeId: f.node.id, status: "launched" } });
    expect(vi.mocked(f.adapter.launchHarness)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0]).toMatchObject({ nodeId: f.node.id, launchPosture: "full_bypass" });
  });

  it("a first-start retry whose file does not carry the new policy is refused without launching", async () => {
    const f = await failedFirstStart();
    const changes = db.prepare("SELECT total_changes() AS n").get();
    const res = await f.retry(f.member);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "first_start_retry_refused", message: "Member source disagrees with the retained seat identity or policy." });
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
  });
});
