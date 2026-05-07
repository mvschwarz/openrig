import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { createTestApp } from "./helpers/test-app.js";
import type { PersistedEvent } from "../src/domain/types.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema,
];

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

const SKILL_CONTENT = "# Helper Skill\nDo helpful things.";

const GUIDANCE_MANIFEST_YAML = `
schema_version: 1
name: guidance-pkg
version: "1.0.0"
summary: A guidance package
compatibility:
  runtimes:
    - claude-code
exports:
  guidance:
    - source: guidance/rules.md
      name: rules
      kind: claude_md
      supported_scopes:
        - project_shared
      default_scope: project_shared
      merge_strategy: managed_block
`.trim();

const MIXED_MANIFEST_YAML = `
schema_version: 1
name: mixed-pkg
version: "1.0.0"
summary: Skills + guidance
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/tool
      name: tool
      supported_scopes:
        - project_shared
      default_scope: project_shared
  guidance:
    - source: guidance/rules.md
      name: rules
      kind: claude_md
      supported_scopes:
        - project_shared
      default_scope: project_shared
      merge_strategy: managed_block
`.trim();

describe("Package API routes", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;
  let pkgDir: string;
  let targetDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-routes-"));
    pkgDir = path.join(tmpDir, "pkg");
    targetDir = path.join(tmpDir, "target");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePkg(dir: string, manifestYaml: string, files?: Record<string, string>) {
    fs.writeFileSync(path.join(dir, "package.yaml"), manifestYaml);
    if (files) {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }
  }

  // --- Test 1: POST /validate valid manifest → 200 ---
  it("POST /api/packages/validate valid manifest → 200 with manifest summary", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.manifest.name).toBe("test-pkg");
    expect(body.manifest.version).toBe("1.0.0");
    expect(body.manifest.summary).toBe("A test package");
    expect(body.manifest.runtimes).toContain("claude-code");
    expect(body.manifest.exportCounts.skills).toBe(1);
  });

  // --- Test 2: POST /validate invalid manifest → 400 with errors[] ---
  it("POST /api/packages/validate invalid manifest → 400 with errors array", async () => {
    writePkg(pkgDir, "schema_version: 1\n# missing name, version, etc.");

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    // No singular "error" field for validation failures
    expect(body.error).toBeUndefined();
  });

  // --- Test 3: POST /validate missing package.yaml → 400 with error string ---
  it("POST /api/packages/validate missing package.yaml → 400 with error string", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: emptyDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(typeof body.error).toBe("string");
    // No errors array for resolution failures
    expect(body.errors).toBeUndefined();
  });

  // --- Test 4: POST /plan → 200 with classified entries ---
  it("POST /api/packages/plan → 200 with classified entries", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.packageName).toBe("test-pkg");
    expect(body.packageVersion).toBe("1.0.0");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(typeof body.actionable).toBe("number");
    expect(typeof body.deferred).toBe("number");
    expect(typeof body.conflicts).toBe("number");
    expect(typeof body.noOps).toBe("number");
  });

  // --- Test 5: POST /install clean repo → 201 with applied + verification ---
  it("POST /api/packages/install clean repo → 201 with install result", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.installId).toBeTruthy();
    expect(body.packageId).toBeTruthy();
    expect(body.packageName).toBe("test-pkg");
    expect(Array.isArray(body.applied)).toBe(true);
    expect(body.applied.length).toBeGreaterThan(0);
    expect(body.verification).toBeTruthy();
    expect(body.verification.passed).toBe(true);

    // Verify file was actually written
    const skillPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf-8")).toBe(SKILL_CONTENT);
  });

  // --- Test 6: POST /install with conflicts → 409 ---
  it("POST /api/packages/install with conflicts → 409 conflict_blocked", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // Pre-create conflicting skill with different content
    const conflictPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(conflictPath, "# Different content");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("conflict_blocked");
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(body.conflicts.length).toBeGreaterThan(0);
  });

  // --- Test 7: POST /install with allowMerge → 201 merged guidance ---
  it("POST /api/packages/install with allowMerge → 201 merged guidance", async () => {
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, {
      "guidance/rules.md": "Follow these rules.",
    });

    // Pre-create CLAUDE.md so guidance is classified as managed_merge
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing content\n");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        allowMerge: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.applied.length).toBeGreaterThan(0);

    // Verify managed block was inserted
    const claudeMd = fs.readFileSync(path.join(targetDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("<!-- BEGIN OpenRig MANAGED BLOCK: guidance-pkg -->");
    expect(claudeMd).toContain("<!-- END OpenRig MANAGED BLOCK: guidance-pkg -->");
    expect(claudeMd).toContain("# Existing content");
  });

  // --- Test 8: POST /install mixed policy: skills approved, guidance rejected ---
  it("POST /api/packages/install mixed policy → 201 with applied + policyRejected", async () => {
    writePkg(pkgDir, MIXED_MANIFEST_YAML, {
      "skills/tool/SKILL.md": "# Tool skill",
      "guidance/rules.md": "Follow these rules.",
    });

    // Pre-create CLAUDE.md so guidance is classified as managed_merge
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing\n");

    // Do NOT set allowMerge — skills are safe_projection (approved), guidance is managed_merge (rejected)
    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    // Skills were applied
    expect(body.applied.length).toBeGreaterThan(0);
    expect(body.applied.some((e: { exportType: string }) => e.exportType === "skill")).toBe(true);
    // Guidance was rejected by policy
    expect(Array.isArray(body.policyRejected)).toBe(true);
    expect(body.policyRejected.length).toBeGreaterThan(0);
    expect(body.policyRejected.some((r: { entry: { exportType: string } }) => r.entry.exportType === "guidance")).toBe(true);
  });

  // --- Test 9: POST /install guidance-only without allowMerge → 422 ---
  it("POST /api/packages/install guidance-only without allowMerge → 422 policy_rejected", async () => {
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, {
      "guidance/rules.md": "Follow these rules.",
    });

    // Pre-create CLAUDE.md so guidance is classified as managed_merge
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing\n");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        // allowMerge NOT set
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("policy_rejected");
    expect(Array.isArray(body.rejected)).toBe(true);
    expect(body.rejected.length).toBeGreaterThan(0);
  });

  // --- Test 10: POST /rollback → 200 ---
  it("POST /api/packages/:installId/rollback → 200 rollback result", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // First install
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { installId } = await installRes.json();

    // Now rollback
    const res = await app.request(`/api/packages/${installId}/rollback`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installId).toBe(installId);
    expect(Array.isArray(body.restored)).toBe(true);
    expect(Array.isArray(body.deleted)).toBe(true);

    // Skill file should be gone (was new, no backup → deleted)
    const skillPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  // --- Test 11: POST /rollback not found → 404 ---
  it("POST /api/packages/:installId/rollback not found → 404", async () => {
    const res = await app.request("/api/packages/nonexistent-id/rollback", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Install not found");
  });

  // --- Test 12: GET /packages → 200 list ---
  it("GET /api/packages → 200 package list", async () => {
    const res = await app.request("/api/packages");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  // --- Test 13: GET /:packageId/installs → 200 list ---
  it("GET /api/packages/:packageId/installs → 200 install list", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // Install first
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { packageId } = await installRes.json();

    const res = await app.request(`/api/packages/${packageId}/installs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });

  // --- Test 14: GET /installs/:installId/journal → 200 entries ---
  it("GET /api/packages/installs/:installId/journal → 200 journal entries", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { installId } = await installRes.json();

    const res = await app.request(`/api/packages/installs/${installId}/journal`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  // --- Test 15: GET /installs/:installId/journal not found → 404 ---
  it("GET /api/packages/installs/:installId/journal not found → 404", async () => {
    const res = await app.request("/api/packages/installs/nonexistent/journal");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Install not found");
  });

  // --- Test 16: Dedup — install same name+version twice → 1 package, 2 installs ---
  it("install same package twice → 1 package row, 2 install rows", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // First install
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);
    const body1 = await res1.json();
    const packageId = body1.packageId;

    // Rollback first install so target is clean for second
    await app.request(`/api/packages/${body1.installId}/rollback`, { method: "POST" });

    // Second install — same package
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res2.status).toBe(201);
    const body2 = await res2.json();

    // Same package ID reused
    expect(body2.packageId).toBe(packageId);

    // GET /packages → 1 package
    const pkgRes = await app.request("/api/packages");
    const pkgs = await pkgRes.json();
    expect(pkgs.length).toBe(1);

    // GET /:packageId/installs → 2 installs
    const installsRes = await app.request(`/api/packages/${packageId}/installs`);
    const installs = await installsRes.json();
    expect(installs.length).toBe(2);
  });

  // --- Test 17: POST /plan with invalid manifest → 400 with errors[] ---
  it("POST /api/packages/plan invalid manifest → 400 with errors array", async () => {
    writePkg(pkgDir, "schema_version: 1\n# missing name, version, etc.");

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // --- Test 18: POST /install with invalid manifest → 400 with errors[] ---
  it("POST /api/packages/install invalid manifest → 400 with errors array", async () => {
    writePkg(pkgDir, "schema_version: 1\n# missing name, version, etc.");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // --- Test 19: POST /install verification failure → 500 verification_failed ---
  it("POST /api/packages/install verification failure → 500 verification_failed", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // Spy on verifier to force a failure
    vi.spyOn(setup.installVerifier, "verify").mockReturnValueOnce({
      passed: false,
      installId: "will-be-overridden",
      entries: [],
      statusCheck: { name: "forced_failure", passed: false, expected: "pass", actual: "forced fail" },
    });

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("verification_failed");
    expect(body.error).toBe("Post-apply verification failed");
    expect(typeof body.installId).toBe("string");
    expect(body.verification).toBeTruthy();
    expect(body.verification.passed).toBe(false);

    vi.restoreAllMocks();
  });

  // === PUX-T02: Summary endpoint ===

  // --- Test: GET /api/packages/summary returns install count + latest status ---
  it("GET /api/packages/summary returns packages with installCount and latestInstallStatus", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Install a package
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);

    const res = await app.request("/api/packages/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("test-pkg");
    expect(body[0].installCount).toBe(1);
    expect(body[0].latestInstallStatus).toBe("applied");
  });

  // --- Test: GET /api/packages/summary latestInstallStatus follows actual latest install ---
  it("GET /api/packages/summary latestInstallStatus reflects latest install deterministically", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // First install — succeeds (applied)
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);
    const { installId } = await res1.json();

    // Rollback first install (status -> rolled_back)
    await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });

    // Second install — succeeds (applied)
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res2.status).toBe(201);

    // Summary should show 2 installs and latest status = applied (not rolled_back)
    const summaryRes = await app.request("/api/packages/summary");
    const summary = await summaryRes.json();
    expect(summary.length).toBe(1);
    expect(summary[0].installCount).toBe(2);
    expect(summary[0].latestInstallStatus).toBe("applied");
  });

  // === PUX-T03: Widened API endpoint tests ===

  // --- Test: POST /validate returns roles + requirements ---
  it("POST /api/packages/validate returns roles and requirements", async () => {
    const richManifest = `
schema_version: 1
name: rich-pkg
version: "1.0.0"
summary: Package with roles and requirements
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/tool
      name: tool
      supported_scopes:
        - project_shared
      default_scope: project_shared
roles:
  - name: dev
    description: Developer role
    skills:
      - tool
requirements:
  cli_tools:
    - name: jq
  system_packages:
    - name: git
`.trim();

    writePkg(pkgDir, richManifest, {
      "skills/tool/SKILL.md": "# Tool\nDo things.",
    });

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);

    // Roles
    expect(Array.isArray(body.manifest.roles)).toBe(true);
    expect(body.manifest.roles.length).toBe(1);
    expect(body.manifest.roles[0].name).toBe("dev");
    expect(body.manifest.roles[0].description).toBe("Developer role");

    // Requirements
    expect(Array.isArray(body.manifest.requirements.cliTools)).toBe(true);
    expect(body.manifest.requirements.cliTools.length).toBe(1);
    expect(body.manifest.requirements.cliTools[0].name).toBe("jq");

    expect(Array.isArray(body.manifest.requirements.systemPackages)).toBe(true);
    expect(body.manifest.requirements.systemPackages.length).toBe(1);
    expect(body.manifest.requirements.systemPackages[0].name).toBe("git");
  });

  // --- Test: POST /plan with allowMerge returns policy-annotated entries ---
  it("POST /api/packages/plan with allowMerge returns policy-annotated entries", async () => {
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, {
      "guidance/rules.md": "Follow these rules.",
    });

    // Pre-create CLAUDE.md so guidance is classified as managed_merge
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing content\n");

    // Without allowMerge — guidance should be rejected
    const resRejected = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        allowMerge: false,
      }),
    });

    expect(resRejected.status).toBe(200);
    const bodyRejected = await resRejected.json();
    const rejectedEntry = bodyRejected.entries.find(
      (e: { exportType: string }) => e.exportType === "guidance",
    );
    expect(rejectedEntry).toBeTruthy();
    expect(rejectedEntry.policyStatus).toBe("rejected");
    expect(bodyRejected.rejected).toBeGreaterThan(0);

    // With allowMerge — guidance should be approved
    const resApproved = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        allowMerge: true,
      }),
    });

    expect(resApproved.status).toBe(200);
    const bodyApproved = await resApproved.json();
    const approvedEntry = bodyApproved.entries.find(
      (e: { exportType: string }) => e.exportType === "guidance",
    );
    expect(approvedEntry).toBeTruthy();
    expect(approvedEntry.policyStatus).toBe("approved");
    expect(bodyApproved.actionable).toBeGreaterThan(0);
  });

  // === PUX-T04: Package detail + install history ===

  // --- Test: GET /api/packages/:packageId returns package or 404 ---
  it("GET /api/packages/:packageId returns package or 404", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Install a package to create the package record
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);
    const { packageId } = await installRes.json();

    // GET existing package → 200
    const res = await app.request(`/api/packages/${packageId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-pkg");
    expect(body.version).toBe("1.0.0");

    // GET nonexistent package → 404
    const res404 = await app.request("/api/packages/nonexistent");
    expect(res404.status).toBe(404);
  });

  // --- Test: GET /api/packages/:packageId/installs returns InstallSummary with appliedCount and deferredCount ---
  it("GET /api/packages/:packageId/installs returns InstallSummary with appliedCount and deferredCount", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Install a package
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);
    const { packageId } = await installRes.json();

    // GET installs for this package → 200 array
    const res = await app.request(`/api/packages/${packageId}/installs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);

    // Assert appliedCount is a number > 0
    expect(typeof body[0].appliedCount).toBe("number");
    expect(body[0].appliedCount).toBeGreaterThan(0);

    // Assert deferredCount === null (explicitly)
    expect(body[0].deferredCount).toBe(null);
  });

  // --- Test: install history orders same-second installs deterministically ---
  it("GET /api/packages/:packageId/installs orders same-second installs by rowid DESC", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // First install
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);
    const { installId: id1, packageId } = await res1.json();

    // Rollback so target is clean for second install
    await app.request(`/api/packages/${id1}/rollback`, { method: "POST" });

    // Second install — same second (in-memory DB, both get same datetime('now'))
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res2.status).toBe(201);
    const { installId: id2 } = await res2.json();

    // Newest first (id2 before id1)
    const listRes = await app.request(`/api/packages/${packageId}/installs`);
    const installs = await listRes.json();
    expect(installs.length).toBe(2);
    expect(installs[0].id).toBe(id2);
    expect(installs[1].id).toBe(id1);
  });

  // === PUX-T00: Event emission tests ===

  function getEvents(database: Database.Database): Array<{ type: string; payload: string }> {
    return database.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>;
  }

  // --- Test 20: Install emits package.installed event ---
  it("POST /api/packages/install emits package.installed event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.installed");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.type).toBe("package.installed");
    expect(payload.packageName).toBe("test-pkg");
    expect(payload.packageVersion).toBe("1.0.0");
    expect(typeof payload.installId).toBe("string");
    expect(typeof payload.applied).toBe("number");
    expect(typeof payload.deferred).toBe("number");
  });

  // --- Test 21: Rollback emits package.rolledback event ---
  it("POST /api/packages/:installId/rollback emits package.rolledback event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { installId } = await installRes.json();

    await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });

    const events = getEvents(db).filter((e) => e.type === "package.rolledback");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.installId).toBe(installId);
    expect(typeof payload.restored).toBe("number");
  });

  // --- Test 22: Install conflict emits package.install_failed ---
  it("POST /api/packages/install with conflict emits package.install_failed", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Create conflicting skill
    const conflictPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(conflictPath, "# Different");

    await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.install_failed");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.code).toBe("conflict_blocked");
    expect(payload.packageName).toBe("test-pkg");
  });

  // --- Test 23: SSE global stream receives package.installed event ---
  it("GET /api/events (global) receives package.installed via SSE", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Start SSE stream (no rigId = global)
    const ssePromise = app.request("/api/events");

    // Small delay to let SSE subscribe
    await new Promise((r) => setTimeout(r, 50));

    // Trigger install
    await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    // Read SSE events
    const sseRes = await ssePromise;
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 1000;
    const sseEvents: Array<{ id: string; data: string }> = [];

    while (sseEvents.length < 1 && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))
        ),
      ]);
      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        if (!block.trim()) continue;
        let id = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (data) sseEvents.push({ id, data });
      }
    }
    reader.cancel().catch(() => {});

    // Find the package.installed event in the SSE stream
    const installedEvents = sseEvents.filter((e) => {
      const parsed = JSON.parse(e.data);
      return parsed.type === "package.installed";
    });
    expect(installedEvents.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(installedEvents[0]!.data);
    expect(parsed.packageName).toBe("test-pkg");
  });

  // --- Test 24: Validate emits package.validated event ---
  it("POST /api/packages/validate emits package.validated event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.validated");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.packageName).toBe("test-pkg");
    expect(payload.valid).toBe(true);
  });

  // --- Test 25: Plan emits package.planned event ---
  it("POST /api/packages/plan emits package.planned event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.planned");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.packageName).toBe("test-pkg");
    expect(typeof payload.actionable).toBe("number");
    expect(typeof payload.deferred).toBe("number");
    expect(typeof payload.conflicts).toBe("number");
  });

  // --- Test 26: SSE with rigId still works (backward compat) ---
  it("GET /api/events?rigId=X returns only rig-scoped events, not package events", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Emit a rig event first
    setup.eventBus.emit({ type: "rig.created", rigId: "test-rig" });

    // Trigger a package event
    await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    // SSE with rigId should only get rig events
    const sseRes = await app.request("/api/events?rigId=test-rig");
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    const sseEvents: Array<{ data: string }> = [];

    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))
        ),
      ]);
      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        if (!block.trim()) continue;
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (data) sseEvents.push({ data });
      }
    }
    reader.cancel().catch(() => {});

    // Should have rig.created, but NOT package.validated
    const types = sseEvents.map((e) => JSON.parse(e.data).type);
    expect(types).toContain("rig.created");
    expect(types).not.toContain("package.validated");
  });

  // --- Test 27: manifest_hash_mismatch emits package.install_failed ---
  it("POST /api/packages/install manifest_hash_mismatch emits package.install_failed", async () => {
    // First install with original manifest
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);

    // Modify the manifest (different content, same name+version)
    const altManifest = VALID_MANIFEST_YAML.replace("A test package", "A DIFFERENT test package");
    writePkg(pkgDir, altManifest, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Second install — same name+version, different manifest hash
    const altTargetDir = path.join(tmpDir, "target2");
    fs.mkdirSync(altTargetDir, { recursive: true });
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: altTargetDir, runtime: "claude-code" }),
    });

    expect(res2.status).toBe(409);
    const body = await res2.json();
    expect(body.code).toBe("manifest_hash_mismatch");

    // Verify event was emitted
    const events = getEvents(db).filter((e) => e.type === "package.install_failed");
    const hashMismatchEvents = events.filter((e) => JSON.parse(e.payload).code === "manifest_hash_mismatch");
    expect(hashMismatchEvents.length).toBe(1);
    const payload = JSON.parse(hashMismatchEvents[0]!.payload);
    expect(payload.packageName).toBe("test-pkg");
    expect(payload.code).toBe("manifest_hash_mismatch");
  });

  // --- Test 28: package.planned event actionable count matches response (R2-M1) ---
  it("POST /api/packages/plan event actionable count matches response after policy", async () => {
    // Guidance-only package: with allowMerge:false, policy rejects managed_merge entries
    // so response actionable=0 but pre-policy actionable=1
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, { "guidance/rules.md": "# Rules" });
    // Create existing CLAUDE.md so guidance classifies as managed_merge
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing");

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code", allowMerge: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Response says 0 actionable because policy rejected managed_merge without allowMerge
    expect(body.actionable).toBe(0);
    expect(body.rejected).toBe(1);

    // Event must match response — actionable:0, not pre-policy 1
    const events = getEvents(db).filter((e) => e.type === "package.planned");
    expect(events.length).toBe(1);
    const eventPayload = JSON.parse(events[0]!.payload);
    expect(eventPayload.actionable).toBe(body.actionable);
  });

  // --- Test 29: /plan returns 400 on nonexistent role (R2-M2) ---
  it("POST /api/packages/plan with nonexistent role returns 400", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code", roleName: "nonexistent" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("plan_error");
    expect(body.error).toContain("nonexistent");
  });

  // --- Test 30: /install returns 400 on nonexistent role (R2-M2) ---
  it("POST /api/packages/install with nonexistent role returns 400", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code", roleName: "nonexistent" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("plan_error");
    expect(body.error).toContain("nonexistent");
  });

  // --- Test 31: Double rollback returns 409 with no journal/event growth (R2-M3) ---
  it("POST rollback on already rolled-back install returns 409, no journal/event growth", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // Install
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);
    const { installId } = await installRes.json();

    // First rollback — should succeed
    const rollback1 = await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });
    expect(rollback1.status).toBe(200);

    // Capture journal and event counts after first rollback
    const journalAfterFirst = db.prepare("SELECT COUNT(*) AS cnt FROM install_journal WHERE install_id = ?").get(installId) as { cnt: number };
    const eventsAfterFirst = getEvents(db).filter((e) => e.type === "package.rolledback").length;

    // Second rollback — should be rejected
    const rollback2 = await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });
    expect(rollback2.status).toBe(409);
    const body = await rollback2.json();
    expect(body.code).toBe("not_applied");
    expect(body.status).toBe("rolled_back");

    // Journal count must NOT have grown
    const journalAfterSecond = db.prepare("SELECT COUNT(*) AS cnt FROM install_journal WHERE install_id = ?").get(installId) as { cnt: number };
    expect(journalAfterSecond.cnt).toBe(journalAfterFirst.cnt);

    // Event count must NOT have grown
    const eventsAfterSecond = getEvents(db).filter((e) => e.type === "package.rolledback").length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });
});

describe("AgentSpec validation route", () => {
  let db: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createTestApp>["app"];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/agents/validate with valid YAML returns valid:true", async () => {
    const yaml = 'name: test-agent\nversion: "1.0"\nprofiles: {}';
    const res = await app.request("/api/agents/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
  });

  it("POST /api/agents/validate with empty body returns 400", async () => {
    const res = await app.request("/api/agents/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "  ",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors).toContain("Empty YAML body");
  });

  it("POST /api/agents/validate with invalid spec returns errors", async () => {
    const yaml = "summary: missing name and version";
    const res = await app.request("/api/agents/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
