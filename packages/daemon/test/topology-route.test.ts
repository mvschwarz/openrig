// OPR.0.4.4.11 — routes/up.ts topology branch (S11-6).
//
// Pins: the branch classifies through the REAL router, validates through the
// real manifest module, resolves path-form entries against the MANIFEST dir,
// drives the injected orchestrator seams (the same public bootstrap() +
// tryAcquire/release pair), rejects host-flag+topology on the public write
// path (R11-2 daemon side), and returns the honest closed aggregate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";
import { upRoutes } from "../src/routes/up.js";
import { UpCommandRouter } from "../src/domain/up-command-router.js";

const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

function realFsOps() {
  return {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readHead: (p: string, bytes: number) => {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, 0);
      fs.closeSync(fd);
      return buf;
    },
  };
}

interface BootstrapCall {
  sourceRef: string;
  sourceKind: string;
  autoApprove?: boolean;
}

function makeApp(opts: { bootstrapResult?: (call: BootstrapCall) => { status: string; errors: string[] } } = {}) {
  const calls: BootstrapCall[] = [];
  const locks: string[] = [];
  const orchestrator = {
    tryAcquire: (ref: string) => {
      locks.push(`acquire:${ref}`);
      return true;
    },
    release: (ref: string) => {
      locks.push(`release:${ref}`);
    },
    bootstrap: async (o: BootstrapCall & Record<string, unknown>) => {
      calls.push({ sourceRef: o.sourceRef, sourceKind: o.sourceKind, autoApprove: o.autoApprove as boolean | undefined });
      const shaped = opts.bootstrapResult?.(o) ?? { status: "completed", errors: [] };
      return { runId: "run-1", rigId: "rig-1", stages: [], warnings: [], ...shaped };
    },
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("bootstrapOrchestrator", orchestrator);
    set("bootstrapRepo", {});
    set("eventBus", { emit: () => {} });
    set("upRouter", new UpCommandRouter({ fsOps: realFsOps() }));
    set("rigRepo", {});
    await next();
  });
  app.route("/api/up", upRoutes);
  return { app, calls, locks };
}

describe("POST /api/up — topology branch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topo-route-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(content: string, name = "factory.rigtopology"): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("launches an all-local topology through the injected bootstrap seam; entries resolve against the MANIFEST dir; 200 + closed aggregate", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    fs.writeFileSync(path.join(tmpDir, "b.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n  - source: ./b.yaml\n");
    const { app, calls, locks } = makeApp();

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest, autoApprove: true }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["ok"]).toBe(true);
    expect(data["topology"]).toBe(manifest);
    expect(data["entries"]).toEqual([
      { rigRef: "./a.yaml", host: "local", status: "ok" },
      { rigRef: "./b.yaml", host: "local", status: "ok" },
    ]);
    // The leaf was INVOKED with manifest-dir-resolved refs + the request's autoApprove.
    expect(calls).toEqual([
      { sourceRef: path.join(tmpDir, "a.yaml"), sourceKind: "rig_spec", autoApprove: true },
      { sourceRef: path.join(tmpDir, "b.yaml"), sourceKind: "rig_spec", autoApprove: true },
    ]);
    // Route-side lock discipline per entry (guard G-2), sequential order —
    // and the lock key IS the launched ref (guard F1): a concurrent
    // standalone `rig up <resolved path>` shares this exact lock domain.
    expect(locks).toEqual([
      `acquire:${path.join(tmpDir, "a.yaml")}`,
      `release:${path.join(tmpDir, "a.yaml")}`,
      `acquire:${path.join(tmpDir, "b.yaml")}`,
      `release:${path.join(tmpDir, "b.yaml")}`,
    ]);
    // Invariant, explicitly: every acquired key equals a bootstrapped sourceRef.
    const acquired = locks.filter((l) => l.startsWith("acquire:")).map((l) => l.slice("acquire:".length));
    expect(acquired).toEqual(calls.map((c) => c.sourceRef));
  });

  it("a request that carries envOverride is answered as it is without one (the field is not read for a topology)", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n");
    const send = async (extra: Record<string, unknown>) => {
      const { app, calls } = makeApp();
      const res = await app.request("/api/up", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: manifest, autoApprove: true, ...extra }),
      });
      return { status: res.status, body: await res.json(), calls };
    };
    const baseline = await send({});
    expect(baseline.status).toBe(200);
    expect(await send({ envOverride: { DEBUG: "1" } })).toEqual(baseline);
  });

  it("R11-2 daemon side: host flag + topology source → 400 naming per-entry host: (public write path)", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest, host: "vps-b" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("host_flag_topology");
    expect(String(data["error"])).toContain("per-entry 'host:'");
    expect(calls).toEqual([]); // nothing launched
  });

  it("invalid manifest → 400 invalid_topology_manifest with the per-entry errors (edge key names the non-goal)", async () => {
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\nedges:\n  - from: a\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("invalid_topology_manifest");
    expect(String((data["errors"] as string[])[0])).toContain("founder-ratified non-goal");
    expect(calls).toEqual([]);
  });

  it("failed entry → 500 with the honest partial aggregate (ok + failed + explicit skipped)", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    fs.writeFileSync(path.join(tmpDir, "bad.yaml"), VALID_SPEC);
    fs.writeFileSync(path.join(tmpDir, "c.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n  - source: ./bad.yaml\n  - source: ./c.yaml\n");
    const { app } = makeApp({
      bootstrapResult: (call) =>
        call.sourceRef.endsWith("bad.yaml") ? { status: "failed", errors: ["Stage IMPORT_RIG failed: boom"] } : { status: "completed", errors: [] },
    });
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { ok: boolean; entries: Array<Record<string, unknown>> };
    expect(data.ok).toBe(false);
    expect(data.entries[0]).toMatchObject({ status: "ok" });
    expect(data.entries[1]).toMatchObject({ status: "failed", error: "Stage IMPORT_RIG failed: boom" });
    expect(data.entries[2]).toMatchObject({ status: "skipped" }); // explicit, never absent
  });

  it("plan + topology → 400 topology_plan_unsupported (no silent half-support)", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n");
    const { app } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest, plan: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("topology_plan_unsupported");
  });

  it("bare-name entry rejects at PARSE time (arch ruling: spec paths only) — 400, nothing launched", async () => {
    const manifest = writeManifest("rigs:\n  - source: some-existing-rig\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("invalid_topology_manifest");
    expect(String((data["errors"] as string[])[0])).toContain("bare library/rig name");
    expect(String((data["errors"] as string[])[0])).toContain("rig up some-existing-rig");
    expect(calls).toEqual([]); // bootstrap never invoked
  });

  it(".rigbundle entry rejects at PARSE time with the direct single-rig rig-up workaround — 400, nothing launched", async () => {
    const manifest = writeManifest("rigs:\n  - source: ./workers.rigbundle\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("invalid_topology_manifest");
    expect(String((data["errors"] as string[])[0])).toContain("single-rig 'rig up ./workers.rigbundle' accepts all source kinds unchanged");
    expect(calls).toEqual([]);
  });
});
