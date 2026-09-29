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
import type { ExecFn } from "../src/adapters/tmux.js";
import type { FsOps } from "../src/domain/package-resolver.js";

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

async function buildV2Bundle(workDir: string): Promise<string> {
  const staging = path.join(workDir, "staging");
  fs.mkdirSync(path.join(staging, "agents", "impl"), { recursive: true });
  fs.writeFileSync(path.join(staging, "rig.yaml"), RIG_YAML);
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
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function orchestrator(): BootstrapOrchestrator {
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
});
