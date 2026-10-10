import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import type { StatusDeps } from "../src/commands/status.js";
import { importGitHubBundle, prepareGitHubBundle } from "../src/lib/bundle-source.js";

vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => "synthetic-instance" }));
vi.mock("../src/host-selection.js", () => ({ resolveEffectiveHost: () => undefined }));
vi.mock("../src/daemon-lifecycle.js", () => ({ getDaemonStatus: async () => ({ state: "running", healthy: true }), getDaemonUrl: () => "http://fixture.invalid" }));

// Regression from review-r2: real import -> create -> archive, with only fetch/locality faked.
describe("GitHub legacy package containment", () => {
  for (const outside of [true, false]) {
    it.each(["absolute", "relative", "local", "include"])(`${outside ? "refuses outside" : "builds contained"} legacy package: %s`, async mode => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-link-fixture-"));
      const imports = path.join(root, "imports");
      const marker = outside ? "SYNTHETIC_OUTSIDE_PACKAGE_BYTES" : "REPOSITORY_PACKAGE_BYTES";
      const sha = "a".repeat(40);
      const db = createDb();
      try {
        migrate(db, ALL_MIGRATIONS);
        const app = createTestApp(db).app;
        let creates = 0;
        let outputPath = "";
        let includePackages: string[] | undefined;
        const client = {
          get: async () => ({ status: 200, data: { selfHostId: "synthetic-instance" } }),
          post: async (route: string, body: Record<string, unknown>) => {
            if (route === "/api/bundles/create") { creates++; outputPath = body.outputPath as string; }
            const res = await app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            return { status: res.status, data: await res.json() };
          },
        };
        const git = async (checkout: string, args: string[]) => {
          if (args[0] === "ls-remote") return `${sha}\tHEAD\n${sha}\trefs/heads/main\n`;
          if (args[0] === "rev-parse") return sha;
          if (args[0] === "checkout") {
            const folder = path.join(checkout, "rigs/dev");
            const pkg = outside ? path.join(root, "host-package") : path.join(checkout, "packages/shared");
            fs.mkdirSync(folder, { recursive: true });
            fs.mkdirSync(path.join(pkg, "skills/helper"), { recursive: true });
            fs.writeFileSync(path.join(pkg, "package.yaml"), 'schema_version: 1\nname: fixture-package\nversion: "1.0.0"\nsummary: Synthetic fixture\ncompatibility:\n  runtimes: [claude-code]\nexports:\n  skills:\n    - source: skills/helper\n      name: helper\n      supported_scopes: [project_shared]\n      default_scope: project_shared\n');
            fs.writeFileSync(path.join(pkg, "skills/helper/SKILL.md"), marker);
            const ref = mode === "relative" ? path.relative(folder, pkg) : mode === "local" ? `local:${path.relative(folder, pkg)}` : pkg;
            if (mode === "include") includePackages = [ref];
            fs.writeFileSync(path.join(folder, "rig.yaml"), `schema_version: 1\nname: legacy-link-fixture\nversion: "1.0"\nnodes:\n  - id: dev\n    runtime: claude-code\n    package_refs: ${JSON.stringify(mode === "include" ? [] : [ref])}\nedges: []\n`);
          }
          return "";
        };
        // Preparation runs inside import; expose the CLI option only after the synthetic checkout selects its path.
        const opts: { includePackages?: string[] } = {};
        let result: Awaited<ReturnType<typeof importGitHubBundle>> | undefined;
        let error: unknown;
        try {
          result = await importGitHubBundle("https://github.com/example/fixture/tree/main/rigs/dev",
            { lifecycleDeps: {}, clientFactory: () => client } as unknown as StatusDeps, opts, async link => {
              const prepared = await prepareGitHubBundle(link, git, imports);
              opts.includePackages = includePackages;
              return prepared;
            });
        } catch (err) { error = err; }
        let copied = false;
        if (outputPath && fs.existsSync(outputPath)) {
          const extracted = path.join(root, "extracted"); fs.mkdirSync(extracted);
          await tar.x({ file: outputPath, cwd: extracted });
          const file = path.join(extracted, "packages/fixture-package/skills/helper/SKILL.md");
          copied = fs.existsSync(file) && fs.readFileSync(file, "utf8") === marker;
        }
        if (outside) {
          expect(copied, "outside package bytes must not reach the archive").toBe(false);
          expect(creates).toBe(0);
          expect(String(error)).toMatch(/refs must resolve inside the fetched repository/);
          expect(fs.readdirSync(imports)).toEqual([]);
        } else {
          expect(error).toBeUndefined();
          expect(result?.res.status, JSON.stringify(result?.res.data)).toBe(201);
          expect(creates).toBe(1);
          expect(copied).toBe(true);
          const inspected = await client.post("/api/bundles/inspect", { bundlePath: result!.bundlePath });
          expect(inspected.status).toBe(200);
          for (const key of ["source", "configurationId", "packageDigest", "archiveHash", "assembler"]) {
            expect(inspected.data[key]).toEqual(result!.res.data[key]);
          }
        }
      } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
