// A bundle's declared contents are routed before any seat launches.
//
// Goes through the real BootstrapOrchestrator, PodBundleSourceResolver and
// routeBundleContents with real temp-filesystem effects. Only the launch
// (PodRigInstantiator) is faked: it runs the pre-launch hook exactly where the
// real instantiator does (after the rig record, before any member), then
// records what a seat would have seen at its first turn.
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
import { routeBundleContents, routingFailureWarnings, type BundleContentRouting } from "../src/domain/bundle-content-routing.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { FsOps } from "../src/domain/package-resolver.js";

const RIG_YAML = `
version: "0.2"
name: routed-rig
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

const PACK_MANIFEST = `name: demo
version: 0.1.0
taxonomy: world
files:
  - path: intro.md
    role: overview
`;

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

async function buildBundleWithPack(workDir: string, packManifest = PACK_MANIFEST): Promise<string> {
  const staging = path.join(workDir, "staging");
  fs.mkdirSync(path.join(staging, "agents", "impl"), { recursive: true });
  fs.mkdirSync(path.join(staging, "context-packs", "demo"), { recursive: true });
  fs.writeFileSync(path.join(staging, "rig.yaml"), RIG_YAML);
  fs.writeFileSync(path.join(staging, "agents", "impl", "agent.yaml"), `name: impl\nversion: "1.0"\n`);
  fs.writeFileSync(path.join(staging, "context-packs", "demo", "manifest.yaml"), packManifest);
  fs.writeFileSync(path.join(staging, "context-packs", "demo", "intro.md"), "# Demo world\n");
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
name: routed
version: "0.1.0"
created_at: "2026-10-04T00:00:00Z"
rig_spec: rig.yaml
agents:
  - name: impl
    version: "1.0"
    path: agents/impl
    original_ref: "local:agents/impl"
    hash: "${"0".repeat(64)}"
    import_entries: []
context_packs:
  - context-packs/demo/manifest.yaml
integrity:
${integrityYaml}
`);
  const bundlePath = path.join(workDir, "routed.rigbundle");
  await pack(staging, bundlePath);
  return bundlePath;
}

