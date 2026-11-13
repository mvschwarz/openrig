// /api/scopes reads only what the asked-for view returns. Every file read in this file's module graph is recorded.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((p: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
    reads.push(String(p));
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { scopesRoutes } = await import("../src/routes/scopes.js");

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopes-reads-"));
  for (const [mission, slice] of [["release-x", "01-thing"], ["release-x", "02-other"], ["release-y", "01-more"]] as const) {
    const sliceDir = path.join(root, mission, "slices", slice);
    fs.mkdirSync(path.join(sliceDir, "proof"), { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"),
      `---\nid: OPR.${slice}\nstatus: spec\nstage: building\napproved-spec-by: pm@x\napproved-spec-at: 2026-08-06T10:00:00.000Z\n---\n\n# ${slice}\n\n## Intent\n\nDo it.\n\n## Proof contract\n\n- [ ] Works — captured.\n`);
    fs.writeFileSync(path.join(sliceDir, "proof", "qa.md"), `---\nartifact_type: qa\nverdict: PASS\nevidences:\n  - "1"\n---\nx`);
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "narrative only");
  }
  return root;
}

function appWith(root: string, opts: { registry?: unknown; fetchImpl?: typeof fetch } = {}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: root } as never);
    if (opts.registry) c.set("hostRegistryLoader" as never, () => opts.registry);
    if (opts.fetchImpl) c.set("remoteFetchImpl" as never, opts.fetchImpl);
    await next();
  });
  app.route("/api/scopes", scopesRoutes());
  return app;
}

const byName = <T extends { mission?: string; dirName?: unknown }>(rows: T[], key: "mission" | "dirName", name: string): T => rows.find((r) => r[key] === name)!;
const under = (paths: string[], part: string) => paths.filter((p) => p.split(path.sep).includes(part) || p.endsWith(part));

describe("/api/scopes reads only what the view returns", () => {
  let root: string;
  beforeEach(() => { root = scaffold(); reads.length = 0; });

  it("counts=1 lists each slice's identity and status from its node file alone", async () => {
    const body = await (await appWith(root).request("/api/scopes?counts=1")).json() as {
      missions: Array<{ mission: string; slices: Array<Record<string, unknown>>; readiness?: unknown }>;
    };
    expect(body.missions.map((m) => [m.mission, m.slices.length]).sort()).toEqual([["release-x", 2], ["release-y", 1]]);
    expect(byName(byName(body.missions, "mission", "release-x").slices, "dirName", "01-thing")).toEqual({
      dirName: "01-thing", id: "OPR.01-thing", displayName: "01-thing", status: "spec", stage: "building",
      locks: { spec: { by: "pm@x", at: "2026-08-06T10:00:00.000Z" }, delivery: null },
    });
    expect(body.missions.every((m) => m.readiness === undefined)).toBe(true);
    // One read per slice, its node file: no proof drops, no PROGRESS.md, no readiness inputs.
    expect(reads.filter((p) => p.startsWith(root)).map((p) => path.relative(root, p)).sort()).toEqual([
      "release-x/slices/01-thing/README.md", "release-x/slices/02-other/README.md", "release-y/slices/01-more/README.md",
    ]);
  });

  it("the plain list keeps its shape and no longer reads the narrative it doesn't return", async () => {
    const body = await (await appWith(root).request("/api/scopes")).json() as {
      missions: Array<{ mission: string; slices: Array<Record<string, unknown>>; readiness: unknown }>;
    };
    const mission = byName(body.missions, "mission", "release-x");
    const slice = byName(mission.slices, "dirName", "01-thing");
    expect(slice).toMatchObject({ dirName: "01-thing", status: "spec", proof: { paired: 1, total: 1 } });
    expect(slice).toHaveProperty("readiness");
    expect(mission).toHaveProperty("readiness");
    expect(slice).not.toHaveProperty("narrative");
    expect(under(reads.filter((p) => p.startsWith(root)), "PROGRESS.md")).toEqual([]);
  });

  it("detail=1 still carries the narrative", async () => {
    const body = await (await appWith(root).request("/api/scopes?detail=1&counts=1")).json() as {
      missions: Array<{ mission: string; slices: Array<{ dirName: string; narrative: string | null; intent: string }> }>;
    };
    expect(byName(byName(body.missions, "mission", "release-x").slices, "dirName", "01-thing")).toMatchObject({ narrative: "narrative only", intent: "Do it." });
  });
});

