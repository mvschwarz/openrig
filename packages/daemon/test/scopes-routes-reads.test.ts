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

function appWith(root: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: root } as never);
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
