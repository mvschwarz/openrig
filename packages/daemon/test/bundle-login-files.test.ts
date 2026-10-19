import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { computeIntegrity, isSensitivePath, verifyIntegrity } from "../src/domain/bundle-integrity.js";
import { pack, unpack } from "../src/domain/bundle-archive.js";
import { normalizeLegacyBundleManifest, serializeLegacyBundleManifest, validateLegacyBundleManifest, validatePodBundleManifest } from "../src/domain/bundle-types.js";
import { PodBundleSourceResolver } from "../src/domain/bundle-source-resolver.js";
import { stringify } from "yaml";
import { LOGIN_FILES, author, existingArchive, expectLoginMessage, integrityFs, put } from "./helpers/bundle-login-fixture.js";

// This policy test crosses the real archive/bootstrap boundary, with provider checks explicitly inert.
vi.mock("../src/domain/rigspec-preflight.js", async original => ({
  ...await original<object>(), rigPreflight: async () => ({ ready: true, errors: [], warnings: [] }),
}));

describe("known harness login paths in selected bundle content", () => {
  let root: string, db: Database.Database, harness: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-login-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS); harness = createTestApp(db);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const post = (url: string, body: unknown) => harness.app.request(`/api/bundles/${url}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it.each(LOGIN_FILES)("matches %s only as a complete root or nested path", file => {
    for (const prefix of ["", "agents/worker/", "project/nested/"]) expect(isSensitivePath(prefix + file)).toBe(true);
    for (const lookalike of ["auth.json", ".codex/config.toml", file + ".example", file.replaceAll("/", "-"), "prefix" + file]) {
      expect(isSensitivePath(lookalike), lookalike).toBe(false);
    }
  });

  for (const source of ["agent", "project"] as const) {
    it.each(LOGIN_FILES)(`create refuses a %s carried through the ${source} tree, without emitting an archive`, async file => {
      const folder = path.join(root, "source"); const specPath = author(folder);
      const carried = path.join(root, "carried"); put(carried, "project.yaml", "id: fixture-project\n");
      put(source === "agent" ? path.join(folder, "agents/worker") : carried, `nested/${file}`);
      const outputPath = path.join(root, "out.rigbundle");
      const res = await post("create", { specPath, bundleName: "fixture", bundleVersion: "1.0", outputPath,
        ...(source === "project" ? { projectDir: carried } : {}) });
      expect(res.status).toBe(500);
      const body = await res.json(); expectLoginMessage(body.error, file);
      expect(fs.existsSync(outputPath)).toBe(false); expect(fs.existsSync(outputPath + ".sha256")).toBe(false);
    });
  }

  it("the existing shared verifier names every login file and its remedy", async () => {
    const f = await existingArchive(root);
    expect(() => computeIntegrity(f.staging, integrityFs)).toThrow(/harness login file/i);
    const result = verifyIntegrity(f.staging, { integrity: f.integrity } as never, integrityFs);
    expect(result.passed).toBe(false);
    for (const file of LOGIN_FILES) expectLoginMessage(result.errors.join("\n"), file);
  });

  it("unpack and install refuse a previously valid archive before bootstrap, even with unrelated override flags", async () => {
    const f = await existingArchive(root);
    const error = await unpack(f.archive, path.join(root, "unpacked")).then(() => "", error => error.message);
    for (const file of LOGIN_FILES) expectLoginMessage(error, file);
    const bootstrap = vi.spyOn(harness.bootstrapOrchestrator, "bootstrap");
    const res = await post("install", { bundlePath: f.archive, plan: true, force: true, skipVersionCheck: true });
    expect(res.status).toBe(400);
    const body = await res.json(); for (const file of LOGIN_FILES) expectLoginMessage(body.detail, file);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("inspection remains diagnostic but reports failed verification with every actionable reason", async () => {
    const f = await existingArchive(root);
    const res = await post("inspect", { bundlePath: f.archive }); expect(res.status).toBe(200);
    const body = await res.json(); expect(body.digestValid).toBe(true); expect(body.integrityResult.passed).toBe(false);
    for (const file of LOGIN_FILES) expectLoginMessage(body.integrityResult.errors.join("\n"), file);
    expect(body.behaviour.identity.integrity.filesVerified).toBe(false);
  });

  it("ordinary auth.json and non-login harness files still create, verify and unpack unchanged", async () => {
    const files = ["auth.json", "other/auth.json", ".codex/config.toml", ".claude/settings.json", ".pi/agent/settings.json", ".codex-auth.json"];
    const f = await existingArchive(root, files);
    const integrity = computeIntegrity(f.staging, integrityFs); expect(integrity).toEqual(f.integrity);
    const result = verifyIntegrity(f.staging, { integrity: f.integrity } as never, integrityFs); expect(result.passed).toBe(true);
    const extracted = path.join(root, "clean"); await unpack(f.archive, extracted);
    for (const file of files) expect(fs.readFileSync(path.join(extracted, file))).toEqual(fs.readFileSync(path.join(f.staging, file)));
  });

  it.each(["agent", "project"])("explicit create records only actual exact login files from the %s tree; consumers need no repeated flag", async source => {
    const folder = path.join(root, "source"); const specPath = author(folder);
    const carried = path.join(root, "carried"); put(carried, "project.yaml", "id: fixture-project\n");
    for (const file of LOGIN_FILES) put(source === "agent" ? path.join(folder, "agents/worker") : carried, `nested/${file}`);
    const outputPath = path.join(root, "intentional.rigbundle");
    const created = await post("create", { specPath, outputPath, bundleName: "fixture", bundleVersion: "1.0", includeLoginFiles: true,
      ...(source === "project" ? { projectDir: carried } : {}) });
    expect(created.status).toBe(201); const creation = await created.json();
    for (const file of LOGIN_FILES) expectLoginMessage(creation.warning ?? "", file);
    const extracted = path.join(root, "intentional");
    const unpacked = await unpack(outputPath, extracted);
    const manifest = parse(fs.readFileSync(path.join(extracted, "bundle.yaml"), "utf8"));
    const expected = LOGIN_FILES.map(file => `${source === "agent" ? "agents/worker/nested" : "project/nested"}/${file}`).sort();
    expect(manifest.included_login_files).toEqual(expected);
    for (const file of LOGIN_FILES) expectLoginMessage(JSON.stringify(unpacked), file);
    const inspected = await (await post("inspect", { bundlePath: outputPath })).json();
    expect(inspected.integrityResult.passed).toBe(true); expect(inspected.manifest.includedLoginFiles).toEqual(expected);
    for (const file of LOGIN_FILES) expectLoginMessage(inspected.integrityResult.warnings.join("\n"), file);
    const bootstrap = vi.spyOn(harness.bootstrapOrchestrator, "bootstrap").mockResolvedValue({ status: "planned", runId: "fixture", stages: [] } as never);
    const installed = await post("install", { bundlePath: outputPath, plan: true });
    expect(installed.status).toBe(200); expect(bootstrap).toHaveBeenCalledOnce();
    const plan = await installed.json(); for (const file of LOGIN_FILES) expectLoginMessage(plan.warnings.join("\n"), file);
  });

  it.each([null, true, "*", ["*"], ["agents/*/.codex/auth.json"], ["agents/worker/.codex"], ["../.codex/auth.json"], ["/.codex/auth.json"], [".codex/auth.json", ".codex/auth.json"]])(
    "rejects a malformed or non-exact login record: %j", async record => {
      const f = await existingArchive(root, undefined, record);
      const result = verifyIntegrity(f.staging, { integrity: f.integrity, includedLoginFiles: record } as never, integrityFs);
      expect(result.passed).toBe(false); expect(result.errors.join("\n")).toMatch(/included_login_files/);
      await expect(unpack(f.archive, path.join(root, "bad-record"))).rejects.toThrow(/included_login_files/);
      const inspected = await (await post("inspect", { bundlePath: f.archive })).json();
      expect(inspected.error || inspected.integrityResult?.errors.join("\n")).toMatch(/included_login_files/);
    });

  it.each([1, 2] as const)("v%s inspect keeps a malformed login record diagnostic", async schemaVersion => {
    const f = await existingArchive(root, undefined, true, schemaVersion);
    const response = await post("inspect", { bundlePath: f.archive });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.digestValid).toBe(true);
    expect(body.error).toMatch(/included_login_files/);
  });

  it("an additional unrecorded login file still fails every consumer", async () => {
    const paths = LOGIN_FILES.map(file => `agents/worker/${file}`);
    const f = await existingArchive(root, paths, paths.slice(0, 2));
    const result = verifyIntegrity(f.staging, { integrity: f.integrity, includedLoginFiles: paths.slice(0, 2) } as never, integrityFs);
    expect(result.passed).toBe(false); expectLoginMessage(result.errors.join("\n"), LOGIN_FILES[2]!);
    await expect(unpack(f.archive, path.join(root, "unlisted"))).rejects.toThrow(LOGIN_FILES[2]);
    const installed = await post("install", { bundlePath: f.archive, plan: true, force: true, skipVersionCheck: true });
    expect(installed.status).toBe(400);
    const inspected = await (await post("inspect", { bundlePath: f.archive })).json(); expect(inspected.integrityResult.passed).toBe(false);
  });

  it("the explicit login option does not exempt unrelated sensitive files", async () => {
    const folder = path.join(root, "source"); const specPath = author(folder);
    put(folder, "agents/worker/.codex/auth.json"); put(folder, "agents/worker/.env", "SYNTHETIC_ENV_ONLY");
    const outputPath = path.join(root, "still-refused.rigbundle");
    const res = await post("create", { specPath, outputPath, bundleName: "fixture", bundleVersion: "1.0", includeLoginFiles: true });
    expect(res.status).toBe(500); expect(JSON.stringify(await res.json())).toContain(".env"); expect(fs.existsSync(outputPath)).toBe(false);
  });
  it("the login record cannot exempt an existing sensitive-path rule", () => {
    const file = "node_modules/.codex/auth.json";
    const folder = path.join(root, "other-sensitive"); put(folder, file);
    expect(() => computeIntegrity(folder, integrityFs, [file])).toThrow(/Sensitive/);
  });

  it("the actual bootstrap plan carries a credential-bearing notice without another flag", async () => {
    const paths = LOGIN_FILES.map(file => `agents/worker/${file}`);
    const f = await existingArchive(root, paths, paths);
    const result = await harness.bootstrapOrchestrator.bootstrap({ mode: "plan", sourceRef: f.archive, sourceKind: "rig_bundle" });
    expect(result.status).toBe("planned");
    // The test app's execution adapters are inert; this asserts the shared pre-materialisation consumer.
    for (const file of LOGIN_FILES) expectLoginMessage(result.warnings.join("\n"), file);
  });

  it("legacy manifests retain exact records through normalisation, serialization and consumers", async () => {
    const paths = LOGIN_FILES.map(file => `agents/worker/${file}`);
    const f = await existingArchive(root, paths, paths, 1);
    const raw = parse(fs.readFileSync(path.join(f.staging, "bundle.yaml"), "utf8"));
    expect(validateLegacyBundleManifest(raw).valid).toBe(true);
    expect(parse(serializeLegacyBundleManifest(normalizeLegacyBundleManifest(raw))).included_login_files).toEqual(paths);
    const unpacked = await unpack(f.archive, path.join(root, "legacy-unpacked"));
    for (const file of LOGIN_FILES) expectLoginMessage(unpacked!.warnings.join("\n"), file);
    const inspected = await (await post("inspect", { bundlePath: f.archive })).json();
    expect(inspected.integrityResult.passed).toBe(true); expect(inspected.manifest.includedLoginFiles).toEqual(paths);
    delete raw.included_login_files;
    put(f.staging, "bundle.yaml", stringify(raw)); await pack(f.staging, f.archive);
    await expect(unpack(f.archive, path.join(root, "legacy-default"))).rejects.toThrow(/harness login file/);
  });

  it("the pod resolver retains the declaration and file bytes", async () => {
    const paths = LOGIN_FILES.map(file => `agents/worker/${file}`);
    const f = await existingArchive(root, paths, paths);
    const resolver = new PodBundleSourceResolver(); const resolved = await resolver.resolve(f.archive);
    try {
      expect(resolved.manifest.includedLoginFiles).toEqual(paths);
      for (const file of paths) expect(fs.readFileSync(path.join(resolved.tempDir, file))).toEqual(fs.readFileSync(path.join(f.staging, file)));
    } finally { resolver.cleanup(resolved.tempDir); }
  });

  it("a declaration does not waive missing content or hash checks", async () => {
    const paths = LOGIN_FILES.map(file => `agents/worker/${file}`);
    const f = await existingArchive(root, paths, paths);
    put(f.staging, paths[0]!, "SYNTHETIC_CHANGED_ONLY");
    fs.unlinkSync(path.join(f.staging, paths[1]!));
    const checked = verifyIntegrity(f.staging, { integrity: f.integrity, includedLoginFiles: paths } as never, integrityFs);
    expect(checked.passed).toBe(false); expect(checked.mismatches).toContain(paths[0]); expect(checked.missing).toContain(paths[1]);
    const invalid = verifyIntegrity(f.staging, { integrity: f.integrity, includedLoginFiles: ["missing/.codex/auth.json"] } as never, integrityFs);
    expect(invalid.passed).toBe(false); expect(invalid.errors.join("\n")).toContain("not covered by integrity");
    for (const validator of [validateLegacyBundleManifest, validatePodBundleManifest]) {
      expect(validator({ included_login_files: ["../.codex/auth.json"] }).errors.join("\n")).toContain("included_login_files");
    }
  });

  it("legacy create defaults to refusal and the explicit flag records its actual paths", async () => {
    const folder = path.join(root, "legacy-source");
    put(folder, "rig.yaml", 'schema_version: 1\nname: legacy\nversion: "1.0"\nnodes:\n  - id: dev\n    runtime: claude-code\n    package_refs: ["./pkg"]\nedges: []\n');
    put(folder, "pkg/package.yaml", 'schema_version: 1\nname: pkg\nversion: "1.0.0"\nsummary: Fixture\ncompatibility:\n  runtimes: [claude-code]\nexports:\n  skills:\n    - source: skills/demo\n      name: demo\n      supported_scopes: [project_shared]\n      default_scope: project_shared\n');
    put(folder, "pkg/skills/demo/SKILL.md", "# Synthetic fixture");
    for (const file of LOGIN_FILES) put(folder, `pkg/nested/${file}`);
    const outputPath = path.join(root, "legacy.rigbundle");
    const body = { specPath: path.join(folder, "rig.yaml"), outputPath, bundleName: "fixture", bundleVersion: "1.0" };
    expect((await post("create", { ...body, includeLoginFiles: "true" })).status).toBe(500);
    expect(fs.existsSync(outputPath)).toBe(false);
    const created = await post("create", { ...body, includeLoginFiles: true }); expect(created.status).toBe(201);
    const extracted = path.join(root, "legacy-created"); await unpack(outputPath, extracted);
    const manifest = parse(fs.readFileSync(path.join(extracted, "bundle.yaml"), "utf8"));
    expect(manifest.included_login_files).toEqual(LOGIN_FILES.map(file => `packages/pkg/nested/${file}`).sort());
  });

  it("ordinary install warnings retain their existing order and duplicates", async () => {
    const f = await existingArchive(root, ["auth.json"]);
    vi.spyOn(harness.bootstrapOrchestrator, "bootstrap").mockResolvedValue({ status: "completed", runId: "fixture", rigId: "fixture-rig", stages: [], warnings: ["ordinary warning", "ordinary warning"] } as never);
    vi.spyOn(harness.bootstrapOrchestrator, "routeBundleContents").mockResolvedValue({} as never);
    const response = await post("install", { bundlePath: f.archive, targetRoot: path.join(root, "inert-target") });
    expect(response.status).toBe(201);
    expect((await response.json()).warnings).toEqual(["ordinary warning", "ordinary warning"]);
  });

});
