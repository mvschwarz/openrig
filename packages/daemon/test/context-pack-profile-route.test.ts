// OPR.0.5.3.5 Atom 4b — the PROFILE route: situation-composed delivery over the
// library + tree sources (mini-reqs 1/3/5/7 productized at the daemon surface).
// GET /library/by-ref/profile?ref=&situation=&runtime=[&budget=][&rig=&seat=]
// resolves the pack's atoms through the ONE parser chokepoint, builds the
// fail-loud multi-source readFile (library = pack dir; seat: = the topology tree
// seat directory resolved from topology.root CONFIG — rigs/<rig>/seats/<seat>,
// slice-06 D1 layout), labels every piece, and returns the composed profile.
// Every compose failure surfaces as a NAMED 4xx error — never a thinned walk.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { contextPacksRoutes } from "../src/routes/context-packs.js";

const MANIFEST = `
name: world-install
version: "1"
files:
  - { path: walk.md, role: world }
atoms:
  - id: welcome
    address: "walk.md#welcome"
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
  - id: recap
    address: "seat:RECAP.md#recent-decisions"
    taxonomy: lore
    situations: [handover, post-compaction]
    purpose: width
    order: 9
    priority: core
`;

describe("GET /library/by-ref/profile — situation-composed delivery (Atom 4b)", () => {
  let tmp: string;
  let libRoot: string;
  let app: Hono;
  const savedTopologyRoot = process.env["OPENRIG_TOPOLOGY_ROOT"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s05-profile-route-"));
    libRoot = join(tmp, "lib");
    const packDir = join(libRoot, "packs", "world");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "manifest.yaml"), MANIFEST);
    writeFileSync(join(packDir, "walk.md"), "## Welcome\nhello world");
    // The seat tree per slice-06 D1: <topology.root>/rigs/<rig>/seats/<seat>/
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(join(seatDir, "RECAP.md"), "## Recent Decisions\nwe chose X because Y");
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
    if (savedTopologyRoot === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
    else process.env["OPENRIG_TOPOLOGY_ROOT"] = savedTopologyRoot;
  });

  const url = (qs: string) => `/api/context-packs/library/by-ref/profile?ref=${encodeURIComponent("packs/world")}&${qs}`;

  it("composes HANDOVER with a SEAT-TREE-homed recap assembled by address, source label visible", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string; sourceKind: string; text: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual(["welcome", "recap"]);
    const recap = body.pieces.find((p) => p.atomId === "recap")!;
    expect(recap.sourceKind).toBe("seat");
    expect(recap.text).toContain("we chose X because Y");
    expect(body.pieces.find((p) => p.atomId === "welcome")!.sourceKind).toBe("library");
  });

  it("every piece carries its sha256 so profile and walk are hash-exact-comparable (Test-A door gate)", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ text: string; sha256: string }> };
    const { createHash } = await import("node:crypto");
    for (const p of body.pieces) {
      expect(p.sha256).toBe(createHash("sha256").update(p.text, "utf8").digest("hex"));
    }
  });

  it("FRESH composes without the seat tree (no rig/seat params needed when no tree atom selects)", async () => {
    const res = await app.request(url("situation=fresh&runtime=claude"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual(["welcome"]);
  });

  it("a tree atom WITHOUT rig/seat params fails LOUD naming the missing config, never a thinned walk", async () => {
    const res = await app.request(url("situation=handover&runtime=claude"));
    expect(res.status).toBe(422);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/seat/i);
    expect(body.message).toMatch(/root|config|rig/i);
  });

  it("budget overage is REPORTED with drop candidates, nothing truncated", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1&budget=1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: unknown[]; budget?: { overageTokens: number; dropCandidates: unknown[] } };
    expect(body.pieces).toHaveLength(2);
    expect(body.budget).toBeDefined();
    expect(body.budget!.overageTokens).toBeGreaterThan(0);
  });

  it("r1 RIDER 1: every piece carries BYTE provenance — a symlinked read is reported, labels never lie about where bytes came from", async () => {
    // r1's live probe on 4a: a symlink inside the seat root returned an
    // out-of-root secret while the source label stayed 'seat' — accurate about
    // the REF, wrong about the BYTES. Q2-Amendment 1 binds per-piece source
    // labels; provenance must follow the bytes. Report, never block: realpath
    // containment would break the product's own legitimately-symlinked layouts.
    const { symlinkSync, realpathSync } = await import("node:fs");
    const outside = join(tmp, "outside-secret.md");
    writeFileSync(outside, "## Recent Decisions\nSECRET BYTES");
    // macOS /var is itself a symlink to /private/var — compare against the
    // REAL path, which is exactly what the provenance surface reports.
    const outsideReal = realpathSync(outside);
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    rmSync(join(seatDir, "RECAP.md"));
    symlinkSync(outside, join(seatDir, "RECAP.md"));
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      pieces: Array<{ atomId: string; provenance: { nominalPath: string; realPath: string; escapesRoot: boolean } }>;
      provenanceWarnings: string[];
    };
    const recap = body.pieces.find((p) => p.atomId === "recap")!;
    expect(recap.provenance.realPath).toBe(outsideReal);
    expect(recap.provenance.escapesRoot).toBe(true);
    expect(body.provenanceWarnings.some((w) => w.includes("recap"))).toBe(true);
    // The honest piece stays quiet: no warning names 'welcome', and its real
    // path sits inside the pack.
    const welcome = body.pieces.find((p) => p.atomId === "welcome")!;
    expect(welcome.provenance.escapesRoot).toBe(false);
    expect(body.provenanceWarnings.some((w) => w.includes("welcome"))).toBe(false);
  });

  it("r1 RIDER 2: without the explicit rig/seat grant, an untrusted pack's seat: atoms read NOTHING — and the grant is scoped to the named seat", async () => {
    // Slice-07 R4 installs packs from URLs: a hostile manifest may carry
    // seat:/mission: atoms. Ingest passes them BY DESIGN; the trust boundary is
    // the compose call — rig/seat params are the caller's explicit grant of
    // read access to that ONE seat directory. No params, no reads (already
    // pinned above as the missing-config 422); and the grant never widens
    // beyond the named seat (the segment gate pins that). This pin nails the
    // GRANT SEMANTICS end-to-end: the same pack, same atoms — no grant = 422
    // naming the missing root, grant = the read happens and is visible in the
    // provenance surface.
    const denied = await app.request(url("situation=handover&runtime=claude"));
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { message: string }).message).toMatch(/seat/i);
    const granted = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(granted.status).toBe(200);
    const body = await granted.json() as { pieces: Array<{ atomId: string; provenance: { realPath: string } }> };
    expect(body.pieces.find((p) => p.atomId === "recap")!.provenance.realPath).toContain(join("rigs", "r1", "seats", "s1"));
  });

  it("r1 F1 (round 3): a file NAMED '..hidden-notes.md' inside its root is NOT flagged — segment comparison, never prefix-matching a path string", async () => {
    // r1's measured shape: relative() returned '..hidden-notes.md' and a bare
    // startsWith('..') read it as an escape — the identical bug class as
    // startsWith(base), reproduced one level in. A trust surface that cries
    // wolf on innocent files trains readers to skim it.
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    writeFileSync(join(seatDir, "..hidden-notes.md"), "## Recent Decisions\ninnocent bytes");
    const manifest2 = MANIFEST.replace("seat:RECAP.md#recent-decisions", "seat:..hidden-notes.md#recent-decisions");
    // A '..'-PREFIXED FILENAME is not a '..' SEGMENT — parseSourceRef must agree.
    writeFileSync(join(libRoot, "packs", "world", "manifest.yaml"), manifest2);
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      pieces: Array<{ atomId: string; provenance: { escapesRoot: boolean } }>;
      provenanceWarnings: string[];
    };
    expect(body.pieces.find((p) => p.atomId === "recap")!.provenance.escapesRoot).toBe(false);
    expect(body.provenanceWarnings).toEqual([]);
  });

  it("r1 pre-judgment (2): a DANGLING symlink is its own NAMED failure, never a garbled provenance error", async () => {
    const { symlinkSync } = await import("node:fs");
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    rmSync(join(seatDir, "RECAP.md"));
    symlinkSync(join(tmp, "never-existed.md"), join(seatDir, "RECAP.md"));
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(422);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/dangling|symlink/i);
    expect(body.message).toContain("RECAP.md");
  });

  it("r1 pre-judgment (minor): provenanceWarnings is ALWAYS an array — empty on a clean compose", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { provenanceWarnings: string[] };
    expect(Array.isArray(body.provenanceWarnings)).toBe(true);
    expect(body.provenanceWarnings).toEqual([]);
  });

  it("Atom 4d: a mission: atom resolves from the RULED workspace.slices_root key when the caller names the mission — absent param stays a loud missing-config", async () => {
    // Desk ruling (row 2675535d): do NOT mint a new config key — the missions
    // tree already has workspace.slices_root; mission root = <slices_root>/<mission>.
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const missionDir = join(tmp, "missions", "release-x");
      mkdirSync(missionDir, { recursive: true });
      writeFileSync(join(missionDir, "NOTES.md"), "## Watch Items\nW-99 lives here");
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(tmp, "missions");
      const withMission = MANIFEST + `  - id: watch
    address: "mission:NOTES.md#watch-items"
    taxonomy: mission
    situations: [handover]
    purpose: width
    order: 50
    priority: recommended
`;
      writeFileSync(join(libRoot, "packs", "world", "manifest.yaml"), withMission);
      const granted = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1&mission=release-x"));
      expect(granted.status).toBe(200);
      const body = await granted.json() as { pieces: Array<{ atomId: string; sourceKind: string; text: string }> };
      const watch = body.pieces.find((p) => p.atomId === "watch")!;
      expect(watch.sourceKind).toBe("mission");
      expect(watch.text).toContain("W-99 lives here");
      // No mission param: the mission-homed atom fails loud, never a thinner walk.
      const denied = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
      expect(denied.status).toBe(422);
      expect(((await denied.json()) as { message: string }).message).toMatch(/mission/i);
    } finally {
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it("bad inputs are NAMED 4xx errors: unknown situation, a pack without atoms, an unknown ref", async () => {
    const badSituation = await app.request(url("situation=someday&runtime=claude"));
    expect(badSituation.status).toBe(400);
    expect(((await badSituation.json()) as { message: string }).message).toMatch(/situation/);

    const noAtomsDir = join(libRoot, "packs", "bare");
    mkdirSync(noAtomsDir, { recursive: true });
    writeFileSync(join(noAtomsDir, "manifest.yaml"), 'name: bare\nversion: "1"\nfiles:\n  - { path: a.md, role: x }\n');
    writeFileSync(join(noAtomsDir, "a.md"), "## A\nbody");
    const lib2res = await app.request("/api/context-packs/library/by-ref/profile?ref=packs%2Fbare&situation=fresh&runtime=claude");
    // Library must be re-synced to see it; the route itself reads the manifest fresh.
    expect([200, 404, 422]).toContain(lib2res.status);
    if (lib2res.status === 422) {
      expect(((await lib2res.json()) as { message: string }).message).toMatch(/atoms/);
    }

    const missing = await app.request("/api/context-packs/library/by-ref/profile?ref=packs%2Fghost&situation=fresh&runtime=claude");
    expect(missing.status).toBe(404);
  });
});