type Hook = (rigId: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;

describe("bundle contents are routed before any seat launches", () => {
  let db: Database.Database;
  let workDir: string;
  let contextRoot: string;
  let bundlePath: string;
  let savedContextRoot: string | undefined;
  let seenAtLaunch: { packOnDisk: boolean; rescans: number } | null;
  let rescans: number;
  let podInstantiator: { db: Database.Database; instantiate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-prelaunch-"));
    contextRoot = path.join(workDir, "context");
    savedContextRoot = process.env["OPENRIG_CONTEXT_ROOT"];
    process.env["OPENRIG_CONTEXT_ROOT"] = contextRoot;
    bundlePath = await buildBundleWithPack(workDir);
    seenAtLaunch = null;
    rescans = 0;
    podInstantiator = {
      db,
      instantiate: vi.fn(async (_yaml: string, _rigRoot: string, opts?: { prelaunchHook?: Hook }) => {
        if (opts?.prelaunchHook) {
          const hook = await opts.prelaunchHook("rig-1");
          if (!hook.ok) return { ok: false as const, code: hook.code, message: hook.message };
        }
        seenAtLaunch = { packOnDisk: fs.existsSync(path.join(contextRoot, "demo", "manifest.yaml")), rescans };
        return { ok: true as const, result: { rigId: "rig-1", specName: "routed-rig", specVersion: "0.2", nodes: [{ logicalId: "dev.impl", status: "launched" as const }] } };
      }),
    };
  });

  afterEach(() => {
    db.close();
    if (savedContextRoot === undefined) delete process.env["OPENRIG_CONTEXT_ROOT"];
    else process.env["OPENRIG_CONTEXT_ROOT"] = savedContextRoot;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function orchestrator(route?: (bundlePath: string) => Promise<BundleContentRouting>): BootstrapOrchestrator {
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
      routeBundleContents: route ?? ((p) => routeBundleContents(p, { onContextPacksRouted: () => { rescans += 1; } })),
    });
  }

  it("routes the declared context pack and rescans the library before the first seat launches", async () => {
    const result = await orchestrator().bootstrap({
      mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: path.join(workDir, "target"),
    });

    expect(result.status).toBe("completed");
    expect(seenAtLaunch).toEqual({ packOnDisk: true, rescans: 1 });
    expect(result.bundleRouting?.contextPacksRouting?.routedCount).toBe(1);
    expect(result.bundleRouting?.routingFailures).toBeUndefined();
    expect(result.stages.find((s) => s.stage === "route_bundle_contents")?.status).toBe("ok");
  });

  it("reports a routing failure as a warning and still launches the rig", async () => {
    const route = vi.fn(async (): Promise<BundleContentRouting> => ({
      routingFailures: [{ kind: "contextPacks", error: "no space left on device" }],
    }));

    const result = await orchestrator(route).bootstrap({
      mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: path.join(workDir, "target"),
    });

    expect(route).toHaveBeenCalledWith(bundlePath);
    expect(result.status).toBe("completed");
    expect(seenAtLaunch).not.toBeNull();
    expect(result.warnings).toContain("Bundle contextPacks routing failed: no space left on device");
    expect(result.stages.find((s) => s.stage === "route_bundle_contents")?.status).toBe("failed");
    expect(result.bundleRouting?.routingFailures).toHaveLength(1);
  });

  it("a router that throws still lets the rig launch, with a warning and a failed stage", async () => {
    const route = vi.fn(async (): Promise<BundleContentRouting> => { throw new Error("EACCES: permission denied, mkdtemp"); });

    const result = await orchestrator(route).bootstrap({
      mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle", targetRoot: path.join(workDir, "target"),
    });

    expect(result.status).toBe("completed");
    expect(seenAtLaunch).not.toBeNull();
    expect(result.warnings).toContain("Bundle bundle routing failed: EACCES: permission denied, mkdtemp");
    expect(result.stages.find((s) => s.stage === "route_bundle_contents")?.status).toBe("failed");
  });

  it("a pack the live library rejects is reported, not counted as usable", async () => {
    const badBundle = await buildBundleWithPack(fs.mkdtempSync(path.join(workDir, "bad-")), "name: demo\ntaxonomy: world\nfiles:\n  - path: intro.md\n    role: overview\n");
    const library = new ContextPackLibraryService({ roots: [{ path: contextRoot, sourceType: "user_file" }] });

    const result = await orchestrator((p) => routeBundleContents(p, { onContextPacksRouted: () => library.scan() })).bootstrap({
      mode: "apply", sourceRef: badBundle, sourceKind: "rig_bundle", targetRoot: path.join(workDir, "target-bad"),
    });

    expect(result.status).toBe("completed");
    expect(result.bundleRouting?.routingFailures?.[0]).toMatchObject({ kind: "contextPacks" });
    expect(result.bundleRouting?.routingFailures?.[0]?.error).toMatch(/could not load .*demo/);
    expect(result.warnings.some((w) => /Bundle contextPacks routing failed: the context-pack library could not load/.test(w))).toBe(true);
  });

  it("does not route for a rig spec source", async () => {
    const specDir = path.join(workDir, "spec");
    fs.mkdirSync(path.join(specDir, "agents", "impl"), { recursive: true });
    fs.writeFileSync(path.join(specDir, "rig.yaml"), RIG_YAML);
    const route = vi.fn(async (): Promise<BundleContentRouting> => ({}));

    const result = await orchestrator(route).bootstrap({
      mode: "apply", sourceRef: path.join(specDir, "rig.yaml"), sourceKind: "rig_spec",
    });

    expect(result.status).toBe("completed");
    expect(route).not.toHaveBeenCalled();
    expect(result.bundleRouting).toBeUndefined();
  });
});

describe("routeBundleContents", () => {
  it("never throws: an unreadable bundle is reported as a bundle failure", async () => {
    const routing = await routeBundleContents(path.join(os.tmpdir(), "no-such-bundle-20261004.rigbundle"));

    expect(routing.routingFailures).toHaveLength(1);
    expect(routing.routingFailures?.[0]?.kind).toBe("bundle");
    expect(routingFailureWarnings(routing)[0]).toMatch(/^Bundle bundle routing failed: /);
  });

  it("never throws when its temporary directory cannot be created", async () => {
    const savedTmp = process.env["TMPDIR"];
    process.env["TMPDIR"] = path.join(os.tmpdir(), "no-such-dir-20261004", "nested");
    try {
      const routing = await routeBundleContents("/nonexistent.rigbundle");
      expect(routing.routingFailures?.[0]?.kind).toBe("bundle");
    } finally {
      if (savedTmp === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = savedTmp;
    }
  });

  it("has no warnings when nothing failed", () => {
    expect(routingFailureWarnings({})).toEqual([]);
    expect(routingFailureWarnings(undefined)).toEqual([]);
  });
});
