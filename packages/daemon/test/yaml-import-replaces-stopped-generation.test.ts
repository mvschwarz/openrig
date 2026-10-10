// #141 (recovery report) — `rig up <same yaml>` after the seats' tmux server died created a second, unarchived
// rig with the same name, so the guard saw two targets for every seat name. An explicit YAML import now
// archives prior same-name generations confirmed stopped, atomically with creating the replacement.
// Real PodRigInstantiator.instantiate over a fixture DB; tmux, runtime adapters and files are fakes.
import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

const RIG_ROOT = resolve("/project/rigs/my-rig");
const AGENT_FILE = resolve(RIG_ROOT, "agents/impl/agent.yaml");
const SEAT = "dev-impl@test-rig";
type Probe = (name: string) => Promise<{ state: string; cause?: string }>;

function runtimeAdapter(launchOk = true): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => (launchOk ? { ok: true } : { ok: false, error: "launch failed" })),
  } as unknown as RuntimeAdapter;
}

function setup(probe: Probe | undefined, opts: { launchOk?: boolean; attention?: boolean } = {}) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    ...(probe ? { probeSession: vi.fn(probe) } : {}),
  } as unknown as TmuxAdapter;
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  if (opts.attention) {
    startupOrchestrator.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return { ok: false, startupStatus: "attention_required", errors: ["Harness launch requires attention: trust_gate"], evidence: "waiting for workspace trust" } as never;
    };
  }
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
    startupOrchestrator,
    fsOps: {
      readFile: (p: string) => { if (p === AGENT_FILE) return 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []'; throw new Error(`Not found: ${p}`); },
      exists: (p: string) => p === AGENT_FILE,
    },
    adapters: { "claude-code": runtimeAdapter(opts.launchOk ?? true) },
    tmuxAdapter: tmux,
  } as never);
  /** The first `rig up`, then the seats' server died and reconcile marked the session detached. */
  const priorGeneration = (status: "detached" | "running" = "detached") => {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "impl", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%1" });
    if (status === "detached") sessionRegistry.updateStatus(session.id, "detached");
    return rig.id;
  };
  const yaml = RigSpecCodec.serialize({
    version: "0.2", name: "test-rig", edges: [],
    pods: [{ id: "dev", label: "Dev", edges: [], members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }] }],
  } as RigSpec);
  const archivedAt = (id: string) => (db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(id) as { archived_at: string | null } | undefined)?.archived_at;
  const rigsNamed = () => (db.prepare("SELECT id, archived_at FROM rigs WHERE name = 'test-rig' ORDER BY created_at").all() as Array<{ id: string; archived_at: string | null }>);
  return { db, rigRepo, inst, tmux, priorGeneration, yaml, archivedAt, rigsNamed };
}

describe("#141 explicit YAML import over a stopped same-name generation", () => {
  it.each([
    ["positive session absence", async () => ({ state: "absent" })],
    ["tmux reports no server running on the daemon's socket", async () => ({ state: "transport_unavailable", cause: "no server running on /tmp/tmux-501/default" })],
  ] as Array<[string, Probe]>)("archives the prior generation when %s, and the new seat resolves", async (_label, probe) => {
    const f = setup(probe);
    const oldId = f.priorGeneration();
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    const newId = result.ok ? result.result.rigId : "";
    expect(f.archivedAt(oldId)).not.toBeNull();
    expect(f.archivedAt(newId)).toBeNull();
    expect(f.rigRepo.getRig(oldId)!.nodes).toHaveLength(1); // old records kept, addressable by ID
    expect(resolveGuardTarget(f.db, SEAT)).toMatchObject({ nodeId: f.rigRepo.getRig(newId)!.nodes[0]!.id });
    expect(result.ok && result.result.warnings?.join("\n")).toContain(`rig unarchive ${oldId}`);
    f.db.close();
  });

  it.each([
    ["its tmux session still exists", async () => ({ state: "present" })],
    ["another tmux transport error", async () => ({ state: "transport_unavailable", cause: "error connecting to /tmp/tmux-501/default (Permission denied)" })],
    ["the probe throws", async () => { throw new Error("timed out"); }],
  ] as Array<[string, Probe]>)("keeps the prior generation and creates nothing when %s", async (_label, probe) => {
    const f = setup(probe);
    const oldId = f.priorGeneration();
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result).toMatchObject({ ok: false, code: "generation_unconfirmed" });
    expect(!result.ok && "message" in result && result.message).toContain(oldId);
    expect(f.rigsNamed()).toEqual([{ id: oldId, archived_at: null }]);
    f.db.close();
  });

  it("rolls the archive back when creating the replacement fails", async () => {
    const f = setup(async () => ({ state: "absent" }));
    const oldId = f.priorGeneration();
    vi.spyOn(f.rigRepo, "createRig").mockImplementation(() => { throw new Error("disk full"); });
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result).toMatchObject({ ok: false, code: "instantiate_error" });
    expect(f.rigsNamed()).toEqual([{ id: oldId, archived_at: null }]);
    f.db.close();
  });

  it("restores the prior generation when a service hook refuses the replacement", async () => {
    const f = setup(async () => ({ state: "absent" }));
    const oldId = f.priorGeneration();
    const historical = f.rigRepo.createRig("test-rig");
    f.rigRepo.archiveRig(historical.id);
    const hook = vi.fn(async (_rigId: string, replacedRigIds: readonly string[]) => {
      expect(replacedRigIds).toEqual([oldId]);
      expect(f.db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(oldId)).toMatchObject({ archived_at: expect.any(String) });
      return { ok: false as const, code: "svc", message: "service failed" };
    });
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT, { prelaunchHook: hook });

    expect(result).toMatchObject({ ok: false, code: "service_boot_failed" });
    expect(hook).toHaveBeenCalledOnce();
    expect(f.rigsNamed().find(rig => rig.id === oldId)).toEqual({ id: oldId, archived_at: null });
    f.db.close();
  });

  it("restores the prior generation when every replacement node fails and the replacement is removed", async () => {
    const f = setup(async () => ({ state: "absent" }), { launchOk: false });
    const oldId = f.priorGeneration();
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result).toMatchObject({ ok: false, code: "instantiate_error" });
    expect(f.rigsNamed()).toEqual([{ id: oldId, archived_at: null }]);
    f.db.close();
  });

  it("when every replacement seat needs attention, the replacement is kept and the archive notice still reaches the user", async () => {
    const f = setup(async () => ({ state: "absent" }), { attention: true });
    const oldId = f.priorGeneration();
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result).toMatchObject({ ok: false, code: "attention_required" });
    expect(f.archivedAt(oldId)).not.toBeNull();
    expect(!result.ok && "warnings" in result ? (result.warnings ?? []).join("\n") : "").toContain(`rig unarchive ${oldId}`);
    f.db.close();
  });

  it("control: a running prior generation is still refused by the running-name guard", async () => {
    const f = setup(async () => ({ state: "absent" }));
    const oldId = f.priorGeneration("running");
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result).toMatchObject({ ok: false, code: "rig_name_running" });
    expect(f.rigsNamed()).toEqual([{ id: oldId, archived_at: null }]);
    f.db.close();
  });

  it("control: with no prior same-name rig nothing is archived and no probe runs", async () => {
    const f = setup(async () => ({ state: "absent" }));
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    expect(result.ok && (result.result.warnings ?? []).some((w) => w.includes("Archived"))).toBe(false);
    expect((f.tmux as unknown as { probeSession: ReturnType<typeof vi.fn> }).probeSession).not.toHaveBeenCalled();
    f.db.close();
  });

  it("control: an adapter that cannot probe keeps today's behavior", async () => {
    const f = setup(undefined);
    const oldId = f.priorGeneration();
    const result = await f.inst.instantiate(f.yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    expect(f.rigsNamed().map((r) => r.archived_at)).toEqual([null, null]);
    expect(f.rigsNamed()[0]!.id).toBe(oldId);
    f.db.close();
  });
});

