// Rig Context / Composable Context Injection v0 (PL-014) — manifest
// parser unit tests.

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

const validManifest = `
name: pl-005-priming
version: 1
taxonomy: mission
purpose: Priming for PL-005 Phase A
files:
  - path: prd.md
    role: prd
    summary: Phase A PRD
  - path: proof.md
    role: proof-packet
estimated_tokens: 500
`;

describe("parseManifest", () => {
  it("parses a valid manifest into the typed shape", () => {
    const m = parseManifest(validManifest, "/test/manifest.yaml");
    expect(m.name).toBe("pl-005-priming");
    expect(m.version).toBe("1");
    expect(m.purpose).toContain("Priming for PL-005");
    expect(m.files).toHaveLength(2);
    expect(m.files[0]).toEqual({ path: "prd.md", role: "prd", summary: "Phase A PRD" });
    expect(m.files[1]).toEqual({ path: "proof.md", role: "proof-packet" });
    expect(m.estimatedTokens).toBe(500);
  });

  it("normalizes numeric versions to strings", () => {
    const m = parseManifest("name: x\nversion: 2\ntaxonomy: world\nfiles: []", "/x.yaml");
    expect(m.version).toBe("2");
  });

  it("rejects non-YAML content with manifest_parse_error", () => {
    expect(() => parseManifest("{not valid", "/x.yaml")).toThrow(ContextPackError);
    try {
      parseManifest("{not valid", "/x.yaml");
    } catch (err) {
      expect((err as ContextPackError).code).toBe("manifest_parse_error");
    }
  });

  it("rejects missing name", () => {
    expect(() => parseManifest("version: 1\nfiles: []", "/x.yaml")).toThrow(/name/);
  });

  it("rejects missing version", () => {
    expect(() => parseManifest("name: x\nfiles: []", "/x.yaml")).toThrow(/version/);
  });

  it("rejects malformed files array", () => {
    expect(() => parseManifest("name: x\nversion: 1\ntaxonomy: world\nfiles: not-an-array", "/x.yaml")).toThrow(/files/);
  });

  it("rejects file entry with .. in path (escape attempt)", () => {
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: ../escape.md\n    role: notes\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/relative path inside the pack/);
  });

  it("rejects file entry with absolute path", () => {
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: /etc/passwd\n    role: notes\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/relative path inside the pack/);
  });

  it("rejects file entry with unsupported suffix", () => {
    // .ts/.sh are now servable (OPR.0.5.3.7 R2 helper assets); a genuinely
    // unsupported suffix (e.g. a binary) still rejects loud.
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: image.png\n    role: code\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/unsupported suffix/);
  });

  it("rejects file entry missing role", () => {
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: notes.md\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/missing 'role'/);
  });

  it("accepts allowed suffixes md/markdown/yaml/yml/txt", () => {
    const ok = `name: x
version: 1
taxonomy: world
files:
  - { path: a.md, role: r }
  - { path: b.markdown, role: r }
  - { path: c.yaml, role: r }
  - { path: d.yml, role: r }
  - { path: e.txt, role: r }
`;
    const m = parseManifest(ok, "/x.yaml");
    expect(m.files).toHaveLength(5);
  });

  it("accepts inert UTF-8 script helpers with sh/ts/mjs/py suffixes", () => {
    const ok = `name: helpers
version: 1
taxonomy: skills
files:
  - { path: scripts/a.sh, role: reference }
  - { path: scripts/b.ts, role: reference }
  - { path: scripts/c.mjs, role: reference }
  - { path: scripts/d.py, role: reference }
`;
    const m = parseManifest(ok, "/helpers.yaml");
    expect(m.files.map((file) => file.path)).toEqual([
      "scripts/a.sh",
      "scripts/b.ts",
      "scripts/c.mjs",
      "scripts/d.py",
    ]);
  });

  it("ignores estimated_tokens when not a finite number", () => {
    const m = parseManifest("name: x\nversion: 1\ntaxonomy: world\nfiles: []\nestimated_tokens: 'not-a-number'", "/x.yaml");
    expect(m.estimatedTokens).toBeUndefined();
  });
});

// Slice-03 lineage repair (R2 terminal HIGH-2): the bounded, delimiter-free
// version predicate (ref-safety.isSafePackVersion) must be ENFORCED at parse —
// the ingestion chokepoint — not merely defined. A colon-bearing version forges
// a `<name>:<version>` store id; an overlong version breaches the OS filename
// bound (ENAMETOOLONG). Both are FIXED-IN-BUILD per the locked PRD and must be
// rejected live, not just by a unit predicate.
describe("parseManifest — bounded version predicate enforcement (R2 HIGH-2)", () => {
  it("rejects a colon-bearing version with manifest_invalid (delimiter forgery vector)", () => {
    expect(() => parseManifest("name: x\nversion: '1:0:0'\nfiles: []", "/x.yaml")).toThrow(ContextPackError);
    try {
      parseManifest("name: x\nversion: '1:0:0'\nfiles: []", "/x.yaml");
    } catch (err) {
      expect((err as ContextPackError).code).toBe("manifest_invalid");
      expect((err as Error).message).toMatch(/version/);
    }
  });

  it("rejects an overlong version (>32 chars → ENAMETOOLONG class)", () => {
    const long = "1" + "a".repeat(300);
    expect(() => parseManifest(`name: x\nversion: '${long}'\nfiles: []`, "/x.yaml")).toThrow(/version/);
  });

  it("still accepts a bounded delimiter-free version (dots/underscore/plus/hyphen allowed)", () => {
    const m = parseManifest("name: x\nversion: '1.2.0-rc.1+build_7'\ntaxonomy: world\nfiles: []", "/x.yaml");
    expect(m.version).toBe("1.2.0-rc.1+build_7");
  });
});