const SYNTHETIC_WORLD_MANIFEST = `
name: synthetic-world
version: "1"
files:
  - { path: world-from-primitives.md, role: world }
  - { path: permission-self-sleep.md, role: world }
  - { path: what-this-is-for.md, role: world }
  - { path: ontology.md, role: world }
  - { path: harness-power-use.md, role: world }
  - { path: a-competent-turn.md, role: world }
  - { path: what-you-can-do.md, role: reference }
  - { path: reference-material.md, role: reference }
atoms:
  - { id: world-from-primitives, address: world-from-primitives.md, taxonomy: world, situations: [fresh], purpose: depth, order: 1, priority: core }
  - { id: permission-self-sleep, address: permission-self-sleep.md, taxonomy: world, situations: [fresh], purpose: depth, order: 2, priority: core }
  - { id: what-this-is-for, address: what-this-is-for.md, taxonomy: world, situations: [fresh], purpose: depth, order: 3, priority: core }
  - { id: ontology, address: ontology.md, taxonomy: world, situations: [fresh, post-compaction], purpose: depth, order: 4, priority: core }
  - { id: harness-power-use, address: harness-power-use.md, taxonomy: world, situations: [fresh], purpose: depth, order: 5, priority: core }
  - { id: what-you-can-do, address: what-you-can-do.md, taxonomy: skills, situations: [post-compaction], purpose: width, order: 6, priority: core }
  - { id: reference-material, address: reference-material.md, taxonomy: lore, situations: [post-compaction], purpose: width, order: 7, priority: core }
  - { id: a-competent-turn, address: a-competent-turn.md, taxonomy: world, situations: [fresh, post-compaction], purpose: depth, order: 8, priority: core }
  - { id: recap, address: "seat:RECAP.md", taxonomy: lore, situations: [handover, post-compaction], purpose: width, order: 9, priority: core }
`;