describe("#141 P1 correction: concurrent same-name imports", () => {
  function gate() { let release!: () => void; const wait = new Promise<void>((r) => { release = r; }); return { wait, release }; }

  it("while one import awaits its stopped-generation probe, a same-name import is refused; one replacement results", async () => {
    const g = gate(); let calls = 0;
    const f = setup(async () => { calls++; if (calls === 1) await g.wait; return { state: "absent" }; });
    const oldId = f.priorGeneration();
    const first = f.inst.instantiate(f.yaml, RIG_ROOT);
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await f.inst.instantiate(f.yaml, RIG_ROOT);
    g.release();
    const firstResult = await first;

    expect(firstResult.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "generation_unconfirmed" });
    expect(f.rigsNamed().filter((r) => r.archived_at === null)).toHaveLength(1);
    expect(f.archivedAt(oldId)).not.toBeNull();
    f.db.close();
  });

  it("while one import's replacement waits in its prelaunch hook, a same-name import neither archives it nor adds another", async () => {
    const g = gate(); let hookEntered = false;
    const f = setup(async () => ({ state: "absent" }));
    const oldId = f.priorGeneration();
    const first = f.inst.instantiate(f.yaml, RIG_ROOT, { prelaunchHook: async () => { hookEntered = true; await g.wait; return { ok: true }; } });
    await vi.waitFor(() => expect(hookEntered).toBe(true));
    const second = await f.inst.instantiate(f.yaml, RIG_ROOT);
    g.release();
    const firstResult = await first;

    expect(firstResult.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "generation_unconfirmed" });
    expect(f.rigsNamed().filter((r) => r.archived_at === null)).toEqual([{ id: firstResult.ok ? firstResult.result.rigId : "", archived_at: null }]);
    expect(f.archivedAt(oldId)).not.toBeNull();
    f.db.close();
  });

  it("rollback restores only archives this import made (another actor archived the old rig meanwhile)", async () => {
    const g = gate(); let calls = 0;
    const f = setup(async () => { calls++; await g.wait; return { state: "absent" }; });
    const oldId = f.priorGeneration();
    const first = f.inst.instantiate(f.yaml, RIG_ROOT, { prelaunchHook: async () => ({ ok: false, code: "svc", message: "service failed" }) });
    await vi.waitFor(() => expect(calls).toBe(1));
    f.rigRepo.archiveRig(oldId);
    g.release();
    const result = await first;

    expect(result.ok).toBe(false);
    expect(f.archivedAt(oldId)).not.toBeNull();
    f.db.close();
  });

  it("an import of an unrelated name proceeds while another import is in flight", async () => {
    const g = gate(); let calls = 0;
    const f = setup(async () => { calls++; if (calls === 1) await g.wait; return { state: "absent" }; });
    f.priorGeneration();
    const first = f.inst.instantiate(f.yaml, RIG_ROOT);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(f.yaml).toContain("name: test-rig");
    const other = await f.inst.instantiate(f.yaml.replace("name: test-rig", "name: other-rig"), RIG_ROOT);
    g.release();

    expect(other.ok).toBe(true);
    expect((await first).ok).toBe(true);
    f.db.close();
  });
});
