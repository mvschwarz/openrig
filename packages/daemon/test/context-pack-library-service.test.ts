// Rig Context / Composable Context Injection v0 (PL-014) — library
// service tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ContextPackLibraryService,
  contextPackId,
  estimateTokensFromBytes,
} from "../src/domain/context-packs/context-pack-library-service.js";

function writePack(root: string, name: string, manifest: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
}

describe("ContextPackLibraryService", () => {
  let tmp: string;
  let userRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-lib-"));
    userRoot = join(tmp, "user");
    workspaceRoot = join(tmp, "workspace");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("scans a pack and emits a normalized entry", () => {
    writePack(userRoot, "smoke", `
name: smoke
version: 1
taxonomy: world
purpose: Smoke pack
files:
  - path: notes.md
    role: notes
    summary: Smoke notes
`, { "notes.md": "# Smoke\n\nHello world." });

    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(1);
    expect(result.errors).toEqual([]);
    const entries = lib.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.id).toBe(contextPackId("smoke")); // id = context-pack:<ref>
    expect(entry.name).toBe("smoke");
    expect(entry.kind).toBe("context-pack");
    expect(entry.purpose).toBe("Smoke pack");
    expect(entry.files).toHaveLength(1);
    expect(entry.files[0]!.bytes).toBeGreaterThan(0);
    expect(entry.files[0]!.estimatedTokens).toBeGreaterThan(0);
    expect(entry.derivedEstimatedTokens).toBe(entry.files[0]!.estimatedTokens);
  });

  it("surfaces missing files with bytes=null instead of refusing the entry", () => {
    writePack(userRoot, "missing", `
name: missing
version: 1
taxonomy: world
files:
  - path: present.md
    role: r
  - path: absent.md
    role: r
`, { "present.md": "data" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const entry = lib.getByRef("missing")!;
    expect(entry).toBeDefined();
    const present = entry.files.find((f) => f.path === "present.md")!;
    const absent = entry.files.find((f) => f.path === "absent.md")!;
    expect(present.bytes).toBeGreaterThan(0);
    expect(absent.bytes).toBeNull();
    expect(absent.estimatedTokens).toBeNull();
  });

  it("workspace root wins on collision (last in roots array)", () => {
    const sameManifest = `
name: collision
version: 1
taxonomy: world
files:
  - path: notes.md
    role: r
`;
    writePack(userRoot, "collision", sameManifest, { "notes.md": "user content" });
    writePack(workspaceRoot, "collision", sameManifest, { "notes.md": "workspace content" });
    const lib = new ContextPackLibraryService({
      roots: [
        { path: userRoot, sourceType: "user_file" },
        { path: workspaceRoot, sourceType: "workspace" },
      ],
    });
    lib.scan();
    const entry = lib.getByRef("collision")!;
    expect(entry.sourceType).toBe("workspace");
    expect(entry.sourcePath).toContain("/workspace/");
  });

  // Slice-03 Atom 5 (colon-id strip, ruled contract §4) — the id is now
  // `context-pack:<ref>`, so two distinct refs that happen to share a manifest
  // name+version get DISTINCT ids and BOTH resolve. The legacy
  // `context-pack:<name>:<version>` id silently SHADOWED this case (the two refs
  // collapsed to one id in idIndex); the strip fixes that latent bug.
  it("distinct refs sharing a manifest name+version get DISTINCT ids and both resolve", () => {
    const sameManifest = `
name: dup
version: 1
taxonomy: world
files:
  - path: notes.md
    role: r
`;
    writePack(userRoot, "packs/a", sameManifest, { "notes.md": "A" });
    writePack(userRoot, "packs/b", sameManifest, { "notes.md": "B" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const a = lib.getByRef("packs/a");
    const b = lib.getByRef("packs/b");
    expect(a, "packs/a resolves").not.toBeNull();
    expect(b, "packs/b resolves").not.toBeNull();
    expect(a!.id).toBe("context-pack:packs/a");
    expect(b!.id).toBe("context-pack:packs/b");
    expect(a!.id).not.toBe(b!.id); // legacy name:version collapsed both to context-pack:dup:1
  });

  it("captures parse errors instead of throwing them out of scan", () => {
    writePack(userRoot, "broken", "{not valid yaml", { "notes.md": "x" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("manifest_parse_error");
  });

  it("ignores directories without manifest.yaml", () => {
    mkdirSync(join(userRoot, "not-a-pack"));
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(0);
  });

  it("re-scan reflects filesystem edits (workspace-surface reconciliation)", () => {
    writePack(userRoot, "evolve", `
name: evolve
version: 1
taxonomy: world
files:
  - path: a.md
    role: r
`, { "a.md": "initial" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    expect(lib.list()).toHaveLength(1);
    // Operator edits the manifest to bump version.
    writeFileSync(join(userRoot, "evolve", "manifest.yaml"), `
name: evolve
version: 2
taxonomy: world
files:
  - path: a.md
    role: r
`);
    lib.scan();
    const list = lib.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.version).toBe("2");
  });

  it("resolveFileWithinPack rejects path-traversal attempts", () => {
    writePack(userRoot, "guard", `
name: guard
version: 1
taxonomy: world
files:
  - path: notes.md
    role: r
`, { "notes.md": "x" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const entry = lib.getByRef("guard")!;
    expect(() => lib.resolveFileWithinPack(entry, "../etc/passwd")).toThrow(/inside the pack/);
    expect(() => lib.resolveFileWithinPack(entry, "/abs")).toThrow(/inside the pack/);
  });
});

describe("contextPackId", () => {
  it("builds the opaque context-pack:<ref> id (Atom 5 — ref is the identity)", () => {
    expect(contextPackId("packs/compaction-restore")).toBe("context-pack:packs/compaction-restore");
    expect(contextPackId("smoke")).toBe("context-pack:smoke");
  });
});

describe("estimateTokensFromBytes", () => {
  it("uses the chars/4 heuristic", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(4)).toBe(1);
    expect(estimateTokensFromBytes(7)).toBe(2);
    expect(estimateTokensFromBytes(100)).toBe(25);
  });
});

// Slice-03 lineage repair (R2 terminal HIGH-2): the version predicate must fire
// on the LIVE ingestion path (scan → readPackEntry → parseManifest), not only in
// a unit test. A forged version must be captured as a scan ERROR and NEVER
// indexed as a resolvable entry.
describe("ContextPackLibraryService — forged versions rejected live during scan (R2 HIGH-2)", () => {
  let tmp: string;
  let userRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-lib-ver-"));
    userRoot = join(tmp, "user");
    mkdirSync(userRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes neither a colon-bearing nor an overlong version — both surface as scan errors", () => {
    writePack(userRoot, "colonver", "name: colonver\nversion: '1:0:0'\nfiles: []", {});
    writePack(userRoot, "longver", `name: longver\nversion: '${"a".repeat(300)}'\nfiles: []`, {});
    const lib = new ContextPackLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const result = lib.scan();
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => /version/.test(e.error))).toBe(true);
    expect(lib.getByRef("colonver")).toBeNull();
    expect(lib.getByRef("longver")).toBeNull();
  });
});
