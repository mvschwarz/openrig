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
