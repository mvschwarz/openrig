// Slice-03 rig-context ATOM 4 (STORE) — remove-by-ref, the delete half of the
// path-like verb set (list/show/add/rm). rm resolves + deletes THROUGH the
// sealed Atom-1 ref boundary: an unsafe ref is a structured, fail-visible error
// BEFORE any filesystem mutation; a safe-but-absent ref is an honest
// pack_not_found; a shipped `builtin` pack is refused (rm never rmSyncs shipped
// assets — the add path only ever writes into user_file, and rm mirrors that
// operator-writable contract). A successful remove is durable: the ref no
// longer resolves and the directory is gone.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

function writePack(root: string, ref: string, name = ref.split("/").at(-1)!): void {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), `name: ${name}\nversion: 1\ntaxonomy: mission\nfiles:\n  - path: notes.md\n    role: source\n`);
  writeFileSync(join(dir, "notes.md"), "existing bytes");
}

function captureError(fn: () => unknown): ContextPackError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContextPackError);
    return err as ContextPackError;
  }
  throw new Error("expected ContextPackError");
}

describe("ATOM 4 — removeByRef (rm over path-like refs)", () => {
  let tmp: string;
  let userRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-rm-"));
    userRoot = join(tmp, "user-store");
    mkdirSync(userRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function service(roots?: Array<{ path: string; sourceType: "builtin" | "user_file" | "workspace" }>): ContextPackLibraryService {
    return new ContextPackLibraryService({
      roots: roots ?? [{ path: userRoot, sourceType: "user_file" }],
    });
  }

  it("removes a discovered user pack: ref stops resolving and the directory is gone", () => {
    writePack(userRoot, "packs/compaction-restore");
    const lib = service();
    lib.scan();
    expect(lib.getByRef("packs/compaction-restore")).not.toBeNull();
    const target = join(userRoot, "packs", "compaction-restore");
    expect(existsSync(target)).toBe(true);

    const result = lib.removeByRef("packs/compaction-restore");

    expect(result).toEqual({ removed: true, ref: "packs/compaction-restore", removedPath: target });
    expect(lib.getByRef("packs/compaction-restore")).toBeNull();
    expect(existsSync(target)).toBe(false);
    expect(lib.list()).toEqual([]);
  });

  it("removing one pack leaves the others resolvable (scan refresh is correct)", () => {
    writePack(userRoot, "packs/one");
    writePack(userRoot, "packs/two");
    const lib = service();
    lib.scan();
    expect(lib.list().map((e) => e.relativePath).sort()).toEqual(["packs/one", "packs/two"]);

    lib.removeByRef("packs/one");

    expect(lib.getByRef("packs/one")).toBeNull();
    expect(lib.getByRef("packs/two")).not.toBeNull();
    expect(existsSync(join(userRoot, "packs", "two", "manifest.yaml"))).toBe(true);
  });

  it("rejects an unsafe ref with a structured error BEFORE any filesystem mutation", () => {
    writePack(userRoot, "packs/keep");
    const lib = service();
    lib.scan();

    const err = captureError(() => lib.removeByRef("../escape"));

    expect(err.code).toBe("unsafe_ref");
    expect(err.message).toMatch(/unsafe pack ref/);
    // the sibling pack is untouched — no delete happened
    expect(lib.getByRef("packs/keep")).not.toBeNull();
    expect(existsSync(join(userRoot, "packs", "keep", "manifest.yaml"))).toBe(true);
  });

  it("returns pack_not_found for a safe-but-absent ref and mutates nothing", () => {
    writePack(userRoot, "packs/keep");
    const lib = service();
    lib.scan();

    const err = captureError(() => lib.removeByRef("packs/absent"));

    expect(err.code).toBe("pack_not_found");
    expect(lib.getByRef("packs/keep")).not.toBeNull();
    expect(existsSync(join(userRoot, "packs", "keep"))).toBe(true);
  });

  it("refuses to remove a shipped builtin pack and never deletes its directory", () => {
    const builtinRoot = join(tmp, "builtin-store");
    mkdirSync(builtinRoot, { recursive: true });
    writePack(builtinRoot, "packs/shipped", "shipped");
    const manifestBefore = readFileSync(join(builtinRoot, "packs", "shipped", "manifest.yaml"));
    const lib = service([{ path: builtinRoot, sourceType: "builtin" }]);
    lib.scan();
    expect(lib.getByRef("packs/shipped")).not.toBeNull();

    const err = captureError(() => lib.removeByRef("packs/shipped"));

    expect(err.code).toBe("pack_not_removable");
    // still resolvable + on disk, byte-for-byte
    expect(lib.getByRef("packs/shipped")).not.toBeNull();
    expect(readFileSync(join(builtinRoot, "packs", "shipped", "manifest.yaml"))).toEqual(manifestBefore);
  });
});
