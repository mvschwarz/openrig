import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { packageDigest } from "../src/domain/bundle-identity.js";

const SHA = "a".repeat(40);
const source = { repository: "https://github.com/example/team", folder: "rig", requestedRef: "main", resolvedCommit: SHA, canonicalUrl: `https://github.com/example/team/tree/${SHA}/rig` };
const spec = `version: "0.2"
name: source-identity-fixture
docs: [{path: README.md}]
pods:
  - id: infra
    label: Infrastructure
    members:
      - { id: shell, runtime: terminal, agent_ref: "builtin:terminal", profile: none, cwd: "." }
    edges: []
edges: []
`;

describe("bundle source and artifact identity", () => {
  let root: string;
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-identity-route-"));
    fs.writeFileSync(path.join(root, "rig.yaml"), spec);
    fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
    db = createDb(); migrate(db, ALL_MIGRATIONS); app = createTestApp(db).app;
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  async function post(route: string, data: Record<string, unknown>) {
    const res = await app.request(`/api/bundles/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    return { status: res.status, data: await res.json() };
  }
  function body(name: string, extra: Record<string, unknown> = {}) {
    return { specPath: path.join(root, "rig.yaml"), bundleName: "fixture", bundleVersion: "1.0.0", outputPath: path.join(root, `${name}.rigbundle`), provenance: { source }, ...extra };
  }

  it("create and inspect name the same source/configuration/package/assembler; manifest changes do not change file digest", async () => {
    const first = await post("create", body("one"));
    expect(first.status, JSON.stringify(first.data)).toBe(201);
    expect(first.data).toMatchObject({ source, configurationId: "infra.shell=terminal", assembler: { openrigVersion: expect.any(String) } });
    const second = await post("create", body("two", { provenance: { source: { ...source, requestedRef: "v1" }, notes: "second metadata" } }));
    expect(second.status).toBe(201);
    expect(second.data.packageDigest).toEqual(first.data.packageDigest);
    expect(second.data.archiveHash).not.toBe(first.data.archiveHash);
    const inspected = await post("inspect", { bundlePath: path.join(root, "one.rigbundle") });
    expect(inspected.status).toBe(200);
    for (const key of ["source", "configurationId", "packageDigest", "archiveHash", "assembler"]) expect(inspected.data[key]).toEqual(first.data[key]);
    expect(inspected.data.manifest.provenance.source).toEqual(source);
    expect(inspected.data.packageDigest).toEqual(packageDigest(inspected.data.manifest.integrity.files));
    expect(inspected.data.integrityResult.passed).toBe(true);
  });

  it("checks the configuration ID against the actual spec, not a caller's label", async () => {
    const res = await post("create", body("bad", { configuration: { id: "infra.shell=codex" } }));
    expect(res.status, JSON.stringify(res.data)).toBe(400); expect(res.data.error).toBe("Configuration ID does not match the packaged rig spec"); expect(fs.existsSync(path.join(root, "bad.rigbundle"))).toBe(false);
  });

  it("author minima reach the manifest and the existing install check before bootstrap", async () => {
    const created = await post("create", body("min", { compatibility: { minCliVersion: "99.0.0", minDaemonVersion: "99.0.0" } }));
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const bundlePath = path.join(root, "min.rigbundle");
    const inspected = await post("inspect", { bundlePath });
    expect(inspected.data.manifest.compatibility).toMatchObject({ minCliVersion: "99.0.0", minDaemonVersion: "99.0.0" });
    const installed = await post("install", { bundlePath, plan: true, cliVersion: "0.6.6" });
    expect(installed.status).toBe(400);
    expect(installed.data.error).toBe("Bundle compatibility check failed");
  });

  it("rejects malformed source attribution without printing a supplied credential", async () => {
    const res = await post("create", body("bad-source", { provenance: { source: { ...source, repository: "https://SECRET@github.com/example/team" } } }));
    expect(res.status).toBe(400); expect(JSON.stringify(res.data)).not.toContain("SECRET");
  });
});
