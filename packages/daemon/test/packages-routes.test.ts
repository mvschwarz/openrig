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
    expect(claudeMd).toContain("<!-- BEGIN RIGGED MANAGED BLOCK: guidance-pkg -->");
    expect(claudeMd).toContain("<!-- END RIGGED MANAGED BLOCK: guidance-pkg -->");
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
});