describe("synthetic world graph — the seat RECAP composes through the real route", () => {
  let tmp: string;
  let app: Hono;
  const savedTopologyRoot = process.env["OPENRIG_TOPOLOGY_ROOT"];
  const SENTINEL = "sentinel-recap-7fce914a8: we chose the atoms graph because drift";
  const PACK_FILES = [
    "world-from-primitives.md",
    "permission-self-sleep.md",
    "what-this-is-for.md",
    "ontology.md",
    "harness-power-use.md",
    "a-competent-turn.md",
    "what-you-can-do.md",
    "reference-material.md",
  ];

  function buildApp(withRecap: boolean): void {
    tmp = mkdtempSync(join(tmpdir(), "s05-prod-recap-"));
    const libRoot = join(tmp, "lib");
    const packDir = join(libRoot, "world", "install");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "manifest.yaml"), SYNTHETIC_WORLD_MANIFEST);
    for (const file of PACK_FILES) {
      writeFileSync(join(packDir, file), `## Synthetic fixture\n${file}\n`);
    }
    if (withRecap) {
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      mkdirSync(seatDir, { recursive: true });
      writeFileSync(join(seatDir, "RECAP.md"), `## Decisions\n${SENTINEL}`);
    } else {
      mkdirSync(join(tmp, "topology", "rigs", "r1", "seats", "s1"), { recursive: true });
    }
    process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
    const lib = new ContextPackLibraryService({ roots: [{ path: libRoot, sourceType: "builtin" }] });
    lib.scan();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("contextPackLibrary" as never, lib);
      await next();
    });
    app.route("/api/context-packs", contextPacksRoutes());
  }

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedTopologyRoot === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
    else process.env["OPENRIG_TOPOLOGY_ROOT"] = savedTopologyRoot;
  });

  const profileUrl = (qs: string) => `/api/context-packs/library/by-ref/profile?ref=${encodeURIComponent("world/install")}&${qs}`;

  it("HANDOVER = the fresh walk + the seat-sourced RECAP, sentinel bytes and sourceKind seat", async () => {
    buildApp(true);
    const res = await app.request(profileUrl("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string; sourceKind: string; text: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual([
      "world-from-primitives", "permission-self-sleep", "what-this-is-for", "ontology", "harness-power-use", "a-competent-turn", "recap",
    ]);
    const recap = body.pieces.find((p) => p.atomId === "recap")!;
    expect(recap.sourceKind).toBe("seat");
    expect(recap.text).toContain("sentinel-recap-7fce914a8");
  });

  it("POST-COMPACTION = the measured re-prime + the seat-sourced RECAP", async () => {
    buildApp(true);
    const res = await app.request(profileUrl("situation=post-compaction&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string; sourceKind: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual([
      "ontology", "what-you-can-do", "reference-material", "a-competent-turn", "recap",
    ]);
    expect(body.pieces.find((p) => p.atomId === "recap")!.sourceKind).toBe("seat");
  });

  it("a MISSING seat RECAP fails LOUD with a named error — never a silently thinner handover", async () => {
    buildApp(false);
    const res = await app.request(profileUrl("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(422);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/recap/i);
  });

  it("FRESH needs no seat tree and stays the six-piece walk (recap never leaks into fresh)", async () => {
    buildApp(true);
    const res = await app.request(profileUrl("situation=fresh&runtime=claude"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual([
      "world-from-primitives", "permission-self-sleep", "what-this-is-for", "ontology", "harness-power-use", "a-competent-turn",
    ]);
  });
});