// #3093 — the fleet Projects view's route: the LOCAL leg is the same counts projection the
// local list serves (one source of truth), and registry failures are stated, never hidden.
describe("GET /api/scopes/fleet — local leg + registry honesty", () => {
  let root: string;
  beforeEach(() => { root = scaffold(); reads.length = 0; });

  it("serves the local counts rows stamped with the local host, alongside every host's status", async () => {
    const body = await (await appWith(root, { registry: { ok: true, registry: { hosts: [] } } }).request("/api/scopes/fleet")).json() as {
      missions: Array<{ hostId: string; mission: string; slices: Array<Record<string, unknown>> }>;
      hosts: Array<{ hostId: string; status: string; observedAt: string; lastSuccessAt: string | null }>;
      registry: { state: string };
    };
    expect(body.registry).toEqual({ state: "read" });
    // The local row set is exactly what ?counts=1 serves: identity + status from the node file.
    const releaseX = byName(body.missions, "mission", "release-x");
    expect(byName(releaseX.slices, "dirName", "01-thing")).toMatchObject({ id: "OPR.01-thing", status: "spec", stage: "building" });
    expect(body.missions.map((m) => [m.mission, m.slices.length]).sort()).toEqual([["release-x", 2], ["release-y", 1]]);
    expect(new Set(body.missions.map((m) => m.hostId)).size).toBe(1);
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]).toMatchObject({ hostId: body.missions[0]!.hostId, status: "ok" });
    expect(body.hosts[0]!.lastSuccessAt).toBe(body.hosts[0]!.observedAt);
  });

  it("an unreadable registry keeps the local rows and says why no remote rows are shown", async () => {
    const body = await (await appWith(root, { registry: { ok: false, error: "hosts.yaml unreadable" } }).request("/api/scopes/fleet")).json() as {
      missions: unknown[]; registry: { state: string; error?: string };
    };
    expect(body.registry).toEqual({ state: "unreadable", error: "hosts.yaml unreadable" });
    expect(body.missions.length).toBe(2); // release-x, release-y — local rows intact
  });

  it("COLLIDING native ids from a remote host stay distinct rows, host-attributed", async () => {
    const remote = {
      ok: true,
      registry: { hosts: [{ id: "host-b", transport: "http" as const, url: "http://host-b:7433" }] },
    };
    // The remote serves the SAME mission/slice names as the local root.
    const fetchImpl = (async () => Response.json({
      missions: [{ mission: "release-x", slices: [{ dirName: "01-thing", id: "OPR.01-thing", displayName: "01-thing", status: "spec", stage: "building", locks: { spec: null, delivery: null } }] }],
      project: null,
    })) as typeof fetch;
    const body = await (await appWith(root, { registry: remote, fetchImpl }).request("/api/scopes/fleet")).json() as {
      missions: Array<{ hostId: string; mission: string; slices: Array<{ dirName: string; hostId: string }> }>;
      hosts: Array<{ hostId: string; status: string }>;
    };
    const releaseX = body.missions.filter((m) => m.mission === "release-x");
    expect(releaseX).toHaveLength(2); // local host + host-b, never merged
    expect(new Set(releaseX.map((m) => m.hostId)).size).toBe(2);
    expect(releaseX.map((m) => m.hostId)).toContain("host-b");
    expect(byName(releaseX, "hostId", "host-b").slices[0]).toMatchObject({ dirName: "01-thing", hostId: "host-b" });
    expect(body.hosts.find((h) => h.hostId === "host-b")?.status).toBe("ok");
  });
});
