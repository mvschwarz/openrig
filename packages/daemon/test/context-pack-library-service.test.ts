// Rig Context / Composable Context Injection v0 (PL-014) — library
// service tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ContextPackLibraryService,
  contextPackId,
  parseContextPackId,
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
    expect(entry.id).toBe(contextPackId("smoke", "1"));
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
    const entry = lib.getByNameVersion("missing", "1")!;
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
    const entry = lib.getByNameVersion("collision", "1")!;
    expect(entry.sourceType).toBe("workspace");
    expect(entry.sourcePath).toContain("/workspace/");
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
files:
  - path: notes.md
    role: r
`, { "notes.md": "x" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const entry = lib.getByNameVersion("guard", "1")!;
    expect(() => lib.resolveFileWithinPack(entry, "../etc/passwd")).toThrow(/inside the pack/);
    expect(() => lib.resolveFileWithinPack(entry, "/abs")).toThrow(/inside the pack/);
  });
});

describe("contextPackId / parseContextPackId", () => {
  it("encodes and decodes name:version", () => {
    expect(contextPackId("foo", "1")).toBe("context-pack:foo:1");
    expect(parseContextPackId("context-pack:foo:1")).toEqual({ name: "foo", version: "1" });
  });

  it("splits on the LAST colon so names with colons round-trip", () => {
    const id = contextPackId("project:alpha", "3");
    expect(parseContextPackId(id)).toEqual({ name: "project:alpha", version: "3" });
  });

  it("returns null for non-context-pack ids", () => {
    expect(parseContextPackId("workflow:foo:1")).toBeNull();
    expect(parseContextPackId("context-pack:no-version")).toBeNull();
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
