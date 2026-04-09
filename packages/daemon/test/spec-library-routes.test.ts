import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { specLibraryRoutes } from "../src/routes/spec-library.js";

const VALID_RIG_YAML = `
version: "0.2"
name: lib-rig
summary: A library rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        runtime: claude-code
        profile: default
        cwd: /tmp
    edges: []
edges: []
`;

describe("spec library routes", () => {
  let tmpDir: string;
  let lib: SpecLibraryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spec-lib-routes-"));
    writeFileSync(join(tmpDir, "rig.yaml"), VALID_RIG_YAML);
    const svc = new SpecReviewService();
    lib = new SpecLibraryService({
      roots: [{ path: tmpDir, sourceType: "user_file" }],
      specReviewService: svc,
    });
    lib.scan();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createApp(): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("specLibraryService" as never, lib);
      c.set("specReviewService" as never, new SpecReviewService());
      await next();
    });
    app.route("/api/specs/library", specLibraryRoutes());
    return app;
  }

  it("GET /api/specs/library returns library entries", async () => {
    const app = createApp();
    const res = await app.request("/api/specs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ kind: string; name: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.kind).toBe("rig");
    expect(body[0]!.name).toBe("lib-rig");
  });

  it("GET /api/specs/library/:id returns entry + YAML content", async () => {
    const app = createApp();
    const entries = lib.list();
    const id = entries[0]!.id;
    const res = await app.request(`/api/specs/library/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entry: { name: string }; yaml: string };
    expect(body.entry.name).toBe("lib-rig");
    expect(body.yaml).toContain("lib-rig");
  });

  it("GET /api/specs/library/:id/review returns review with library provenance", async () => {
    const app = createApp();
    const entries = lib.list();
    const id = entries[0]!.id;
    const res = await app.request(`/api/specs/library/${id}/review`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sourceState: string; libraryEntryId: string; sourcePath: string; name: string };
    expect(body.sourceState).toBe("library_item");
    expect(body.libraryEntryId).toBe(id);
    expect(body.sourcePath).toContain("rig.yaml");
    expect(body.name).toBe("lib-rig");
  });

  it("POST /api/specs/library/sync rescans and returns updated list", async () => {
    const app = createApp();
    // Write a new file
    writeFileSync(join(tmpDir, "new-rig.yaml"), VALID_RIG_YAML.replace("lib-rig", "new-rig"));
    const res = await app.request("/api/specs/library/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ name: string }>;
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  it("DELETE /api/specs/library/:id removes a user-file entry", async () => {
    const app = createApp();
    const id = lib.list()[0]!.id;

    const res = await app.request(`/api/specs/library/${id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("lib-rig");

    const listRes = await app.request("/api/specs/library");
    const entries = await listRes.json() as Array<{ id: string }>;
    expect(entries).toHaveLength(0);
  });

  it("POST /api/specs/library/:id/rename renames a user-file entry and updates YAML name", async () => {
    const app = createApp();
    const id = lib.list()[0]!.id;

    const res = await app.request(`/api/specs/library/${id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-rig" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; entry: { name: string; sourcePath: string } };
    expect(body.ok).toBe(true);
    expect(body.entry.name).toBe("renamed-rig");

    const listRes = await app.request("/api/specs/library");
    const entries = await listRes.json() as Array<{ name: string; sourcePath: string }>;
    expect(entries[0]!.name).toBe("renamed-rig");
    expect(entries[0]!.sourcePath).toContain("renamed-rig");

    const yaml = readFileSync(entries[0]!.sourcePath, "utf-8");
    expect(yaml).toContain("name: renamed-rig");
  });

  it("GET /api/specs/library/:id/review returns composePreview for service-backed rigs", async () => {
    const svcDir = join(tmpDir, "rigs", "launch", "svc-rig");
    mkdirSync(svcDir, { recursive: true });
    writeFileSync(join(svcDir, "rig.yaml"), `
version: "0.2"
name: svc-rig
summary: A service rig

services:
  kind: compose
  compose_file: svc.compose.yaml
  project_name: svc-test
  down_policy: down
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
        cwd: /tmp
    edges: []
edges: []
`);
    writeFileSync(join(svcDir, "svc.compose.yaml"), `
version: "3.8"
services:
  vault:
    image: hashicorp/vault:1.15
    ports:
      - "8200:8200"
  redis:
    image: redis:7
    ports:
      - "6379:6379"
`);

    const svc = new SpecReviewService();
    const svcLib = new SpecLibraryService({
      roots: [{ path: tmpDir, sourceType: "user_file" }],
      specReviewService: svc,
    });
    svcLib.scan();

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("specLibraryService" as never, svcLib);
      c.set("specReviewService" as never, svc);
      await next();
    });
    app.route("/api/specs/library", specLibraryRoutes());

    const entries = svcLib.list({ kind: "rig" });
    const svcEntry = entries.find((e) => e.name === "svc-rig");
    expect(svcEntry).toBeDefined();

    const res = await app.request(`/api/specs/library/${svcEntry!.id}/review`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["name"]).toBe("svc-rig");

    const services = body["services"] as Record<string, unknown>;
    expect(services).toBeDefined();
    expect(services["kind"]).toBe("compose");

    const preview = services["composePreview"] as { services: Array<{ name: string; image?: string }> };
    expect(preview).toBeDefined();
    expect(preview.services).toHaveLength(2);
    const names = preview.services.map((s) => s.name);
    expect(names).toContain("vault");
    expect(names).toContain("redis");
    const vaultSvc = preview.services.find((s) => s.name === "vault");
    expect(vaultSvc!.image).toBe("hashicorp/vault:1.15");
  });
});
