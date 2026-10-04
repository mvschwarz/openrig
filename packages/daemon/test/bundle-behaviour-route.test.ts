import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { pack } from "../src/domain/bundle-archive.js";
import { bundleRoutes } from "../src/routes/bundles.js";

const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("bundle behaviour through the existing inspect route", () => {
  it("returns archive facts before any bootstrap or runtime requirement probe", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-view-route-"));
    owned.push(root);
    const staging = path.join(root, "staging");
    fs.mkdirSync(staging);
    const rig = "name: demo\nversion: '1'\npods:\n- id: build\n  members:\n  - {id: shell, agent_ref: 'builtin:terminal', profile: none, runtime: terminal, cwd: .}\n";
    fs.writeFileSync(path.join(staging, "rig.yaml"), rig);
    fs.writeFileSync(path.join(staging, "bundle.yaml"), stringify({
      schema_version: 2, name: "demo", version: "1", created_at: "2026-01-01T00:00:00Z", rig_spec: "rig.yaml", agents: [],
      integrity: { algorithm: "sha256", files: { "rig.yaml": createHash("sha256").update(rig).digest("hex") } },
    }));
    const archive = path.join(root, "demo.rigbundle");
    await pack(staging, archive);
    const forbidden = vi.fn(() => { throw new Error("The view touched bootstrap or a runtime probe"); });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("bootstrapRepo" as never, { createRun: forbidden } as never);
      c.set("bootstrapOrchestrator" as never, { bootstrap: forbidden } as never);
      c.set("probeRegistry" as never, { probeAll: forbidden } as never);
      await next();
    });
    app.route("/api/bundles", bundleRoutes);
    const response = await app.request("/api/bundles/inspect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundlePath: archive }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.digestValid).toBe(true);
    expect(result.integrityResult.passed).toBe(true);
    expect(result.behaviour).toMatchObject({
      schema: "openrig.bundle-behaviour/v1", state: "generated", team: [{ seat: "build.shell", runtime: "terminal" }],
    });
    expect(forbidden).not.toHaveBeenCalled();
  });
});
