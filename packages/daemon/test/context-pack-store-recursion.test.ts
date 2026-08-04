// Slice-03 rig-context ATOM 2 (STORE) — recursive path-addressed discovery
// consuming the SEALED Atom-1 assertSafePackRef at the DISCOVERY and RESOLVE
// trust boundaries (spec §2: "Refs are the contract … stable, path-like
// address (e.g. `packs/compaction-restore`, `as-built/queue-internals`)").
// PM watch (orch): the matrix asserts the per-segment/traversal REJECT
// behavior verbatim against §2 + the sealed contract — never merely that the
// assert was invoked. Colon-id addressing stays intact (strip = LATER atom).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ContextPackLibraryService,
  contextPackId,
} from "../src/domain/context-packs/context-pack-library-service.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

function writePackAt(root: string, refPath: string, name: string, version = "1") {
  const dir = join(root, refPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), `
name: ${name}
version: ${version}
purpose: test pack
files:
  - path: notes.md
    role: notes
`);
  writeFileSync(join(dir, "notes.md"), `# ${name}\n`);
}

describe("ATOM 2 — recursive path-addressed discovery (spec §2 refs)", () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-store-recursion-"));
    root = join(tmp, "store");
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const lib = () => new ContextPackLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });

  it("discovers the spec's OWN example refs — 2-level `packs/compaction-restore` and `as-built/queue-internals` (RED: one-level scan misses them)", () => {
    writePackAt(root, "packs/compaction-restore", "compaction-restore");
    writePackAt(root, "as-built/queue-internals", "queue-internals");
    const service = lib();
    const result = service.scan();
    expect(result.errors).toEqual([]);
    expect(result.count).toBe(2);
    const refs = service.list().map((e) => e.relativePath).sort();
    expect(refs).toEqual(["as-built/queue-internals", "packs/compaction-restore"]);
  });

  it("one-level packs keep their existing shape (ref = the dir name) and deeper nesting works too", () => {
    writePackAt(root, "flat", "flat");
    writePackAt(root, "a/b/c", "deep");
    const service = lib();
    expect(service.scan().count).toBe(2);
    expect(service.list().map((e) => e.relativePath).sort()).toEqual(["a/b/c", "flat"]);
  });

  it("packs are LEAVES: a manifest below a pack dir belongs to that pack's subtree and is not indexed as its own pack", () => {
    writePackAt(root, "outer", "outer");
    writePackAt(root, "outer/inner", "inner"); // below a manifest-bearing dir
    const service = lib();
    const result = service.scan();
    expect(result.count).toBe(1);
    expect(service.list()[0]!.relativePath).toBe("outer");
  });

  it("DISCOVERY boundary: an unsafe on-disk ref is a STRUCTURED, FAIL-VISIBLE error and the pack is SKIPPED (never indexed)", () => {
    writePackAt(root, "bad name", "badpack"); // whitespace segment — unsafe per the sealed contract
    writePackAt(root, "good", "goodpack");
    const service = lib();
    const result = service.scan();
    expect(result.count).toBe(1); // only the safe pack indexed
    expect(service.list().map((e) => e.relativePath)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1); // fail-visible, structured
    expect(result.errors[0]!.source).toContain("bad name");
    expect(result.errors[0]!.error).toMatch(/unsafe pack ref/);
    expect(result.errors[0]!.error).toMatch(/'\/'-separated segments/); // the sealed per-segment contract, verbatim
  });

  it("RESOLVE boundary: getByRef returns the entry for a safe ref and null for a safe-but-absent ref", () => {
    writePackAt(root, "packs/compaction-restore", "compaction-restore");
    const service = lib();
    service.scan();
    const entry = service.getByRef("packs/compaction-restore");
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("compaction-restore");
    expect(entry!.relativePath).toBe("packs/compaction-restore");
    expect(service.getByRef("packs/absent")).toBeNull();
  });

  // PM-watch verbatim matrix: each case is a §2/sealed-contract clause and the
  // pin is the ACTUAL reject behavior — structured ContextPackError, and the
  // message carries the per-segment contract text from the sealed module.
  it.each([
    ["traversal segment", "../escape"],
    ["interior traversal", "a/../b"],
    ["dot segment", "packs/./x"],
    ["absolute path (empty leading segment)", "/abs"],
    ["empty interior segment", "a//b"],
    ["trailing slash (empty segment)", "a/"],
    ["whitespace in segment", "bad name"],
    ["colon injection in segment", "a:b"],
    ["empty ref", ""],
    ["leading dot (dotfile segment)", ".hidden/x"],
  ])("RESOLVE boundary REJECTS %s (`%s`) with a structured error and no lookup", (_label, ref) => {
    writePackAt(root, "good", "goodpack");
    const service = lib();
    service.scan();
    let thrown: unknown;
    try {
      service.getByRef(ref);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ContextPackError);
    expect((thrown as ContextPackError).code).toBe("unsafe_ref");
    expect((thrown as ContextPackError).message).toMatch(/unsafe pack ref/);
  });

  it("GUARD PROBE 1 (canonical): distinct refs with IDENTICAL manifest name/version stay independent — each ref resolves to its OWN physical pack", () => {
    writePackAt(root, "packs/a", "same", "1");
    writePackAt(root, "packs/b", "same", "1");
    const service = lib();
    const result = service.scan();
    expect(result.errors).toEqual([]);
    expect(result.count).toBe(2); // ref is the PRIMARY identity — no collapse
    expect(service.list().map((e) => e.relativePath).sort()).toEqual(["packs/a", "packs/b"]);
    const a = service.getByRef("packs/a");
    const b = service.getByRef("packs/b");
    expect(a!.sourcePath.endsWith("packs/a")).toBe(true);
    expect(b!.sourcePath.endsWith("packs/b")).toBe(true);
  });

  it("GUARD PROBE 2 (canonical): same ref across roots is last-root-wins EVERYWHERE — one list row, count one, resolve to the last entry", () => {
    const rootB = join(tmp, "storeB2");
    mkdirSync(rootB, { recursive: true });
    writePackAt(root, "packs/dup", "first", "1");
    writePackAt(rootB, "packs/dup", "second", "2");
    const service = new ContextPackLibraryService({
      roots: [
        { path: root, sourceType: "builtin" },
        { path: rootB, sourceType: "user_file" },
      ],
    });
    const result = service.scan();
    expect(result.count).toBe(1); // not two — precedence applies to the WHOLE index
    const rows = service.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("second");
    expect(service.getByRef("packs/dup")!.version).toBe("2");
  });

  it("last root wins when two roots serve the SAME ref (mirrors the id-index precedence)", () => {
    const rootB = join(tmp, "storeB");
    mkdirSync(rootB, { recursive: true });
    writePackAt(root, "packs/dup", "dup", "1");
    writePackAt(rootB, "packs/dup", "dup", "2");
    const service = new ContextPackLibraryService({
      roots: [
        { path: root, sourceType: "builtin" },
        { path: rootB, sourceType: "user_file" },
      ],
    });
    service.scan();
    expect(service.getByRef("packs/dup")!.version).toBe("2");
  });

  it("colon-id addressing COEXISTS untouched (the id strip is explicitly a LATER atom)", () => {
    writePackAt(root, "packs/compaction-restore", "compaction-restore", "3");
    const service = lib();
    service.scan();
    const viaId = service.get(contextPackId("compaction-restore", "3"));
    expect(viaId).not.toBeNull();
    expect(viaId!.relativePath).toBe("packs/compaction-restore");
    expect(service.getByRef("packs/compaction-restore")!.id).toBe(viaId!.id);
  });

  it("symlinked directories are not traversed during discovery (existing lstat-dirent semantics carried into recursion)", () => {
    writePackAt(root, "real/target", "target");
    // a symlink elsewhere in the tree must not create a second discovery path
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(join(root, "real"), join(root, "alias"));
    const service = lib();
    const result = service.scan();
    expect(result.count).toBe(1);
    expect(service.list()[0]!.relativePath).toBe("real/target");
  });
});
