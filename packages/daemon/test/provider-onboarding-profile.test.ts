import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { contextPacksRoutes } from "../src/routes/context-packs.js";

const MANIFEST = `
name: world-install
version: "1"
taxonomy: world
files:
  - { path: world.md, role: world }
  - { path: coverage.md, role: coverage-map }
atoms:
  - id: bootstrap
    address: world.md#bootstrap
    taxonomy: world
    situations: [fresh]
    purpose: width
    runtime: any
    order: 10
    priority: core
  - id: guided-reasoning
    address: world.md#guided-reasoning
    taxonomy: world
    situations: [fresh]
    purpose: depth
    runtime: any
    order: 20
    priority: recommended
  - id: coverage-map
    address: coverage.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    runtime: any
    order: 30
    priority: core
    profile_only: true
profiles:
  - id: codex-coverage
    situations: [fresh]
    runtimes: [codex]
    phases:
      - id: bootstrap
        atoms: [bootstrap]
      - id: project-mission-role-task
        context: [project, mission, seat, slice]
      - id: coverage-map
        atoms: [coverage-map]
  - id: guided
    situations: [fresh]
    runtimes: [claude, codex]
    phases:
      - id: guided-world
        atoms: [bootstrap, guided-reasoning]
      - id: project-mission-role-task
        context: [project, mission, seat, slice]
`;

