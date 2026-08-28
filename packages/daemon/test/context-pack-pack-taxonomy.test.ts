// OPR.0.5.6.10 — pack-level taxonomy (WORLD / LORE / SKILLS / MISSION becomes
// first-class on EVERY pack, not only the one pack that declares atoms).
//
// Mini-req 1: every manifest declares a pack-level `taxonomy` from the ONE
// shared enum (ATOM_TAXONOMIES — imported, never a second literal list).
// Mini-req 2: a missing or non-enum value fails LOUD at parse time with a
// teaching error that names the field, lists the legal values, and says one
// sentence about what each value means.
// Mini-req 5: atom-level taxonomy is unchanged and may differ per atom.
// Mini-req 6: `lore` admits with zero code change beyond this slice (slice 08's
// seam, proven open).

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { ATOM_TAXONOMIES, ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

const manifestWith = (taxonomyLine: string) => `
name: probe-pack
version: 1
purpose: taxonomy probe
${taxonomyLine}
files:
  - path: notes.md
    role: notes
`;

describe("pack-level taxonomy — the teaching refusal (proof contract NEGATIVE 1)", () => {
  it("refuses a manifest with no taxonomy, naming the field and every legal value", () => {
    expect(() => parseManifest(manifestWith(""), "/t/manifest.yaml")).toThrow(ContextPackError);
    try {
      parseManifest(manifestWith(""), "/t/manifest.yaml");
      expect.unreachable("unstamped pack must not parse");
    } catch (err) {
      const e = err as ContextPackError;
      expect(e.code).toBe("manifest_invalid");
      expect(e.message).toContain("'taxonomy'");
      // Every legal value is listed — the error is the migration instruction.
      for (const value of ATOM_TAXONOMIES) expect(e.message).toContain(value);
      // One sentence of meaning per value (the coining-session definitions).
      expect(e.message).toContain("where you are");
      expect(e.message).toContain("what has been learned here");
      expect(e.message).toContain("what you know how to do");
      expect(e.message).toContain("what you are doing now");
      // The exact one line the author must add.
      expect(e.message).toMatch(/taxonomy: /);
    }
  });
});

describe("pack-level taxonomy — bad value (proof contract NEGATIVE 2)", () => {
  it("refuses taxonomy: doctrine with the same teaching shape", () => {
    try {
      parseManifest(manifestWith("taxonomy: doctrine"), "/t/manifest.yaml");
      expect.unreachable("non-enum taxonomy must not parse");
    } catch (err) {
      const e = err as ContextPackError;
      expect(e.code).toBe("manifest_invalid");
      expect(e.message).toContain("doctrine");
      for (const value of ATOM_TAXONOMIES) expect(e.message).toContain(value);
      expect(e.message).toContain("where you are");
      expect(e.message).toContain("what has been learned here");
      expect(e.message).toContain("what you know how to do");
      expect(e.message).toContain("what you are doing now");
    }
  });

  it("refuses a non-string taxonomy", () => {
    expect(() => parseManifest(manifestWith("taxonomy: [world]"), "/t/manifest.yaml")).toThrow(/taxonomy/);
  });
});

describe("pack-level taxonomy — admission", () => {
  it("admits every value of the one shared enum", () => {
    for (const value of ATOM_TAXONOMIES) {
      const m = parseManifest(manifestWith(`taxonomy: ${value}`), "/t/manifest.yaml");
      expect(m.taxonomy).toBe(value);
    }
  });

  it("admits taxonomy: lore with no code change beyond this slice (proof contract LORE ADMITS)", () => {
    const m = parseManifest(manifestWith("taxonomy: lore"), "/t/manifest.yaml");
    expect(m.taxonomy).toBe("lore");
  });
});

describe("pack-level vs atom-level taxonomy (mini-req 5: they may differ; nothing overrides)", () => {
  it("an atoms-bearing pack is not required to be uniform", () => {
    const manifest = `
name: mixed-pack
version: 1
taxonomy: world
files:
  - path: guide.md
    role: instruction
atoms:
  - id: how-to
    address: guide.md
    taxonomy: skills
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
`;
    const m = parseManifest(manifest, "/t/manifest.yaml");
    expect(m.taxonomy).toBe("world");
    expect(m.atoms?.[0]?.taxonomy).toBe("skills");
  });
});

describe("library entry projection (mini-req 4: derivable by command, list --json field)", () => {
  const pack = (taxonomyLine: string) => `
name: projected
version: 1
${taxonomyLine}
files:
  - path: notes.md
    role: notes
`;

  it("projects the pack taxonomy onto the library entry", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pack-taxonomy-"));
    try {
      const dir = join(tmp, "projected");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.yaml"), pack("taxonomy: lore"));
      writeFileSync(join(dir, "notes.md"), "# notes\n");
      const lib = new ContextPackLibraryService({ roots: [{ path: tmp, sourceType: "user_file" }] });
      const result = lib.scan();
      expect(result.errors).toEqual([]);
      expect(lib.list()[0]!.taxonomy).toBe("lore");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("composeFromFiles stamps taxonomy: mission — its own output must pass its own parser (desk ruling on qitem-20260828092429-d2f94323; caller-supplied value deferred to slice 08)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pack-taxonomy-"));
    try {
      const src = join(tmp, "src.md");
      writeFileSync(src, "# brief\n");
      const root = join(tmp, "root");
      mkdirSync(root, { recursive: true });
      const lib = new ContextPackLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
      lib.scan();
      const result = lib.composeFromFiles({
        outRef: "packs/probe-brief",
        sources: [{ path: src, label: "src.md" }],
      });
      expect(result.entry.taxonomy).toBe("mission");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses an unstamped pack at scan — fail-visible error, never indexed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pack-taxonomy-"));
    try {
      const dir = join(tmp, "unstamped");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.yaml"), pack(""));
      writeFileSync(join(dir, "notes.md"), "# notes\n");
      const lib = new ContextPackLibraryService({ roots: [{ path: tmp, sourceType: "user_file" }] });
      const result = lib.scan();
      expect(result.count).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toContain("taxonomy");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
