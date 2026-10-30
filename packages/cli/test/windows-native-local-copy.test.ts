import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planFileCopy, runFileCopy } from "../src/lib/file-transfer.js";

describe.skipIf(process.platform !== "win32")("native Windows local transfer", () => {
  const fixture = async (fn: (root: string) => Promise<void>) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-native-copy-"));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
  };
  const copy = async (src: string, dst: string, dryRun = false) => {
    const plan = planFileCopy(src, dst, { dryRun });
    if (!plan.ok) throw new Error(plan.error);
    return runFileCopy(plan.plan);
  };

  it("copies Unicode file data, overwrites a destination, and skips unchanged data", () => fixture(async root => {
    const src = path.join(root, "source 日本語.txt"), dst = path.join(root, "destination.txt");
    const data = Buffer.from("native 🙂\n");
    await writeFile(src, data); await writeFile(dst, "old");
    expect(await copy(src, dst)).toMatchObject({ ok: true, transport: "native-local", bytesTransferred: data.length, filesTransferred: 1 });
    expect(await readFile(dst)).toEqual(data);
    expect(await copy(src, dst)).toMatchObject({ ok: true, filesTransferred: 0, bytesTransferred: 0 });
  }));

  it.each([false, true])("merges directories and retains extra files, trailing separator=%s", contentsOnly => fixture(async root => {
    const src = path.join(root, "source"), dst = path.join(root, "destination");
    await mkdir(src); await mkdir(dst); await mkdir(path.join(src, "empty"));
    await writeFile(path.join(src, "file.txt"), "copy"); await writeFile(path.join(dst, "keep.txt"), "keep");
    const result = await copy(src + (contentsOnly ? "/" : ""), dst);
    expect(result.ok, result.stderr).toBe(true);
    const target = contentsOnly ? dst : path.join(dst, "source");
    expect(await readFile(path.join(target, "file.txt"), "utf8")).toBe("copy");
    expect(await readdir(path.join(target, "empty"))).toEqual([]);
    expect(await readFile(path.join(dst, "keep.txt"), "utf8")).toBe("keep");
  }));

  it("dry-run counts planned changes without creating destination directories", () => fixture(async root => {
    const src = path.join(root, "source"), dst = path.join(root, "absent");
    await mkdir(src); await writeFile(path.join(src, "file"), "test");
    expect(await copy(src + path.sep, dst, true)).toMatchObject({ ok: true, filesTransferred: 1, bytesTransferred: 4 });
    expect(await readdir(root)).toEqual(["source"]);
  }));

  it("refuses merging through a destination junction and preserves its target", () => fixture(async root => {
    const src = path.join(root, "source"), dst = path.join(root, "destination"), other = path.join(root, "other");
    await mkdir(src); await mkdir(dst); await mkdir(other); await mkdir(path.join(src, "nested"));
    await writeFile(path.join(src, "nested", "file"), "new");
    await symlink(other, path.join(dst, "nested"), "junction");
    expect(await copy(src + path.sep, dst)).toMatchObject({ ok: false, failedStep: "local-copy-failed" });
    expect(await readdir(other)).toEqual([]);
  }));

  it("refuses recursive source/destination overlap", () => fixture(async root => {
    const src = path.join(root, "source"); await mkdir(src);
    expect(await copy(src, path.join(src, "nested"))).toMatchObject({ ok: false, stderr: "Source and destination overlap" });
  }));

  it("refuses overlap through an owned junction parent before dry-run or copy", () => fixture(async root => {
    const src = path.join(root, "source"), alias = path.join(root, "alias");
    await mkdir(src); await writeFile(path.join(src, "file.txt"), "owned original\n");
    await symlink(src, alias, "junction");
    // Check the preview first: before the correction this fails without ever
    // attempting a recursive write through the alias.
    expect(await copy(src, path.join(alias, "nested"), true)).toMatchObject({ ok: false, stderr: "Source and destination overlap" });
    expect(await copy(src, path.join(alias, "nested"))).toMatchObject({ ok: false, stderr: "Source and destination overlap" });
    expect(await readdir(src)).toEqual(["file.txt"]);
    expect(await readFile(path.join(src, "file.txt"), "utf8")).toBe("owned original\n");
    const separate = path.join(root, "separate"), separateAlias = path.join(root, "separate-alias");
    await mkdir(separate); await symlink(separate, separateAlias, "junction");
    expect(await copy(src, path.join(separateAlias, "copy"))).toMatchObject({ ok: true, filesTransferred: 1 });
    expect(await readFile(path.join(separate, "copy", "file.txt"), "utf8")).toBe("owned original\n");
  }));
});
