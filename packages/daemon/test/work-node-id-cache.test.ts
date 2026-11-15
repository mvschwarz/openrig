import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkNodeDirs, workNodeIdCacheSizeForTests } from "../src/domain/current-work.js";
import { parseFrontmatter } from "../src/domain/slices/slice-indexer.js";

// The resolver as it was before its id cache: what every call must still answer.
function uncached(root: string, wanted: string): Array<{ dir: string; form: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ dir: string; form: string }> = [];
  for (const dir of entries.sort()) {
    if (dir === wanted) {
      out.push({ dir, form: "directory name" });
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(join(root, dir, "SPEC.md"), "utf8");
    } catch {
      continue;
    }
    if (parseFrontmatter(raw)["id"] === wanted) out.push({ dir, form: "frontmatter id" });
  }
  return out;
}

const WANTED = ["alpha", "bravo", "gamma", "delta", "m1", "m2", "missing"];

describe("resolveWorkNodeDirs' SPEC id cache", () => {
  let root: string;
  let tick = 0;
  beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), "work-node-ids-")); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.chmodSync(root, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Writes `<dir>/SPEC.md` with this id. Each write gets its own modification time, so a same-size edit is still a
   *  different file to the cache, as a real edit's new time makes it. */
  function spec(dir: string, id: string): void {
    fs.mkdirSync(join(root, dir), { recursive: true });
    const file = join(root, dir, "SPEC.md");
    fs.writeFileSync(file, `---\nid: ${id}\nintent: fixture\n---\n# ${dir}\n`);
    const at = new Date(Date.UTC(2026, 0, 1) + ++tick * 1000);
    fs.utimesSync(file, at, at);
  }
  /** Moves the clock past the settle window, so every file reads as settled and the cache keeps what it reads. */
  function settled(): void {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  }
  function expectSameAsUncached(): void {
    for (const wanted of WANTED) expect(resolveWorkNodeDirs(root, wanted), wanted).toEqual(uncached(root, wanted));
  }
  function specReads(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter(([file]) => String(file).startsWith(root) && String(file).endsWith("SPEC.md")).length;
  }

  it("answers as the uncached read does through edits (same size too), adds, removes and renames", () => {
    settled();
    spec("m1", "alpha"); spec("m2", "bravo"); spec("m3", "gamma");
    expectSameAsUncached();

    spec("m1", "bravo"); // the same size as "alpha": m1 and m2 now share an id
    expect(resolveWorkNodeDirs(root, "bravo")).toEqual([
      { dir: "m1", form: "frontmatter id" }, { dir: "m2", form: "frontmatter id" },
    ]);
    expect(resolveWorkNodeDirs(root, "alpha")).toEqual([]);
    expectSameAsUncached();

    spec("m4", "delta");
    expectSameAsUncached();
    fs.rmSync(join(root, "m2"), { recursive: true });
    expectSameAsUncached();
    fs.renameSync(join(root, "m3"), join(root, "m5"));
    expect(resolveWorkNodeDirs(root, "gamma")).toEqual([{ dir: "m5", form: "frontmatter id" }]);
    expectSameAsUncached();

    // Renamed to the wanted name: it matches by its name, before its SPEC is read.
    fs.renameSync(join(root, "m4"), join(root, "gamma"));
    expect(resolveWorkNodeDirs(root, "gamma")).toEqual([
      { dir: "gamma", form: "directory name" }, { dir: "m5", form: "frontmatter id" },
    ]);
    expectSameAsUncached();
  });

  it("reads only the SPEC files that changed since the last call", () => {
    settled();
    for (const [dir, id] of [["m1", "alpha"], ["m2", "bravo"], ["m3", "gamma"], ["m4", "delta"]]) spec(dir!, id!);
    const reads = vi.spyOn(fs, "readFileSync");
    resolveWorkNodeDirs(root, "alpha");
    expect(specReads(reads)).toBe(4);
    resolveWorkNodeDirs(root, "bravo");
    expect(specReads(reads)).toBe(4);
    spec("m3", "omega");
    expect(resolveWorkNodeDirs(root, "omega")).toEqual([{ dir: "m3", form: "frontmatter id" }]);
    expect(specReads(reads)).toBe(5);
  });

  it("keeps nothing from a file changed in the last two seconds, so an edit within one timestamp tick is still read", () => {
    spec("m1", "alpha"); // no clock move: just written
    const reads = vi.spyOn(fs, "readFileSync");
    expect(resolveWorkNodeDirs(root, "alpha")).toEqual([{ dir: "m1", form: "frontmatter id" }]);
    expect(resolveWorkNodeDirs(root, "alpha")).toEqual([{ dir: "m1", form: "frontmatter id" }]);
    expect(specReads(reads)).toBe(2);
    expect(workNodeIdCacheSizeForTests(root).entries).toBe(0);
  });

  it("skips what the uncached read skips: an unreadable SPEC or root, a SPEC that isn't a file, a file entry, no SPEC", () => {
    settled();
    spec("m1", "alpha"); spec("m2", "alpha");
    fs.mkdirSync(join(root, "no-spec"));
    fs.mkdirSync(join(root, "spec-dir", "SPEC.md"), { recursive: true });
    fs.writeFileSync(join(root, "NOTES.md"), "not a node\n");
    expectSameAsUncached();

    fs.chmodSync(join(root, "m1", "SPEC.md"), 0o000);
    try {
      expectSameAsUncached();
    } finally {
      fs.chmodSync(join(root, "m1", "SPEC.md"), 0o644);
    }
    expectSameAsUncached();

    fs.chmodSync(root, 0o000);
    try {
      expectSameAsUncached();
    } finally {
      fs.chmodSync(root, 0o755);
    }
    expectSameAsUncached();
  });

  it("keeps a directory-name match and every frontmatter match, in sorted order", () => {
    settled();
    spec("m2", "alpha"); spec("alpha", "other"); spec("m1", "alpha");
    for (let pass = 0; pass < 2; pass++) {
      expect(resolveWorkNodeDirs(root, "alpha")).toEqual([
        { dir: "alpha", form: "directory name" }, { dir: "m1", form: "frontmatter id" }, { dir: "m2", form: "frontmatter id" },
      ]);
    }
    expectSameAsUncached();
  });

  it("keeps entries only for directories the root still lists, and caps the number of roots", () => {
    settled();
    spec("m1", "alpha"); spec("m2", "bravo"); spec("m3", "gamma");
    resolveWorkNodeDirs(root, "missing");
    expect(workNodeIdCacheSizeForTests(root).entries).toBe(3);
    fs.rmSync(join(root, "m2"), { recursive: true });
    fs.rmSync(join(root, "m3"), { recursive: true });
    resolveWorkNodeDirs(root, "missing");
    expect(workNodeIdCacheSizeForTests(root).entries).toBe(1);

    const others = Array.from({ length: 300 }, (_, i) => join(root, `other-${i}`));
    for (const other of others) {
      fs.mkdirSync(other);
      resolveWorkNodeDirs(other, "missing");
    }
    expect(workNodeIdCacheSizeForTests().roots).toBeLessThanOrEqual(256);
    // An unreadable root leaves nothing behind.
    resolveWorkNodeDirs(join(root, "does-not-exist"), "missing");
    expect(workNodeIdCacheSizeForTests().roots).toBeLessThanOrEqual(256);
  });
});
