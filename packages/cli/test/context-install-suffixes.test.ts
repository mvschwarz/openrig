import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateContextPackManifestForInstall } from "../src/lib/context-install.js";
import { parseManifest } from "../../daemon/src/domain/context-packs/manifest-parser.js";

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
