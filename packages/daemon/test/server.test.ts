import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { RigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { InstallEngine } from "../src/domain/install-engine.js";
import { InstallVerifier } from "../src/domain/install-verifier.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodBundleSourceResolver } from "../src/domain/bundle-source-resolver.js";
import { createApp } from "../src/server.js";
import { mockTmuxAdapter, unavailableCmuxAdapter } from "./helpers/test-app.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

function buildFullDeps(db: ReturnType<typeof createFullTestDb>, overrides?: { snapshotRepo?: SnapshotRepository; snapshotCapture?: SnapshotCapture; restoreOrchestrator?: RestoreOrchestrator }) {
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmuxAdapter();
  const cmux = unavailableCmuxAdapter();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const snapshotRepo = overrides?.snapshotRepo ?? new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = overrides?.snapshotCapture ?? new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const claudeResume = new ClaudeResumeAdapter(tmux);
  const codexResume = new CodexResumeAdapter(tmux);
  const restoreOrchestrator = overrides?.restoreOrchestrator ?? new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume, codexResume,
  });
  const exec: ExecFn = async () => "";
  const podRepo = new PodRepository(db);
  const rigSpecExporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });
  const rigSpecPreflight = new RigSpecPreflight({ rigRepo, tmuxAdapter: tmux, exec, cmuxExec: exec });
  const rigInstantiator = new RigInstantiator({ db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight: rigSpecPreflight });

  const packageRepo = new PackageRepository(db);
  const installRepo = new InstallRepository(db);
  const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) };
  const engineFsOps = {
    ...fsOps,
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
    deleteFile: (p: string) => fs.unlinkSync(p),
  };
  const installEngine = new InstallEngine(installRepo, engineFsOps);
  const installVerifier = new InstallVerifier(installRepo, packageRepo, fsOps);

  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const mockAdapter = {
    runtime: "claude-code",
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    checkReady: async () => ({ ready: true }),
  };
  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
    startupOrchestrator,
    fsOps: { readFile: () => "", exists: () => false },
    adapters: { "claude-code": mockAdapter, "codex": { ...mockAdapter, runtime: "codex" } },
  });

  return {
    rigRepo, sessionRegistry, eventBus, nodeLauncher, tmuxAdapter: tmux, cmuxAdapter: cmux,
    snapshotCapture, snapshotRepo, restoreOrchestrator,
    rigSpecExporter, rigSpecPreflight, rigInstantiator,
    packageRepo, installRepo, installEngine, installVerifier,
    podInstantiator, podBundleSourceResolver: new PodBundleSourceResolver(),
  };
}

function createTempUiDist() {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-ui-dist-"));
  fs.mkdirSync(nodePath.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "index.html"), "<!doctype html><html><body><div id=\"root\">OpenRig UI</div></body></html>", "utf-8");
  fs.writeFileSync(nodePath.join(dir, "assets", "app.js"), "console.log('rig');", "utf-8");
  return dir;
}

function createAppWithUiDist(db: ReturnType<typeof createFullTestDb>, uiDistDir: string) {
  const fullSetup = createTestApp(db);
  return createApp({
    rigRepo: fullSetup.rigRepo,
    sessionRegistry: fullSetup.sessionRegistry,
    eventBus: fullSetup.eventBus,
    nodeLauncher: fullSetup.nodeLauncher,
    tmuxAdapter: (fullSetup as any).tmuxAdapter ?? mockTmuxAdapter(),
    cmuxAdapter: (fullSetup as any).cmuxAdapter ?? unavailableCmuxAdapter(),
    snapshotCapture: fullSetup.snapshotCapture,
    snapshotRepo: fullSetup.snapshotRepo,
    restoreOrchestrator: fullSetup.restoreOrchestrator,
    rigSpecExporter: fullSetup.rigSpecExporter,
    rigSpecPreflight: fullSetup.rigSpecPreflight,
    rigInstantiator: fullSetup.rigInstantiator,
    packageRepo: fullSetup.packageRepo,
    installRepo: fullSetup.installRepo,
    installEngine: fullSetup.installEngine,
    installVerifier: fullSetup.installVerifier,
    bootstrapOrchestrator: fullSetup.bootstrapOrchestrator,
    bootstrapRepo: fullSetup.bootstrapRepo,
    discoveryCoordinator: fullSetup.discoveryCoordinator,
    discoveryRepo: fullSetup.discoveryRepo,
    claimService: fullSetup.claimService,
    psProjectionService: fullSetup.psProjectionService,
    upRouter: fullSetup.upRouter,
    teardownOrchestrator: fullSetup.teardownOrchestrator,
    podInstantiator: fullSetup.podInstantiator,
    podBundleSourceResolver: fullSetup.podBundleSourceResolver,
    uiDistDir,
  });
}

