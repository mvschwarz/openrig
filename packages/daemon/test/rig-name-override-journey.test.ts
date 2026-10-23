import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { BootstrapRepository } from "../src/domain/bootstrap-repository.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// `rig up <spec> --name <rig>` driven through the real bootstrap, instantiate, snapshot and restore, with
// tmux faked as a set of live sessions, so the rig name each step used can be read back from SQLite and tmux.

function fakeTmux() {
  const live = new Set<string>();
  return {
    live,
    createSession: vi.fn(async (name: string) => { live.add(name); return { ok: true as const }; }),
    killSession: vi.fn(async (name: string) => { live.delete(name); return { ok: true as const }; }),
    probeSession: vi.fn(async (name: string) => ({ state: live.has(name) ? "present" : "absent" })),
    hasSession: vi.fn(async (name: string) => live.has(name)),
    setSessionEnv: vi.fn(async () => {}),
    unsetSessionEnv: vi.fn(async () => {}),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "zsh"),
    capturePaneContent: vi.fn(async () => "$"),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  };
}

function noopAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

const fsOps = {
  readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  exists: (p: string) => fs.existsSync(p),
  listFiles: (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
};

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function wire(db: ReturnType<typeof createDb>) {
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = fakeTmux();
  const tmuxAdapter = tmux as unknown as TmuxAdapter;
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter });
  const adapters = { terminal: noopAdapter("terminal") };
  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher,
    startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter }),
    tmuxAdapter, fsOps, adapters, exec: async () => "fixture runtime", onboardingEnabledResolver: () => false,
  } as never);
  const bootstrap = new BootstrapOrchestrator({
    db, bootstrapRepo: new BootstrapRepository(db), runtimeVerifier: { db }, installExecutor: { db },
    packageInstallService: { db }, fsOps, podInstantiator,
  } as unknown as ConstructorParameters<typeof BootstrapOrchestrator>[0]);
  return { db, rigRepo, sessionRegistry, eventBus, tmux, nodeLauncher, adapters, bootstrap };
}

const specYaml = (name: string) => [
  `version: "0.2"`,
  `name: ${name}`,
  `pods:`,
  `  - id: work`,
  `    label: Work`,
  `    members:`,
  `      - {id: worker, agent_ref: "builtin:terminal", runtime: terminal, profile: none, cwd: .}`,
  `    edges: []`,
  `edges: []`,
].join("\n") + "\n";

function fixture() {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rig-name-"));
  tmpDirs.push(root);
  const dbFile = nodePath.join(root, "openrig.sqlite");
  const db = createDb(dbFile);
  migrate(db, migrationsForFullTestDb);
  const writeSpec = (file: string, name: string) => {
    const p = nodePath.join(root, file);
    fs.writeFileSync(p, specYaml(name));
    return p;
  };
  return { ...wire(db), root, dbFile, specPath: writeSpec("rig.yaml", "solo"), writeSpec };
}

type Fixture = ReturnType<typeof fixture>;

async function up(f: Fixture, rigName?: string, sourceRef = f.specPath) {
  const result = await f.bootstrap.bootstrap({ mode: "apply", sourceRef, ...(rigName ? { rigName } : {}) });
  return result;
}

async function launched(f: Fixture, rigName?: string, sourceRef?: string): Promise<string> {
  const result = await up(f, rigName, sourceRef);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  return result.rigId!;
}

const sessionNames = (f: Fixture, rigId: string) => f.sessionRegistry.getSessionsForRig(rigId).map((s) => s.sessionName).sort();
const markRunning = (f: Fixture, rigId: string) => {
  for (const s of f.sessionRegistry.getSessionsForRig(rigId)) f.sessionRegistry.updateStatus(s.id, "running");
};
const stop = (f: Fixture, rigId: string) => {
  for (const s of f.sessionRegistry.getSessionsForRig(rigId)) {
    f.sessionRegistry.updateStatus(s.id, "exited");
    f.tmux.live.delete(s.sessionName);
  }
};

