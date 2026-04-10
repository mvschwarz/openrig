import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
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
import type { ExecFn } from "../src/adapters/tmux.js";
import type { FsOps } from "../src/domain/package-resolver.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
];

const SIMPLE_SPEC_YAML = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

const SPEC_WITH_PACKAGES_YAML = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./test-pkg
edges: []
`.trim();

const VALID_MANIFEST_YAML = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: A test package
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/helper
      name: helper
      supported_scopes:
        - project_shared
      default_scope: project_shared
`.trim();

function createMockExec(responses: Record<string, string | Error>): ExecFn {
  return vi.fn(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error("command not found");
  }) as unknown as ExecFn;
}

// Minimal mock RigInstantiator that returns success
function createMockInstantiator(db: Database.Database) {
  return {
    db,
    async instantiate() {
      return {
        ok: true as const,
        result: { rigId: "rig-1", specName: "test-rig", specVersion: "1.0", nodes: [{ logicalId: "dev", status: "launched" as const }] },
      };
    },
  };
}

function createMockFailInstantiator(db: Database.Database) {
  return {
    db,
    async instantiate() {
      return { ok: false as const, code: "preflight_failed" as const, errors: ["tmux not found"], warnings: [] };
    },
  };
}

describe("BootstrapOrchestrator", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSpec(yaml: string): string {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, yaml);
    return specPath;
  }

  function writePkg(dir: string, manifestYaml: string, files?: Record<string, string>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.yaml"), manifestYaml);
    if (files) {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }
  }

  function realFsOps(): FsOps {
    return {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      exists: (p) => fs.existsSync(p),
      listFiles: (dirPath) => {
        const results: string[] = [];
        function walk(dir: string, prefix: string) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(dir, entry.name), path.join(prefix, entry.name));
            else results.push(prefix ? path.join(prefix, entry.name) : entry.name);
          }
        }
        walk(dirPath, "");
        return results;
      },
    };
  }

  function realEngineFsOps() {
    return {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
      copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
      deleteFile: (p: string) => fs.unlinkSync(p),
    };
  }

  function buildOrchestrator(opts?: { exec?: ExecFn; instantiator?: unknown }) {
    const exec = opts?.exec ?? createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "codex --version": "codex 0.5.0",
      "cmux capabilities": '{"workspaces":true}',
      "command -v": "/usr/local/bin/tool",
      "brew install": "installed",
      "brew list": new Error("not found"),
    });

    const bootstrapRepo = new BootstrapRepository(db);
    const runtimeVerifier = new RuntimeVerifier({ exec, db });
    const probeRegistry = new RequirementsProbeRegistry(exec, { platform: "darwin" });
    const installPlanner = new ExternalInstallPlanner({ platform: "darwin" });
    const installExecutor = new ExternalInstallExecutor({ exec, db });
    const packageRepo = new PackageRepository(db);
    const installRepo = new InstallRepository(db);
    const installEngine = new InstallEngine(installRepo, realEngineFsOps());
    const installVerifier = new InstallVerifier(installRepo, packageRepo, {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      exists: (p) => fs.existsSync(p),
    });
    const packageInstallService = new PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });
    const instantiator = opts?.instantiator ?? createMockInstantiator(db);

    return new BootstrapOrchestrator({
      db,
      bootstrapRepo,
      runtimeVerifier,
      probeRegistry,
      installPlanner,
      installExecutor,
      packageInstallService,
      rigInstantiator: instantiator as any,
      fsOps: realFsOps(),
      bundleSourceResolver: null,
    });
  }

  // T1: Plan mode returns plan, 0 bootstrap_actions rows
  it("plan mode returns plan with zero bootstrap_actions rows", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    expect(result.stages.length).toBeGreaterThan(0);

    const actions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ?")
      .all(result.runId) as Array<{ action_kind: string }>;
    expect(actions).toHaveLength(0);
  });

  // T2: Apply --yes executes all stages
  it("apply --yes executes all stages and completes", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("completed");
    expect(result.rigId).toBeTruthy();
    expect(result.stages.some((s) => s.stage === "resolve_spec")).toBe(true);
    expect(result.stages.some((s) => s.stage === "import_rig")).toBe(true);
  });

  // T3: Runtime not_found -> blocked
  it("missing required runtime blocks apply", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const exec = createMockExec({}); // All commands fail
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  // T4: Missing requirement in plan
  it("missing requirement appears in plan stage", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifestWithReqs = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifestWithReqs, { "skills/h/SKILL.md": "# H" });

    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./test-pkg
edges: []
`.trim();
    const specPath = writeSpec(specYaml);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'missing-tool'": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    const planStage = result.stages.find((s) => s.stage === "build_install_plan");
    expect(planStage).toBeDefined();
  });

  // T6: Package install uses Phase 4 engine
  it("package install links to bootstrap via bootstrap_id", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": "# Helper" });

    const specYaml = SPEC_WITH_PACKAGES_YAML;
    const specPath = writeSpec(specYaml);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("completed");

    // Check package_installs has bootstrap_id set
    const installs = db.prepare("SELECT * FROM package_installs WHERE bootstrap_id = ?")
      .all(result.runId) as Array<{ id: string; bootstrap_id: string }>;
    expect(installs.length).toBeGreaterThan(0);
    expect(installs[0]!.bootstrap_id).toBe(result.runId);
  });

  // T9: Bootstrap run status transitions
  it("bootstrap run persisted with correct status", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const run = db.prepare("SELECT * FROM bootstrap_runs WHERE id = ?")
      .get(result.runId) as { status: string; rig_id: string | null };
    expect(run.status).toBe("completed");
    expect(run.rig_id).toBeTruthy();
  });

  // T12: manual_only blocks apply
  it("manual_only requirements block apply", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifestWithSysPkg = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  system_packages:
    - name: libssl
`.trim();
    writePkg(pkgDir, manifestWithSysPkg, { "skills/h/SKILL.md": "# H" });

    const specYaml = SPEC_WITH_PACKAGES_YAML;
    const specPath = writeSpec(specYaml);

    // Non-darwin platform so system_packages -> unsupported -> manual_only
    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "command -v": "/usr/bin/tool",
    });
    const bootstrapRepo = new BootstrapRepository(db);
    const runtimeVerifier = new RuntimeVerifier({ exec, db });
    const probeRegistry = new RequirementsProbeRegistry(exec, { platform: "linux" });
    const installPlanner = new ExternalInstallPlanner({ platform: "linux" });
    const installExecutor = new ExternalInstallExecutor({ exec, db });
    const packageRepo = new PackageRepository(db);
    const installRepo = new InstallRepository(db);
    const installEngine = new InstallEngine(installRepo, realEngineFsOps());
    const installVerifier = new InstallVerifier(installRepo, packageRepo, {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      exists: (p) => fs.existsSync(p),
    });
    const packageInstallService = new PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });

    const orch = new BootstrapOrchestrator({
      db, bootstrapRepo, runtimeVerifier, probeRegistry, installPlanner, installExecutor,
      packageInstallService, rigInstantiator: createMockInstantiator(db) as any, fsOps: realFsOps(),
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("manual-only"))).toBe(true);
  });

  // T15: Relative packageRef resolved against spec file directory
  it("relative packageRef resolved against spec file directory", async () => {
    const subDir = path.join(tmpDir, "specs");
    fs.mkdirSync(subDir, { recursive: true });
    const pkgDir = path.join(subDir, "my-pkg");
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": "# Helper" });

    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./my-pkg
edges: []
`.trim();
    const specPath = path.join(subDir, "rig.yaml");
    fs.writeFileSync(specPath, specYaml);

    const orch = buildOrchestrator();
    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    const resolveStage = result.stages.find((s) => s.stage === "resolve_packages");
    expect(resolveStage?.status).toBe("ok");
  });

  // T17: Mismatched db handle throws at construction
  it("mismatched db handle throws at construction", () => {
    const db2 = createDb();
    migrate(db2, ALL_MIGRATIONS);

    expect(() => {
      new BootstrapOrchestrator({
        db,
        bootstrapRepo: new BootstrapRepository(db2), // Wrong db
        runtimeVerifier: new RuntimeVerifier({ exec: vi.fn() as any, db }),
        probeRegistry: new RequirementsProbeRegistry(vi.fn() as any),
        installPlanner: new ExternalInstallPlanner(),
        installExecutor: new ExternalInstallExecutor({ exec: vi.fn() as any, db }),
        packageInstallService: { db } as any,
        rigInstantiator: { db } as any,
        fsOps: realFsOps(),
      });
    }).toThrow(/same db handle/);

    db2.close();
  });

  // T18: github: ref blocked
  it("github: packageRef blocked with structured error", async () => {
    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - github:example/pkg@v1
edges: []
`.trim();
    const specPath = writeSpec(specYaml);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("Unsupported package ref scheme"))).toBe(true);
  });

  // T14: Plan includes all stage types
  it("plan includes runtime + requirement + install plan stages", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    const stageNames = result.stages.map((s) => s.stage);
    expect(stageNames).toContain("resolve_spec");
    expect(stageNames).toContain("resolve_packages");
    expect(stageNames).toContain("verify_runtimes");
    expect(stageNames).toContain("probe_requirements");
    expect(stageNames).toContain("build_install_plan");
  });

  // T19: Bare apply without --yes and without approvedActionKeys blocks when external installs exist
  it("bare apply blocks when external installs exist but no approval provided", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifestWithReqs = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifestWithReqs, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'missing-tool'": new Error("not found"),
      "brew list": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    // Apply without --yes or approvedActionKeys
    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("require approval"))).toBe(true);
    expect(result.stages.some((s) => s.stage === "execute_external_installs" && s.status === "blocked")).toBe(true);
  });

  // T5: Approved external install executed and journaled
  it("approved external install executed and journaled to bootstrap_actions", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: rg
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'rg'": new Error("not found"),
      "brew list": new Error("not found"),
      "brew install": "installed",
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const actions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? AND action_kind = ?")
      .all(result.runId, "external_install") as Array<{ subject_name: string; status: string }>;
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.some((a) => a.subject_name === "rg")).toBe(true);
  });

  // T7: Rig import uses instantiator
  it("rig import uses Phase 3 instantiator and journals result", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.rigId).toBe("rig-1");
    const importActions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? AND action_kind = ?")
      .all(result.runId, "rig_import") as Array<{ subject_name: string; status: string }>;
    expect(importActions).toHaveLength(1);
    expect(importActions[0]!.status).toBe("completed");
  });

  // T8: Partial external install failure continues
  it("partial external install failure continues, status = partial", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: fail-tool
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("tmux -V")) return "tmux 3.4";
      if (cmd.includes("claude --version")) return "claude 1.0.0";
      if (cmd.includes("command -v")) throw new Error("not found");
      if (cmd.includes("brew list")) throw new Error("not found");
      if (cmd.includes("brew install")) throw new Error("brew: failed to install");
      throw new Error("unknown");
    }) as unknown as ExecFn;
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    // External install failure + rig import success -> partial
    expect(result.status).toBe("partial");
    // Rig import should still have happened
    expect(result.stages.some((s) => s.stage === "import_rig" && s.status === "ok")).toBe(true);
  });

  // T10: All actions journaled in seq order
  it("all actions journaled in correct seq order", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const actions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq ASC")
      .all(result.runId) as Array<{ seq: number; action_kind: string }>;
    // Should have at least runtime checks + rig_import
    expect(actions.length).toBeGreaterThanOrEqual(2);
    // Seq should be strictly increasing
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]!.seq).toBeGreaterThan(actions[i - 1]!.seq);
    }
  });

  // T11: --yes auto-approves auto_approvable actions (with real external install)
  it("--yes auto-approves auto_approvable action and executor runs it", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-cli
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const brewInstalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("tmux -V")) return "tmux 3.4";
      if (cmd.includes("claude --version")) return "claude 1.0.0";
      if (cmd.includes("command -v")) throw new Error("not found");
      if (cmd.includes("brew list")) throw new Error("not found");
      if (cmd.includes("brew install")) { brewInstalls.push(cmd); return "ok"; }
      throw new Error("unknown");
    }) as unknown as ExecFn;
    const orch = buildOrchestrator({ exec });

    // Without --yes, this would block
    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    // --yes should have auto-approved and executor should have run brew install
    expect(brewInstalls.length).toBeGreaterThanOrEqual(1);
    expect(brewInstalls[0]).toContain("missing-cli");
  });

  // T16: Mixed seq ordering across orchestrator-journaled + executor-journaled rows (startSeq handoff)
  it("mixed seq ordering across runtime_check + external_install + package_install + rig_import", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: rg
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'rg'": new Error("not found"),
      "brew list": new Error("not found"),
      "brew install": "installed",
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const actions = db.prepare("SELECT action_kind, seq FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq")
      .all(result.runId) as Array<{ action_kind: string; seq: number }>;

    // Should have: runtime_check(s), requirement_check(s), external_install(s), package_install, rig_import
    // All with strictly increasing seq and no gaps between orchestrator and executor rows
    const kinds = actions.map((a) => a.action_kind);
    expect(kinds).toContain("runtime_check");
    expect(kinds).toContain("external_install"); // Written by executor with startSeq
    expect(kinds).toContain("rig_import");
    // Seq strictly increasing
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]!.seq).toBeGreaterThan(actions[i - 1]!.seq);
    }
    // Runtime checks before external_install before rig_import
    const firstRuntime = actions.findIndex((a) => a.action_kind === "runtime_check");
    const firstExternal = actions.findIndex((a) => a.action_kind === "external_install");
    const firstRigImport = actions.findIndex((a) => a.action_kind === "rig_import");
    expect(firstRuntime).toBeLessThan(firstExternal);
    expect(firstExternal).toBeLessThan(firstRigImport);
  });

  // T20: selective approvedActionKeys execution
  it("apply with approvedActionKeys selects specific actions for execution", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: tool-a
    - name: tool-b
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const execCalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("tmux -V")) return "tmux 3.4";
      if (cmd.includes("claude --version")) return "claude 1.0.0";
      if (cmd.includes("command -v")) throw new Error("not found");
      if (cmd.includes("brew list")) throw new Error("not found");
      if (cmd.includes("brew install")) return "ok";
      throw new Error("unknown");
    }) as unknown as ExecFn;
    const orch = buildOrchestrator({ exec });

    // Approve only tool-a
    const result = await orch.bootstrap({
      mode: "apply",
      sourceRef: specPath,
      approvedActionKeys: ["external_install:cli_tool:tool-a"],
    });

    // tool-a should be executed, tool-b should be skipped
    const brewInstalls = execCalls.filter((c) => c.includes("brew install"));
    expect(brewInstalls.some((c) => c.includes("tool-a"))).toBe(true);
    expect(brewInstalls.some((c) => c.includes("tool-b"))).toBe(false);
  });

  // T21: Unknown approved action keys with real external installs -> blocks
  it("invalid approvedActionKeys with real installs still blocks", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'missing-tool'": new Error("not found"),
      "brew list": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    // Provide only invalid keys — should still block because no real actions are approved
    const result = await orch.bootstrap({
      mode: "apply",
      sourceRef: specPath,
      approvedActionKeys: ["external_install:cli_tool:nonexistent"],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("require approval"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Unknown approved action key"))).toBe(true);
  });

  // T22: Overlapping requirements from two packages deduplicated
  it("overlapping requirements from multiple packages deduplicated to one action", async () => {
    // Create two packages that both require 'ripgrep'
    const pkg1Dir = path.join(tmpDir, "pkg-a");
    const pkg2Dir = path.join(tmpDir, "pkg-b");
    const manifest1 = `
schema_version: 1
name: pkg-a
version: "1.0.0"
summary: Package A
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/a
      name: a
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: ripgrep
`.trim();
    const manifest2 = `
schema_version: 1
name: pkg-b
version: "1.0.0"
summary: Package B
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/b
      name: b
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: ripgrep
`.trim();
    writePkg(pkg1Dir, manifest1, { "skills/a/SKILL.md": "# A" });
    writePkg(pkg2Dir, manifest2, { "skills/b/SKILL.md": "# B" });

    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev1
    runtime: claude-code
    package_refs:
      - ./pkg-a
  - id: dev2
    runtime: claude-code
    package_refs:
      - ./pkg-b
edges: []
`.trim();
    const specPath = writeSpec(specYaml);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'ripgrep'": new Error("not found"),
      "brew list": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    const planStage = result.stages.find((s) => s.stage === "build_install_plan");
    const detail = planStage?.detail as { actions: Array<{ requirementName: string }> };
    // Should be deduplicated to 1 action for ripgrep, not 2
    const ripgrepActions = detail.actions.filter((a) => a.requirementName === "ripgrep");
    expect(ripgrepActions).toHaveLength(1);
  });

  // T23: plan probe_requirements.detail includes per-requirement results
  it("plan probe_requirements detail includes per-requirement results with status", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: git
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'git'": "/usr/bin/git",
      "'missing-tool'": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    const reqStage = result.stages.find((s) => s.stage === "probe_requirements");
    expect(reqStage).toBeDefined();
    const detail = reqStage!.detail as { probed: number; results: Array<{ name: string; kind: string; status: string; detectedPath: string | null }> };
    expect(detail.probed).toBe(2);
    expect(detail.results).toHaveLength(2);

    const gitResult = detail.results.find((r) => r.name === "git");
    expect(gitResult).toBeDefined();
    expect(gitResult!.status).toBe("installed");
    expect(gitResult!.detectedPath).toBeTruthy();

    const missingResult = detail.results.find((r) => r.name === "missing-tool");
    expect(missingResult).toBeDefined();
    expect(missingResult!.status).toBe("missing");
  });

  // T24: Package install failure skips rig import (R1-F4.3)
  it("package install failure skips rig import with status=failed", async () => {
    // Create a package that will fail install (incompatible runtime)
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: codex-only-pkg
version: "1.0.0"
summary: Only works on codex
compatibility:
  runtimes:
    - codex
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const orch = buildOrchestrator();
    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("failed");
    // import_rig should be skipped
    const importStage = result.stages.find((s) => s.stage === "import_rig");
    expect(importStage?.status).toBe("skipped");
    expect(result.errors.some((e) => e.includes("skipped"))).toBe(true);
  });

  // === P7-T05: Bundle source tests ===

  // T25: Real bundle bootstrap happy path
  it("bootstrap from rig_bundle resolves vendored packages", async () => {
    // Create a real bundle
    const { LegacyBundleAssembler: BundleAssembler } = await import("../src/domain/bundle-assembler.js"); // TODO: AS-T12
    const { computeIntegrity, writeIntegrity } = await import("../src/domain/bundle-integrity.js");
    const { pack } = await import("../src/domain/bundle-archive.js");
    const { LegacyBundleSourceResolver: BundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js"); // TODO: AS-T12

    // Write package source
    const pkgDir = path.join(tmpDir, "src-pkg");
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": "# Helper" });

    // Write spec
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    // Assemble bundle
    const staging = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        copyDir: (s: string, d: string) => fs.cpSync(s, d, { recursive: true }),
      },
    });
    assembler.assemble({
      specPath, outputDir: staging, bundleName: "test-bundle", bundleVersion: "0.1.0",
      packages: [{ name: "test-pkg", version: "1.0.0", sourcePath: pkgDir, originalSource: "./test-pkg", manifestHash: "h1" }],
    });

    // Add integrity
    const integrityFsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readFileBuffer: (p: string) => fs.readFileSync(p),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      walkFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(d, e.name), pre ? `${pre}/${e.name}` : e.name); else r.push(pre ? `${pre}/${e.name}` : e.name); } } w(dir, ""); return r; },
    };
    const integrity = computeIntegrity(staging, integrityFsOps);
    writeIntegrity(staging, integrity, integrityFsOps);

    // Pack
    const bundlePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, bundlePath);

    // Bootstrap from bundle
    const bundleResolver = new BundleSourceResolver({ fsOps: realFsOps() });
    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
    });
    const bootstrapRepo = new (await import("../src/domain/bootstrap-repository.js")).BootstrapRepository(db);
    const runtimeVerifier = new (await import("../src/domain/runtime-verifier.js")).RuntimeVerifier({ exec, db });
    const probeRegistry = new (await import("../src/domain/requirements-probe.js")).RequirementsProbeRegistry(exec, { platform: "darwin" });
    const installPlanner = new (await import("../src/domain/external-install-planner.js")).ExternalInstallPlanner({ platform: "darwin" });
    const installExecutor = new (await import("../src/domain/external-install-executor.js")).ExternalInstallExecutor({ exec, db });
    const packageRepo = new (await import("../src/domain/package-repository.js")).PackageRepository(db);
    const installRepo = new (await import("../src/domain/install-repository.js")).InstallRepository(db);
    const installEngine = new (await import("../src/domain/install-engine.js")).InstallEngine(installRepo, realEngineFsOps());
    const installVerifier = new (await import("../src/domain/install-verifier.js")).InstallVerifier(installRepo, packageRepo, { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) });
    const packageInstallService = new (await import("../src/domain/package-install-service.js")).PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });

    const { BootstrapOrchestrator: BO } = await import("../src/domain/bootstrap-orchestrator.js");
    const orch = new BO({
      db, bootstrapRepo, runtimeVerifier, probeRegistry,
      installPlanner, installExecutor: installExecutor, packageInstallService,
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: bundleResolver,
    });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: bundlePath, sourceKind: "rig_bundle" });

    expect(result.status).toBe("planned");
    expect(result.stages.some((s) => s.stage === "resolve_spec" && s.status === "ok")).toBe(true);
    expect(result.stages.some((s) => s.stage === "resolve_packages" && s.status === "ok")).toBe(true);

    // Verify source_kind recorded
    const run = db.prepare("SELECT source_kind FROM bootstrap_runs WHERE id = ?")
      .get(result.runId) as { source_kind: string };
    expect(run.source_kind).toBe("rig_bundle");

    // Verify temp dir was cleaned up by the orchestrator's finally block
    // After the plan completes, no rigbundle- temp dirs should remain from this test
    const tmpBase = os.tmpdir();
    const leakedDirs = fs.readdirSync(tmpBase).filter((d) =>
      d.startsWith("rigbundle-") && fs.existsSync(path.join(tmpBase, d, "bundle.yaml"))
    );
    expect(leakedDirs).toHaveLength(0);
  });

  // T26: rig_bundle with null resolver throws
  it("rig_bundle with null bundleSourceResolver throws", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    await expect(
      orch.bootstrap({ mode: "plan", sourceRef: specPath, sourceKind: "rig_bundle" })
    ).rejects.toThrow(/BundleSourceResolver required/);
  });

  // T26: bootstrap_runs records source_kind from options
  it("bootstrap_runs records source_kind from options", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath, sourceKind: "rig_spec" });

    const run = db.prepare("SELECT source_kind FROM bootstrap_runs WHERE id = ?")
      .get(result.runId) as { source_kind: string };
    expect(run.source_kind).toBe("rig_spec");
  });

  it("rejects service-backed pod-bundle launch with honest error before instantiate", async () => {
    const { pack } = await import("../src/domain/bundle-archive.js");
    const { computeIntegrity } = await import("../src/domain/bundle-integrity.js");
    const { PodBundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js");

    // Build a minimal v2 pod bundle with a service-backed rig spec
    const staging = path.join(tmpDir, "svc-bundle-staging");
    fs.mkdirSync(staging, { recursive: true });

    const svcSpecYaml = `
version: "0.2"
name: svc-bundle-rig
summary: A service-backed rig in a bundle
services:
  kind: compose
  compose_file: svc.compose.yaml
  wait_for:
    - url: http://127.0.0.1:8200/health
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        runtime: claude-code
        profile: default
        cwd: .
    edges: []
edges: []
`.trim();
    fs.writeFileSync(path.join(staging, "rig.yaml"), svcSpecYaml);
    fs.writeFileSync(path.join(staging, "svc.compose.yaml"), "version: '3.8'\nservices:\n  vault:\n    image: hashicorp/vault:1.15\n");
    // Compute integrity over content files before writing bundle.yaml
    const integrityFsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readFileBuffer: (p: string) => fs.readFileSync(p),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      walkFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(d, e.name), pre ? `${pre}/${e.name}` : e.name); else r.push(pre ? `${pre}/${e.name}` : e.name); } } w(dir, ""); return r; },
    };
    const integrity = computeIntegrity(staging, integrityFsOps);
    const integrityYaml = `  algorithm: ${integrity.algorithm}\n  files:\n` +
      Object.entries(integrity.files).map(([k, v]) => `    ${k}: ${v}`).join("\n");

    fs.writeFileSync(path.join(staging, "bundle.yaml"), `
schema_version: 2
name: svc-bundle
version: "0.1.0"
created_at: "2026-04-09T00:00:00Z"
rig_spec: rig.yaml
agents: []
integrity:
${integrityYaml}
`.trim());

    const bundlePath = path.join(tmpDir, "svc-test.rigbundle");
    await pack(staging, bundlePath);

    // Record existing podbundle- dirs before test
    const tmpBase = os.tmpdir();
    const preExistingDirs = new Set(fs.readdirSync(tmpBase).filter((d) => d.startsWith("podbundle-")));

    const podBundleResolver = new PodBundleSourceResolver();
    const { LegacyBundleSourceResolver: BundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js");
    const legacyBundleResolver = new BundleSourceResolver({ fsOps: realFsOps() });
    const mockPodInstantiator = { db, instantiate: vi.fn() };

    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: createMockExec({}), db }),
      probeRegistry: new RequirementsProbeRegistry(createMockExec({})),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: createMockExec({}), db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), realEngineFsOps()),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: legacyBundleResolver,
      podBundleSourceResolver: podBundleResolver as any,
      podInstantiator: mockPodInstantiator as any,
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle" });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e: string) => e.includes("Service-backed rigs cannot be launched from .rigbundle"))).toBe(true);
    const resolveStage = result.stages.find((s) => s.stage === "resolve_spec" && s.status === "failed");
    expect(resolveStage).toBeDefined();
    expect((resolveStage!.detail as Record<string, unknown>)["code"]).toBe("services_unsupported");
    // Must NOT have called instantiate
    expect(mockPodInstantiator.instantiate).not.toHaveBeenCalled();
    // Temp dir must be cleaned up even on rejection — only check dirs created during this test
    const postDirs = fs.readdirSync(tmpBase).filter((d) =>
      d.startsWith("podbundle-") && !preExistingDirs.has(d)
    );
    expect(postDirs).toHaveLength(0);
  });

  // AS-T08b: pod-aware rig spec delegates to podInstantiator
  it("pod-aware rig spec delegates to podInstantiator via bootstrap", async () => {
    const podSpecYaml = `
version: "0.2"
name: pod-test-rig
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
    const specPath = path.join(tmpDir, "pod-spec.yaml");
    fs.writeFileSync(specPath, podSpecYaml);

    // Mock podInstantiator
    const mockPodInstantiator = {
      db,
      instantiate: vi.fn(async () => ({
        ok: true as const,
        result: { rigId: "rig-pod-1", specName: "pod-test-rig", specVersion: "0.2", nodes: [{ logicalId: "dev.impl", status: "launched" as const }] },
      })),
    };

    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: createMockExec({}), db }),
      probeRegistry: new RequirementsProbeRegistry(createMockExec({})),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: createMockExec({}), db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), realEngineFsOps()),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: null,
      podInstantiator: mockPodInstantiator as any,
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, sourceKind: "rig_spec" });
    expect(result.status).toBe("completed");
    expect(result.rigId).toBe("rig-pod-1");
    expect(mockPodInstantiator.instantiate).toHaveBeenCalledTimes(1);
  });
});