describe("Hono server (production app)", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
    db.close();
  });

  it("GET /api/unknown still returns 404", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/api/unknown");
    expect(res.status).toBe(404);
    db.close();
  });

  it("serves index.html for root and SPA deep links when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    const app = createAppWithUiDist(db, uiDistDir);

    const rootRes = await app.request("/");
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    expect(await rootRes.text()).toContain("OpenRig UI");

    const deepLinkRes = await app.request("/specs");
    expect(deepLinkRes.status).toBe(200);
    expect(deepLinkRes.headers.get("content-type")).toContain("text/html");
    expect(await deepLinkRes.text()).toContain("OpenRig UI");

    fs.rmSync(uiDistDir, { recursive: true, force: true });
    db.close();
  });

  it("serves built assets directly when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    const app = createAppWithUiDist(db, uiDistDir);

    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("console.log('rig');");

    fs.rmSync(uiDistDir, { recursive: true, force: true });
    db.close();
  });

  it("production app mounts /api/rigs (not healthz-only)", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/api/rigs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    db.close();
  });

  it("createApp throws if rigRepo and eventBus use different db handles", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    const deps = buildFullDeps(db1);
    deps.eventBus = new EventBus(db2);

    expect(() => createApp(deps)).toThrow(/same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if snapshotRepo uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    // Build valid deps on db1, then swap snapshotRepo to db2
    const deps = buildFullDeps(db1);
    (deps as Record<string, unknown>).snapshotRepo = new SnapshotRepository(db2);

    expect(() => createApp(deps)).toThrow(/snapshotRepo.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if snapshotCapture uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    // Build a self-consistent snapshotCapture on db2
    const r2 = new RigRepository(db2);
    const s2 = new SessionRegistry(db2);
    const e2 = new EventBus(db2);
    const sr2 = new SnapshotRepository(db2);
    const cs2 = new CheckpointStore(db2);
    const otherCapture = new SnapshotCapture({ db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2, snapshotRepo: sr2, checkpointStore: cs2 });

    // Build valid deps on db1, then swap snapshotCapture to db2
    const deps = buildFullDeps(db1);
    (deps as Record<string, unknown>).snapshotCapture = otherCapture;

    expect(() => createApp(deps)).toThrow(/snapshotCapture.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if restoreOrchestrator uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    // Build a self-consistent orchestrator on db2
    const r2 = new RigRepository(db2);
    const s2 = new SessionRegistry(db2);
    const e2 = new EventBus(db2);
    const sr2 = new SnapshotRepository(db2);
    const cs2 = new CheckpointStore(db2);
    const cap2 = new SnapshotCapture({ db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2, snapshotRepo: sr2, checkpointStore: cs2 });
    const tmux2 = mockTmuxAdapter();
    const nl2 = new NodeLauncher({ db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2, tmuxAdapter: tmux2 });
    const otherOrch = new RestoreOrchestrator({
      db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2,
      snapshotRepo: sr2, snapshotCapture: cap2, checkpointStore: cs2,
      nodeLauncher: nl2, tmuxAdapter: tmux2,
      claudeResume: new ClaudeResumeAdapter(tmux2), codexResume: new CodexResumeAdapter(tmux2),
    });

    // Build valid deps on db1, then swap restoreOrchestrator to db2
    const deps = buildFullDeps(db1);
    (deps as Record<string, unknown>).restoreOrchestrator = otherOrch;

    expect(() => createApp(deps)).toThrow(/restoreOrchestrator.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if packageRepo uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    const deps = buildFullDeps(db1);
    (deps as Record<string, unknown>).packageRepo = new PackageRepository(db2);

    expect(() => createApp(deps)).toThrow(/packageRepo.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if installRepo uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    const deps = buildFullDeps(db1);
    (deps as Record<string, unknown>).installRepo = new InstallRepository(db2);

    expect(() => createApp(deps)).toThrow(/installRepo.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if podInstantiator uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    const fullSetup = createTestApp(db1);
    const deps = {
      rigRepo: fullSetup.rigRepo,
      sessionRegistry: fullSetup.sessionRegistry,
      eventBus: fullSetup.eventBus,
      nodeLauncher: fullSetup.nodeLauncher,
      tmuxAdapter: (fullSetup as any).tmuxAdapter ?? mockTmuxAdapter(),
      cmuxAdapter: (fullSetup as any).cmuxAdapter ?? unavailableCmuxAdapter(),
      snapshotCapture: fullSetup.snapshotCapture,
      snapshotRepo: fullSetup.snapshotRepo,
      restoreOrchestrator: fullSetup.restoreOrchestrator,
      rigSpecExporter: fullSetup.rigSpecExporter,
      rigSpecPreflight: fullSetup.rigSpecPreflight,
      rigInstantiator: fullSetup.rigInstantiator,
      packageRepo: fullSetup.packageRepo,
      installRepo: fullSetup.installRepo,
      installEngine: fullSetup.installEngine,
      installVerifier: fullSetup.installVerifier,
      bootstrapOrchestrator: fullSetup.bootstrapOrchestrator,
      bootstrapRepo: fullSetup.bootstrapRepo,
      discoveryCoordinator: fullSetup.discoveryCoordinator,
      discoveryRepo: fullSetup.discoveryRepo,
      claimService: fullSetup.claimService,
      psProjectionService: fullSetup.psProjectionService,
      upRouter: fullSetup.upRouter,
      teardownOrchestrator: fullSetup.teardownOrchestrator,
      podInstantiator: { db: db2 } as any,
      podBundleSourceResolver: null,
    };

    expect(() => createApp(deps)).toThrow(/podInstantiator.*same db handle/);

    db1.close();
    db2.close();
  });
});
