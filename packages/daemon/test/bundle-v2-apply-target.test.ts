// v2 (pod-aware) .rigbundle apply: the launch root must outlive the extraction.
//
// Goes through the real BootstrapOrchestrator + real PodBundleSourceResolver
// with real temp-filesystem effects. Only the launch itself (PodRigInstantiator)
// is faked: it records the rigRoot / cwdOverride it was handed and resolves the
// member cwd with the real resolveLaunchCwd, exactly as the real instantiator does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { BootstrapRepository } from "../src/domain/bootstrap-repository.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import { RequirementsProbeRegistry } from "../src/domain/requirements-probe.js";
import { ExternalInstallPlanner } from "../src/domain/external-install-planner.js";
import { ExternalInstallExecutor } from "../src/domain/external-install-executor.js";
import { PackageInstallService } from "../src/domain/package-install-service.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { InstallEngine } from "../src/domain/install-engine.js";
import { InstallVerifier } from "../src/domain/install-verifier.js";
import { PodBundleSourceResolver, LegacyBundleSourceResolver } from "../src/domain/bundle-source-resolver.js";
import { pack } from "../src/domain/bundle-archive.js";
import { computeIntegrity } from "../src/domain/bundle-integrity.js";
import { resolveLaunchCwd } from "../src/domain/cwd-resolution.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import * as preflight from "../src/domain/rigspec-preflight.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { FsOps } from "../src/domain/package-resolver.js";
import { createTestApp } from "./helpers/test-app.js";

const RIG_YAML = `
version: "0.2"
name: lifetime-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();

const AGENT_YAML = `name: impl\nversion: "1.0"\n`;

const noExec = vi.fn(async () => { throw new Error("no native exec in this test"); }) as unknown as ExecFn;

function walk(dir: string): string[] {
  const out: string[] = [];
  (function w(d: string, pre: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) w(path.join(d, e.name), rel); else out.push(rel);
    }
  })(dir, "");
  return out;
}

function realFsOps(): FsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: (d) => walk(d),
  } as FsOps;
}

async function buildV2Bundle(workDir: string, services = false, options: { terminal?: boolean; projectName?: string } = {}): Promise<string> {
  const staging = path.join(workDir, "staging");
  fs.mkdirSync(path.join(staging, "agents", "impl"), { recursive: true });
  const rigYaml = options.terminal ? RIG_YAML.replace('"local:agents/impl"', 'builtin:terminal').replace('profile: default', 'profile: none').replace('runtime: claude-code', 'runtime: terminal') : RIG_YAML;
  fs.writeFileSync(path.join(staging, "rig.yaml"), rigYaml + (services ? "\nservices:\n  kind: compose\n  compose_file: compose.yaml\n  down_policy: down\n" + (options.projectName ? `  project_name: ${options.projectName}\n` : "") : ""));
  if (services) fs.writeFileSync(path.join(staging, "compose.yaml"), "services:\n  demo:\n    image: example/demo:1\n");
  fs.writeFileSync(path.join(staging, "agents", "impl", "agent.yaml"), AGENT_YAML);
  const integrity = computeIntegrity(staging, {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p: string) => fs.readFileSync(p),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    walkFiles: (d: string) => walk(d),
  } as never);
  const integrityYaml = `  algorithm: ${integrity.algorithm}\n  files:\n` +
    Object.entries(integrity.files).map(([k, v]) => `    ${k}: ${v}`).join("\n");
  fs.writeFileSync(path.join(staging, "bundle.yaml"), `schema_version: 2
name: lifetime
version: "0.1.0"
created_at: "2026-09-29T00:00:00Z"
rig_spec: rig.yaml
agents:
  - name: impl
    version: "1.0"
    path: agents/impl
    original_ref: "local:agents/impl"
    hash: "${"0".repeat(64)}"
    import_entries: []
