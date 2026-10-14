import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContextPackManifestForInstall } from "../src/lib/context-install.js";
import { parseManifest } from "../../daemon/src/domain/context-packs/manifest-parser.js";
import { ContextPackLibraryService } from "../../daemon/src/domain/context-packs/context-pack-library-service.js";

describe("install and serving agree on context-pack text assets", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "context-suffixes-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function manifest(suffix: string) {
    const path = join(root, "manifest.yaml");
    const raw = `name: helpers\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: helper${suffix}\n    role: reference\n`;
    writeFileSync(path, raw);
    return { path, raw };
  }

  it.each([".md", ".markdown", ".yaml", ".yml", ".txt", ".sh", ".ts", ".mjs", ".py"])("accepts %s as inert text", (suffix) => {
    const { path, raw } = manifest(suffix);
    expect(() => parseManifest(raw, path)).not.toThrow();
    expect(() => validateContextPackManifestForInstall(path)).not.toThrow();
  });

  it.each([".exe", ".png", ".mjs.exe", ""])("still refuses unsupported suffix %s", (suffix) => {
    const { path, raw } = manifest(suffix);
    expect(() => parseManifest(raw, path)).toThrow(/unsupported suffix/);
    expect(() => validateContextPackManifestForInstall(path)).toThrow(/unsupported suffix/);
  });
});


describe("context file dots are names unless a whole segment traverses", () => {
  it.each(["notes..md", "..notes.md", "versions..docs/v1..v2.md"])("installs, discovers and reads %s", (relativePath) => {
    const libraryRoot = mkdtempSync(join(tmpdir(), "context-file-dots-"));
    try {
      const packDir = join(libraryRoot, "pack");
      const target = join(packDir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      const text = "# Owned context\n\nLiteral filename dots preserve this text.\n";
      writeFileSync(target, text);
      const raw = `name: dot-files\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: ${relativePath}\n    role: reference\n`;
      const manifestPath = join(packDir, "manifest.yaml");
      writeFileSync(manifestPath, raw);
      expect(() => validateContextPackManifestForInstall(manifestPath)).not.toThrow();
      expect(parseManifest(raw, manifestPath).files[0]!.path).toBe(relativePath);
      const service = new ContextPackLibraryService({ roots: [{ path: libraryRoot, sourceType: "user_file" }] });
      expect(service.scan()).toEqual({ count: 1, errors: [] });
      const entry = service.getByRef("pack")!;
      expect(entry.files[0]!.bytes).toBe(Buffer.byteLength(text));
      expect(readFileSync(service.resolveFileWithinPack(entry, relativePath), "utf8")).toBe(text);
    } finally { rmSync(libraryRoot, { recursive: true, force: true }); }
  });

  it.each(["../escape.md", "nested/../escape.md", "nested\\..\\escape.md", "/escape.md"])("retains traversal refusal for %s", (relativePath) => {
    const root = mkdtempSync(join(tmpdir(), "context-file-traversal-"));
    try {
      const manifestPath = join(root, "manifest.yaml");
      const raw = `name: traversal\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: '${relativePath}'\n    role: reference\n`;
      writeFileSync(manifestPath, raw);
      expect(() => validateContextPackManifestForInstall(manifestPath)).toThrow(/relative path inside the pack/);
      expect(() => parseManifest(raw, manifestPath)).toThrow(/relative path inside the pack/);
      const service = new ContextPackLibraryService({ roots: [] });
      expect(() => service.resolveFileWithinPack({ id: "context-pack:owned", sourcePath: root } as never, relativePath)).toThrow(/inside the pack/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