describe("provider-shaped onboarding profiles", () => {
  let tmp: string;
  let app: Hono;
  const savedWorkspace = process.env["OPENRIG_WORKSPACE_ROOT"];
  const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
  const savedTopology = process.env["OPENRIG_TOPOLOGY_ROOT"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "provider-onboarding-profile-"));
    const libRoot = join(tmp, "lib");
    const packDir = join(libRoot, "world", "install");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "manifest.yaml"), MANIFEST);
    writeFileSync(join(packDir, "world.md"), [
      "## Bootstrap",
      "This is an OpenRig environment. Context is addressable.",
      "## Guided Reasoning",
      "The fuller walk explains why the operating model has this shape.",
      "## Proof Source",
      "Authoritative proof rule sentinel.",
    ].join("\n"));
    writeFileSync(join(packDir, "coverage.md"), [
      "# Coverage map",
      "- proof/review — `world/install/world.md#proof-source` — read when a task asks whether delivery evidence is sufficient.",
    ].join("\n"));

    const workspace = join(tmp, "workspace");
    const missionDir = join(workspace, "missions", "release-x");
    const sliceDir = join(missionDir, "slices", "08-provider-onboarding");
    mkdirSync(join(workspace, "context"), { recursive: true });
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(workspace, "SPEC.md"), "# Project\nProject intent sentinel");
    writeFileSync(join(workspace, "context", "authority.md"), "# Authority\nProject authority sentinel");
    writeFileSync(join(workspace, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
install:
  intent: SPEC.md
  context: [context/authority.md]
missions:
  root: missions
`);
    writeFileSync(join(missionDir, "SPEC.md"), "# Mission\nMission intent sentinel");
    writeFileSync(join(missionDir, "mission.yaml"), "schema: openrig.mission/v0alpha1\ncomposition: [OPR.X.8]\n");
    writeFileSync(join(missionDir, "PROGRESS.md"), "# Mission progress\nCurrent frontier sentinel");
    writeFileSync(join(sliceDir, "SPEC.md"), "# Task\nImmediate task sentinel");
    writeFileSync(join(sliceDir, "PROGRESS.md"), "# Task progress\nCurrent task state sentinel");
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "dev-guard");
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(join(seatDir, "LEARNED.md"), "# Role\nGuard role sentinel");

    process.env["OPENRIG_WORKSPACE_ROOT"] = workspace;
    process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(workspace, "missions");
    process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");

    const lib = new ContextPackLibraryService({ roots: [{ path: libRoot, sourceType: "user_file" }] });
    lib.scan();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("contextPackLibrary" as never, lib);
      await next();
    });
    app.route("/api/context-packs", contextPacksRoutes());
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedWorkspace === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
    else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspace;
    if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    if (savedTopology === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
    else process.env["OPENRIG_TOPOLOGY_ROOT"] = savedTopology;
  });

  const profileUrl = (profile: string, runtime = "codex") =>
    `/api/context-packs/library/by-ref/profile?ref=world%2Finstall&situation=fresh&runtime=${runtime}` +
    `&profile=${profile}&mission=release-x&slice=08-provider-onboarding&rig=r1&seat=dev-guard`;

  it("inspects the Codex bootstrap -> project/mission/role/task -> coverage-map sequence before delivery", async () => {
    const res = await app.request(profileUrl("codex-coverage"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      profileId: string;
      phases: Array<{ id: string; kind: string; sources?: string[]; estimatedTokens: number; pieces: Array<{ atomId: string; address: string; sourceKind: string; text: string; provenance: { nominalPath: string } }> }>;
      pieces: Array<{ atomId: string; phaseId: string; address: string; text: string }>;
      totalEstimatedTokens: number;
    };

    expect(body.profileId).toBe("codex-coverage");
    expect(body.phases.map((phase) => phase.id)).toEqual([
      "bootstrap",
      "project-mission-role-task",
      "coverage-map",
    ]);
    expect(body.phases.map((phase) => phase.kind)).toEqual(["atoms", "context", "atoms"]);
    expect(body.phases[1]?.sources).toEqual(["project", "mission", "seat", "slice"]);
    expect(body.phases[1]?.pieces.map((piece) => piece.sourceKind)).toEqual([
      "project",
      "project",
      "mission",
      "mission",
      "mission",
      "seat",
      "mission",
      "mission",
    ]);
    expect(body.phases[1]?.pieces.map((piece) => piece.text)).toEqual([
      "# Project\nProject intent sentinel",
      "# Authority\nProject authority sentinel",
      "# Mission\nMission intent sentinel",
      "schema: openrig.mission/v0alpha1\ncomposition: [OPR.X.8]\n",
      "# Mission progress\nCurrent frontier sentinel",
      "# Role\nGuard role sentinel",
      "# Task\nImmediate task sentinel",
      "# Task progress\nCurrent task state sentinel",
    ]);
    expect(body.pieces.map((piece) => piece.phaseId)).toEqual([
      "bootstrap",
      "project-mission-role-task",
      "project-mission-role-task",
      "project-mission-role-task",
      "project-mission-role-task",
      "project-mission-role-task",
      "project-mission-role-task",
      "project-mission-role-task",
      "project-mission-role-task",
      "coverage-map",
    ]);
    expect(body.phases.every((phase) => phase.estimatedTokens > 0)).toBe(true);
    expect(body.totalEstimatedTokens).toBe(body.phases.reduce((sum, phase) => sum + phase.estimatedTokens, 0));
    expect(body.pieces.every((piece) => piece.address.length > 0)).toBe(true);
    expect(body.phases[1]?.pieces.every((piece) => piece.provenance.nominalPath.length > 0)).toBe(true);
  });

  it("keeps the fuller guided profile selectable without copying its source", async () => {
    const coverageRes = await app.request(profileUrl("codex-coverage"));
    const guidedRes = await app.request(profileUrl("guided"));
    expect(coverageRes.status).toBe(200);
    expect(guidedRes.status).toBe(200);
    const coverage = await coverageRes.json() as { pieces: Array<{ atomId: string; sha256: string }> };
    const guided = await guidedRes.json() as { profileId: string; pieces: Array<{ atomId: string; sha256: string }> };
    expect(guided.profileId).toBe("guided");
    expect(guided.pieces.map((piece) => piece.atomId)).toContain("guided-reasoning");
    expect(guided.pieces.map((piece) => piece.atomId)).not.toContain("coverage-map");
    expect(guided.pieces.find((piece) => piece.atomId === "bootstrap")?.sha256)
      .toBe(coverage.pieces.find((piece) => piece.atomId === "bootstrap")?.sha256);
  });

  it("serves an exact authoritative section reached from the coverage map address", async () => {
    const profileRes = await app.request(profileUrl("codex-coverage"));
    expect(profileRes.status).toBe(200);
    const profile = await profileRes.json() as { pieces: Array<{ atomId: string; text: string }> };
    const map = profile.pieces.find((piece) => piece.atomId === "coverage-map")?.text ?? "";
    const address = map.match(/`([^`]+#proof-source)`/)?.[1];
    expect(address).toBe("world/install/world.md#proof-source");

    const getRes = await app.request(`/api/context-packs/library/resolve-address?address=${encodeURIComponent(address!)}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      address: "world/install/world.md#proof-source",
      text: "## Proof Source\nAuthoritative proof rule sentinel.",
    });
  });

  it("the map-removed negative control has no filename or source bytes to pass from", async () => {
    const negative = MANIFEST.replace([
      "      - id: coverage-map",
      "        atoms: [coverage-map]",
      "",
    ].join("\n"), "");
    const manifestPath = join(tmp, "lib", "world", "install", "manifest.yaml");
    writeFileSync(manifestPath, negative);
    const lib = new ContextPackLibraryService({ roots: [{ path: join(tmp, "lib"), sourceType: "user_file" }] });
    lib.scan();
    const negativeApp = new Hono();
    negativeApp.use("*", async (c, next) => {
      c.set("contextPackLibrary" as never, lib);
      await next();
    });
    negativeApp.route("/api/context-packs", contextPacksRoutes());

    const res = await negativeApp.request(profileUrl("codex-coverage"));
    expect(res.status).toBe(200);
    const body = await res.json() as { phases: Array<{ id: string }>; pieces: Array<{ atomId: string; text: string }> };
    expect(body.phases.map((phase) => phase.id)).toEqual(["bootstrap", "project-mission-role-task"]);
    expect(body.pieces.map((piece) => piece.atomId)).not.toContain("coverage-map");
    expect(body.pieces.map((piece) => piece.text).join("\n")).not.toContain("world/install/world.md#proof-source");
    expect(body.pieces.map((piece) => piece.text).join("\n")).not.toContain("Authoritative proof rule sentinel");
  });

  it("refuses an unknown profile, runtime mismatch, or missing situated-context grant", async () => {
    const unknown = await app.request(profileUrl("not-real"));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "profile_not_found" });

    const mismatch = await app.request(profileUrl("codex-coverage", "claude"));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: "profile_runtime_mismatch" });

    const missingSeat = await app.request(
      "/api/context-packs/library/by-ref/profile?ref=world%2Finstall&situation=fresh&runtime=codex" +
      "&profile=codex-coverage&mission=release-x&slice=08-provider-onboarding",
    );
    expect(missingSeat.status).toBe(400);
    expect(await missingSeat.json()).toMatchObject({ error: "profile_context_missing" });
  });
});