integrity:
${integrityYaml}
`);
  const bundlePath = path.join(workDir, "lifetime.rigbundle");
  await pack(staging, bundlePath);
  return bundlePath;
}

interface LaunchRecord { rigRoot: string; cwd: string; agentYaml: string; agentYamlExistedAtLaunch: boolean }

describe("v2 bundle apply: launch root lifetime and --target", () => {
  let db: Database.Database;
  let workDir: string;
  let bundlePath: string;
  let launches: LaunchRecord[];
  let podInstantiator: { db: Database.Database; instantiate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-lifetime-"));
    bundlePath = await buildV2Bundle(workDir);
    launches = [];
    podInstantiator = {
      db,
      instantiate: vi.fn(async (_yaml: string, rigRoot: string, opts?: { cwdOverride?: string }) => {
        const agentYaml = path.join(rigRoot, "agents", "impl", "agent.yaml");
        launches.push({
          rigRoot,
          cwd: resolveLaunchCwd(".", rigRoot, opts?.cwdOverride),
          agentYaml,
          agentYamlExistedAtLaunch: fs.existsSync(agentYaml),
        });
        return { ok: true as const, result: { rigId: "rig-1", specName: "lifetime-rig", specVersion: "0.2", nodes: [{ logicalId: "dev.impl", status: "launched" as const }] } };
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function orchestrator(extra: Partial<ConstructorParameters<typeof BootstrapOrchestrator>[0]> = {}): BootstrapOrchestrator {
    return new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: noExec, db }),
      probeRegistry: new RequirementsProbeRegistry(noExec),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: noExec, db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), {
          readFile: (p: string) => fs.readFileSync(p, "utf-8"),
          writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
          exists: (p: string) => fs.existsSync(p),
          mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
          copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
          deleteFile: (p: string) => fs.unlinkSync(p),
        }),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: { db, instantiate: vi.fn() } as never,
      fsOps: realFsOps(),
      bundleSourceResolver: new LegacyBundleSourceResolver({ fsOps: realFsOps() }),
      podBundleSourceResolver: new PodBundleSourceResolver(),
      podInstantiator: podInstantiator as never,
      ...extra,
    });
  }

  it("apply with targetRoot launches from the target, and the cwd + agent refs survive extraction cleanup", async () => {
    const target = path.join(workDir, "project");
    fs.mkdirSync(target);

    const result = await orchestrator().bootstrap({ mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: target });

    expect(result.status).toBe("completed");
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    console.log(`[lifetime] targetRoot=${target}`);
    console.log(`[lifetime] rigRoot handed to instantiate=${launch.rigRoot}`);
    console.log(`[lifetime] resolved member cwd (cwd: ".")=${launch.cwd} exists-after-bootstrap=${fs.existsSync(launch.cwd)}`);
    console.log(`[lifetime] agent.yaml ${launch.agentYaml} existed-at-launch=${launch.agentYamlExistedAtLaunch} exists-after-bootstrap=${fs.existsSync(launch.agentYaml)}`);

    expect(launch.agentYamlExistedAtLaunch).toBe(true);
    // --target is honored: the launch root is the target, not a temp extraction dir
    expect(fs.realpathSync(launch.rigRoot)).toBe(fs.realpathSync(target));
    // Lifetime: after bootstrap returned (extraction cleaned up), everything the rig points at still exists
    expect(fs.existsSync(launch.cwd)).toBe(true);
    expect(fs.existsSync(launch.agentYaml)).toBe(true);
    expect(fs.readFileSync(path.join(target, "rig.yaml"), "utf-8")).toBe(RIG_YAML);
    expect(fs.existsSync(path.join(target, "bundle.yaml"))).toBe(true);
  });

  it("re-applying the same bundle into the same target is allowed (identical content)", async () => {
    const target = path.join(workDir, "project");
    const first = await orchestrator().bootstrap({ mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: target });
    expect(first.status).toBe("completed");
    const second = await orchestrator().bootstrap({ mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: target });
    expect(second.status).toBe("completed");
    expect(fs.existsSync(path.join(target, "agents", "impl", "agent.yaml"))).toBe(true);
  });

  it("refuses a target holding different content at a bundle path, writes nothing, and does not launch", async () => {
    const target = path.join(workDir, "project");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "rig.yaml"), "name: someone-elses-rig\n");

    const result = await orchestrator().bootstrap({ mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: target });

    expect(result.status).toBe("failed");
    expect(result.errors.join("\n")).toMatch(/rig\.yaml/);
    expect(podInstantiator.instantiate).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(target, "rig.yaml"), "utf-8")).toBe("name: someone-elses-rig\n");
    expect(fs.existsSync(path.join(target, "agents"))).toBe(false);
    expect(fs.existsSync(path.join(target, "bundle.yaml"))).toBe(false);
  });

  it("control: explicit cwdOverride still wins for the launch cwd", async () => {
    const target = path.join(workDir, "project");
    const explicit = path.join(workDir, "explicit-cwd");
    fs.mkdirSync(explicit);

    const result = await orchestrator().bootstrap({ mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: target, cwdOverride: explicit });

    expect(result.status).toBe("completed");
    expect(launches[0]!.cwd).toBe(explicit);
    expect(fs.existsSync(launches[0]!.cwd)).toBe(true);
  });

  it.each(["plan", "apply"] as const)("keeps services_unsupported with the switch off in %s", async mode => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "false");
    const result = await orchestrator().bootstrap({ mode, sourceKind: "rig_bundle", sourceRef: await buildV2Bundle(workDir, true), targetRoot: path.join(workDir, "target") });
    expect(result.stages).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ code: "services_unsupported" }) }));
    expect(podInstantiator.instantiate).not.toHaveBeenCalled();
  });

  it.each(["plan", "apply"] as const)("keeps services_unsupported without a lasting target in %s", async mode => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "true");
    const result = await orchestrator().bootstrap({ mode, sourceKind: "rig_bundle", sourceRef: await buildV2Bundle(workDir, true) });
    expect(result.stages).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ code: "services_unsupported" }) }));
    expect(podInstantiator.instantiate).not.toHaveBeenCalled();
  });

  it("boots the services using the materialised target before the first seat", async () => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "true");
    const target = path.join(workDir, "target"), repo = new RigRepository(db);
    const order: string[] = [];
    const boot = vi.fn(async (rigId: string) => {
      const record = repo.getServicesRecord(rigId)!;
      expect(fs.realpathSync(record.rigRoot)).toBe(fs.realpathSync(target));
      expect(record.composeFile).toBe(path.join(target, "compose.yaml"));
      expect(fs.existsSync(record.composeFile)).toBe(true);
      order.push("boot");
      return { ok: true, health: "healthy", receipt: {} };
    });
    const route = vi.fn(async () => { order.push("route"); return {}; });
    podInstantiator.instantiate.mockImplementation(async (_yaml: string, rigRoot: string, opts: { prelaunchHook: (rigId: string) => Promise<{ ok: boolean }> }) => {
      const rig = repo.createRig("lifetime-rig");
      expect((await opts.prelaunchHook(rig.id)).ok).toBe(true);
      order.push("seat");
      return { ok: true, result: { rigId: rig.id, specName: "lifetime-rig", nodes: [{ logicalId: "dev.impl", status: "launched" }] } };
    });
    const result = await orchestrator({ rigRepo: repo, serviceOrchestrator: { boot } as never, routeBundleContents: route }).bootstrap({
      mode: "apply", sourceKind: "rig_bundle", sourceRef: await buildV2Bundle(workDir, true), targetRoot: target,
    });
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(order).toEqual(["boot", "route", "seat"]);
    expect(fs.existsSync(path.join(target, "compose.yaml"))).toBe(true);
  });

  it.each(["rollback", "cleanup-failure", "inherited", "inherited-boot-failure", "ambiguous", "explicit"])(
    "preserves the composed archive service lifecycle (%s)", async scenario => {
      vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "true");
      vi.spyOn(preflight, "rigPreflight").mockResolvedValue({ ready: true, errors: [], warnings: [] } as never);
      const repo = new RigRepository(db), order: string[] = [], commands: string[] = [];
      const inherited = ["inherited", "inherited-boot-failure", "ambiguous", "explicit"].includes(scenario);
      const store = (id: string, projectName: string) => repo.setServicesRecord(id, {
        kind: "compose", specJson: "{}", rigRoot: workDir, composeFile: "compose.yaml", projectName,
      });
      const historical = repo.createRig("lifetime-rig"); store(historical.id, "unrelated-history"); repo.archiveRig(historical.id);
      const predecessors: string[] = [];
      if (inherited) {
        const previous = repo.createRig("lifetime-rig"); store(previous.id, "exact-predecessor"); predecessors.push(previous.id);
        if (scenario === "ambiguous") {
          const other = repo.createRig("lifetime-rig"); store(other.id, "second-project"); predecessors.push(other.id);
        }
      }
      let currentId: string | undefined;
      const composeAdapter = new ComposeServicesAdapter(async command => {
        commands.push(command);
        if (command.includes("up -d")) order.push("up");
        if (command.includes("ps --format json") && scenario === "inherited-boot-failure") throw new Error("test status failure after up");
        if (command.includes("down")) {
          order.push("down");
          expect(repo.getServicesRecord(currentId!)).not.toBeNull();
          if (scenario === "cleanup-failure") throw new Error("test cleanup unavailable");
        }
        return "";
      });
      const serviceOrchestrator = new ServiceOrchestrator({ rigRepo: repo, composeAdapter });
      const boot = serviceOrchestrator.boot.bind(serviceOrchestrator);
      vi.spyOn(serviceOrchestrator, "boot").mockImplementation(async id => { currentId = id; return boot(id); });
      const remove = repo.deleteRig.bind(repo);
      vi.spyOn(repo, "deleteRig").mockImplementation(id => { order.push("delete"); return remove(id); });
      const nodeLauncher = { db, launchNode: vi.fn(async () => {
        order.push("seat"); return { ok: false, code: "launch_failed", message: "test terminal launch failure" };
      }) };
      const actualInstantiator = new PodRigInstantiator({
        db, rigRepo: repo, podRepo: new PodRepository(db), sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
        nodeLauncher, startupOrchestrator: { db }, adapters: {}, fsOps: realFsOps(),
        tmuxAdapter: { probeSession: vi.fn(async () => ({ state: "absent" })) },
      } as never);
      const route = vi.fn(async () => { order.push("route"); throw new Error("test routing warning"); });
      const target = path.join(workDir, "lifecycle-target");
      const result = await orchestrator({ rigRepo: repo, podInstantiator: actualInstantiator, serviceOrchestrator, routeBundleContents: route }).bootstrap({
        mode: "apply", sourceKind: "rig_bundle", targetRoot: target,
        sourceRef: await buildV2Bundle(workDir, true, { terminal: true, projectName: scenario === "explicit" ? "requested-project" : undefined }),
      });
      expect(result.status, JSON.stringify(result)).toBe("failed");
      if (scenario === "ambiguous") {
        expect(commands).toEqual([]);
        expect(result.errors.join(" ")).toContain("multiple predecessor Compose projects");
        for (const id of predecessors) expect(result.errors.join(" ")).toContain(id);
        expect(route).not.toHaveBeenCalled();
      } else {
        const expectedProject = scenario === "explicit" ? "requested-project" : inherited ? "exact-predecessor" : repo.getServicesRecord(currentId!)?.projectName;
        if (inherited) expect(commands.some(command => command.includes(`-p '${expectedProject}'`) && command.includes("up -d"))).toBe(true);
        const shouldRollback = !inherited || scenario === "explicit";
        expect(commands.filter(command => command.includes("down"))).toHaveLength(shouldRollback ? 1 : 0);
        expect(commands.filter(command => command.includes("down")).every(command => !command.includes("--volumes"))).toBe(true);
        if (scenario === "cleanup-failure") {
          expect(repo.getRig(currentId!)).not.toBeNull();
          expect(repo.getServicesRecord(currentId!)).not.toBeNull();
          expect(result.errors.join(" ")).toContain("retained for recovery");
          expect(order).not.toContain("delete");
        } else {
          expect(repo.getRig(currentId!)).toBeNull();
          if (shouldRollback) expect(order.indexOf("down")).toBeLessThan(order.indexOf("delete"));
        }
        if (scenario !== "inherited-boot-failure") {
          expect(order.indexOf("route")).toBeLessThan(order.indexOf("seat"));
          expect(result.warnings.join(" ")).toContain("test routing warning");
        }
      }
      const remaining = repo.findUnarchivedRigsByName("lifetime-rig").map(record => record.id);
      expect(remaining).not.toContain(historical.id);
      if (scenario !== "cleanup-failure") expect(remaining.sort()).toEqual(predecessors.sort());
    },
  );

  it("plans the target services and view without materialising or launching", async () => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "true");
    const target = path.join(workDir, "planned-target");
    Object.assign(podInstantiator, { deps: { fsOps: realFsOps() } });
    vi.spyOn(preflight, "rigPreflight").mockResolvedValue({ ready: true, errors: [], warnings: [] } as never);
    const result = await orchestrator().bootstrap({ mode: "plan", sourceKind: "rig_bundle", sourceRef: await buildV2Bundle(workDir, true), targetRoot: target });
    expect(result.status).toBe("planned");
    expect(result.stages).toContainEqual(expect.objectContaining({ stage: "services_plan", detail: expect.objectContaining({ targetRoot: target, materialised: false, services: [expect.objectContaining({ name: "demo", image: "example/demo:1" })] }) }));
    expect(fs.existsSync(target)).toBe(false);
    expect(podInstantiator.instantiate).not.toHaveBeenCalled();
  });

  it("previews a target-bound service install through the bundle install route without writing or launching", async () => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "true");
    const target = path.join(workDir, "route-plan-target");
    const { app, podInstantiator: installer } = createTestApp(db, { podInstantiatorFsOps: realFsOps() });
    const launch = vi.spyOn(installer, "instantiate");
    vi.spyOn(preflight, "rigPreflight").mockResolvedValue({ ready: true, errors: [], warnings: [] } as never);
    const response = await app.request("/api/bundles/install", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: await buildV2Bundle(workDir, true), plan: true, targetRoot: target }) });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.status).toBe("planned");
    expect(result.stages).toContainEqual(expect.objectContaining({ stage: "services_plan", detail: expect.objectContaining({
      targetRoot: target, materialised: false, services: [expect.objectContaining({ name: "demo", image: "example/demo:1" })],
    }) }));
    expect(fs.existsSync(target)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it("checks target conflicts in a service plan without writing", async () => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "true");
    const target = path.join(workDir, "target"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "rig.yaml"), "my content");
    const result = await orchestrator().bootstrap({ mode: "plan", sourceKind: "rig_bundle", sourceRef: await buildV2Bundle(workDir, true), targetRoot: target });
    expect(result.stages).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ code: "target_conflict" }) }));
    expect(fs.readdirSync(target)).toEqual(["rig.yaml"]);
    expect(fs.readFileSync(path.join(target, "rig.yaml"), "utf8")).toBe("my content");
  });

  it("does not plan a service install over a running team", async () => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", "true");
    const repo = new RigRepository(db), rig = repo.createRig("lifetime-rig");
    const node = repo.addNode(rig.id, "dev.old", { runtime: "terminal", cwd: workDir });
    const registry = new SessionRegistry(db), session = registry.registerSession(node.id, "dev-old@lifetime-rig");
    registry.updateStatus(session.id, "running");
    const target = path.join(workDir, "target");
    const result = await orchestrator().bootstrap({ mode: "plan", sourceKind: "rig_bundle", sourceRef: await buildV2Bundle(workDir, true), targetRoot: target });
    expect(result.stages).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ code: "rig_name_running" }) }));
    expect(fs.existsSync(target)).toBe(false);
  });
});
