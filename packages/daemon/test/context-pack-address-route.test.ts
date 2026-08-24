// OPR.0.5.3.5 Atom 4c — the ADDRESS-serving route: `name#H2/H3` through the rig
// context ref grammar (mini-req 6 / Q4). The daemon owns the WHOLE resolution —
// longest-prefix pack match, file within the pack, span within the file — so the
// CLI get verb and any future consumer share one resolver home. The addressable
// unit is the FILE per the locked grammar ("the file has an address, each H2
// under it"); the assembled bundle is NOT an address target (its `## File:`
// frame lines are themselves H2s — addressing it would collide by construction).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { contextPacksRoutes } from "../src/routes/context-packs.js";

const WALK = [
  "## Welcome",
  "hello world",
  "### Deeper",
  "nested body",
  "## Reference",
  "```",
  "## fenced-fake",
  "```",
  "ref body",
].join("\n");

describe("GET /library/resolve-address — file-level span serving (Atom 4c)", () => {
  let tmp: string;
  let app: Hono;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s05-addr-route-"));
    const libRoot = join(tmp, "lib");
    const packDir = join(libRoot, "packs", "world");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "manifest.yaml"), 'name: world-install\nversion: "1"\nfiles:\n  - { path: walk.md, role: world }\n  - { path: sub/notes.md, role: world }\n');
    writeFileSync(join(packDir, "walk.md"), WALK);
    mkdirSync(join(packDir, "sub"), { recursive: true });
    writeFileSync(join(packDir, "sub", "notes.md"), "## Notes\nnote body");
    const lib = new ContextPackLibraryService({ roots: [{ path: libRoot, sourceType: "user_file" }] });
    lib.scan();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("contextPackLibrary" as never, lib);
      await next();
    });
    app.route("/api/context-packs", contextPacksRoutes());
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const resolve = (address: string) =>
    app.request(`/api/context-packs/library/resolve-address?address=${encodeURIComponent(address)}`);

  it("resolves pack/file#H2 to the correct span (the mini-req 6 door shape)", async () => {
    const res = await resolve("packs/world/walk.md#welcome");
    expect(res.status).toBe(200);
    const body = await res.json() as { packRef: string; filePath: string; text: string };
    expect(body.packRef).toBe("packs/world");
    expect(body.filePath).toBe("walk.md");
    expect(body.text).toContain("hello world");
    expect(body.text).toContain("### Deeper"); // Q1 full span: children included
    expect(body.text).not.toContain("## Reference");
  });

  it("resolves a nested file and an H2/H3 depth address", async () => {
    const notes = await resolve("packs/world/sub/notes.md#notes");
    expect(notes.status).toBe(200);
    expect(((await notes.json()) as { text: string }).text).toContain("note body");
    const deep = await resolve("packs/world/walk.md#welcome/deeper");
    expect(deep.status).toBe(200);
    const deepBody = await deep.json() as { text: string };
    expect(deepBody.text).toContain("nested body");
    expect(deepBody.text).not.toContain("hello world");
  });

  it("a bare pack/file address (no #) serves the WHOLE file", async () => {
    const res = await resolve("packs/world/walk.md");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe(WALK);
  });

  it("an address inside a code fence does NOT resolve, and a no-match FAILS LOUD with candidates", async () => {
    const fenced = await resolve("packs/world/walk.md#fenced-fake");
    expect(fenced.status).toBe(422);
    const missing = await resolve("packs/world/walk.md#nope");
    expect(missing.status).toBe(422);
    const msg = ((await missing.json()) as { message: string }).message;
    expect(msg).toContain("nope");
    expect(msg).toContain("welcome"); // names the real candidates
  });

  it("r1 4c rec (1): the NO-NESTED-PACKS invariant the longest-prefix split borrows — a pack inside a pack dir is NOT indexed", async () => {
    // r1's A1 finding: the split is safe ONLY because the scanner never
    // recurses into a pack directory, so no pack ref can prefix another. That
    // invariant was enforced 200 lines away and asserted nowhere — this pin
    // converts the silent future break (sub-pack support) into a red test.
    const libRoot = join(tmp, "lib");
    const inner = join(libRoot, "packs", "world", "nested-pack");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "manifest.yaml"), 'name: nested\nversion: "1"\nfiles:\n  - { path: n.md, role: x }\n');
    writeFileSync(join(inner, "n.md"), "## N\nnested pack body");
    const lib2 = new ContextPackLibraryService({ roots: [{ path: libRoot, sourceType: "user_file" }] });
    lib2.scan();
    const refs = lib2.list().map((e) => e.relativePath);
    expect(refs).toContain("packs/world");
    expect(refs.some((r) => r.includes("nested-pack"))).toBe(false);
  });

  it("an unknown pack prefix and a file outside the pack both FAIL LOUD naming what was tried", async () => {
    const noPack = await resolve("packs/ghost/walk.md#welcome");
    expect(noPack.status).toBe(404);
    const noFile = await resolve("packs/world/ghost.md#welcome");
    expect(noFile.status).toBe(404);
    expect(((await noFile.json()) as { message: string }).message).toContain("ghost.md");
  });
});