describe("rig up --name: the chosen name is the rig's identity", () => {
  it("two instances from one spec get distinct rigs and seat addresses (@alpha vs @beta)", async () => {
    const f = fixture();
    const alpha = await launched(f, "alpha");
    const beta = await launched(f, "beta");
    expect(alpha).not.toBe(beta);
    expect(f.rigRepo.getRig(alpha)!.rig.name).toBe("alpha");
    expect(f.rigRepo.getRig(beta)!.rig.name).toBe("beta");
    expect(sessionNames(f, alpha)).toEqual(["work-worker@alpha"]);
    expect(sessionNames(f, beta)).toEqual(["work-worker@beta"]);
    expect(f.rigRepo.findUnarchivedRigsByName("solo")).toEqual([]);
    // The spec file on disk is not changed.
    expect(fs.readFileSync(f.specPath, "utf-8")).toBe(specYaml("solo"));
    f.db.close();
  });

  it("an invalid name is rejected by the existing preflight validation", async () => {
    const f = fixture();
    const result = await up(f, "bad.name");
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("work.worker");
    expect(f.rigRepo.findUnarchivedRigsByName("bad.name")).toEqual([]);
    expect(f.tmux.createSession).not.toHaveBeenCalled();
    f.db.close();
  });

  it("the running-name guard keys on the chosen name", async () => {
    const f = fixture();
    const alpha = await launched(f, "alpha");
    markRunning(f, alpha);
    const again = await up(f, "alpha");
    expect(again.status).toBe("failed");
    expect(JSON.stringify(again)).toContain("rig_name_running");
    // Another name from the same spec is not blocked by the running alpha.
    await launched(f, "beta");
    f.db.close();
  });

  it("the #141 archive keys on the chosen name: a stopped alpha from another spec is replaced", async () => {
    const f = fixture();
    const other = f.writeSpec("other.yaml", "other-team");
    const oldAlpha = await launched(f, "alpha", other);
    const beta = await launched(f, "beta");
    stop(f, oldAlpha);
    stop(f, beta);
    const newAlpha = await launched(f, "alpha");
    expect(newAlpha).not.toBe(oldAlpha);
    expect(f.rigRepo.findUnarchivedRigsByName("alpha").map((r) => r.id)).toEqual([newAlpha]);
    // beta, stopped but a different name, is left alone.
    expect(f.rigRepo.findUnarchivedRigsByName("beta").map((r) => r.id)).toEqual([beta]);
    f.db.close();
  });

  it("the per-name import lock keys on the chosen name: alpha and beta from one spec launch together", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([up(f, "alpha"), up(f, "beta")]);
    expect(a.status, JSON.stringify(a)).toBe("completed");
    expect(b.status, JSON.stringify(b)).toBe("completed");
    f.db.close();
  });
});

describe("rig up --name with a fixed Compose project", () => {
  const servicesSpec = specYaml("solo").replace("pods:", "services:\n  kind: compose\n  compose_file: compose.yaml\n  project_name: shared-db\npods:");

  it("refuses a chosen name when the spec sets services.project_name, and creates nothing", async () => {
    const f = fixture();
    const specPath = nodePath.join(f.root, "services.yaml");
    fs.writeFileSync(specPath, servicesSpec);
    const result = await f.bootstrap.bootstrap({ mode: "apply", sourceRef: specPath, rigName: "alpha" });
    expect(result.status).toBe("failed");
    expect(result.stages.find((s) => s.stage === "resolve_spec")?.detail).toMatchObject({ code: "rig_name_compose_project" });
    expect(result.errors.join("\n")).toContain("shared-db");
    expect(f.rigRepo.findUnarchivedRigsByName("alpha")).toEqual([]);
    expect(f.tmux.createSession).not.toHaveBeenCalled();
    f.db.close();
  });

});

describe("rig up --name survives snapshot and restore", () => {
  it("restore by the chosen name keeps @alpha seat names and rigs.name", async () => {
    const f = fixture();
    const alpha = await launched(f, "alpha");
    await launched(f, "beta");
    markRunning(f, alpha);
    const snapshotRepo = new SnapshotRepository(f.db);
    const checkpointStore = new CheckpointStore(f.db);
    const snap = new SnapshotCapture({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus, snapshotRepo, checkpointStore })
      .captureSnapshot(alpha, "manual");
    stop(f, alpha);
    f.db.close();

    // A daemon restart: a reopened database and a fresh tmux, so only persisted state can supply the name.
    const s2 = wire(createDb(f.dbFile));
    expect(s2.rigRepo.findUnarchivedRigsByName("alpha").map((r) => r.id)).toEqual([alpha]);
    const snapshotRepo2 = new SnapshotRepository(s2.db);
    const checkpointStore2 = new CheckpointStore(s2.db);
    const orch = new RestoreOrchestrator({
      db: s2.db, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus,
      snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2,
      snapshotCapture: new SnapshotCapture({ db: s2.db, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 }),
      nodeLauncher: s2.nodeLauncher, tmuxAdapter: s2.tmux as unknown as TmuxAdapter,
      claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const restored = await orch.restore(snap.id, { adapters: s2.adapters, freshLogicalIds: ["work.worker"] } as never);
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });

    expect(s2.rigRepo.getRig(alpha)!.rig.name).toBe("alpha");
    expect(s2.tmux.createSession.mock.calls.map(([name]) => name)).toEqual(["work-worker@alpha"]);
    expect(s2.rigRepo.findUnarchivedRigsByName("beta")).toHaveLength(1);
    s2.db.close();
  });
});
