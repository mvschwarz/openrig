// Rig Context / Composable Context Injection v0 (PL-014) — manifest
// parser unit tests.

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

const validManifest = `
name: pl-005-priming
version: 1
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
    const m = parseManifest("name: x\nversion: 2\nfiles: []", "/x.yaml");
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
    expect(() => parseManifest("name: x\nversion: 1\nfiles: not-an-array", "/x.yaml")).toThrow(/files/);
  });

  it("rejects file entry with .. in path (escape attempt)", () => {
    const bad = "name: x\nversion: 1\nfiles:\n  - path: ../escape.md\n    role: notes\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/relative path inside the pack/);
  });

  it("rejects file entry with absolute path", () => {
    const bad = "name: x\nversion: 1\nfiles:\n  - path: /etc/passwd\n    role: notes\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/relative path inside the pack/);
  });

  it("rejects file entry with unsupported suffix", () => {
    const bad = "name: x\nversion: 1\nfiles:\n  - path: code.ts\n    role: code\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/unsupported suffix/);
  });

  it("rejects file entry missing role", () => {
    const bad = "name: x\nversion: 1\nfiles:\n  - path: notes.md\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/missing 'role'/);
  });

  it("accepts allowed suffixes md/markdown/yaml/yml/txt", () => {
    const ok = `name: x
version: 1
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

  it("ignores estimated_tokens when not a finite number", () => {
    const m = parseManifest("name: x\nversion: 1\nfiles: []\nestimated_tokens: 'not-a-number'", "/x.yaml");
    expect(m.estimatedTokens).toBeUndefined();
  });
});
