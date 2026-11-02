import { describe, expect, it } from "vitest";
import { chmod, link, lstat, lutimes, utimes, mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planFileCopy, runFileCopy } from "../src/lib/file-transfer.js";
import { isWindowsDirectoryLink } from "@openrig/daemon/windows-owned-files";

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

  it.each([false,true])("skips a regular file's own inode without rejecting or replacing it (hardlink=%s)", hardlink=>fixture(async root=>{
    const src=path.join(root,"source.txt"),dst=hardlink?path.join(root,"destination.txt"):src;
    await writeFile(src,"owned shared inode");if(hardlink)await link(src,dst);
    const before=await lstat(src);
    expect(await copy(src,dst)).toMatchObject({ok:true,filesTransferred:0,bytesTransferred:0,stdout:""});
    expect((await lstat(dst)).ino).toBe(before.ino);expect((await lstat(src)).ino).toBe(before.ino);
    expect(await readFile(dst,"utf8")).toBe("owned shared inode");
  }));

  it("preserves distinct Unicode names that JavaScript lowercase would merge",()=>fixture(async root=>{
    const src=path.join(root,"source"),dst=path.join(root,"destination");await mkdir(src);await mkdir(dst);
    await writeFile(path.join(src,"K.txt"),"Latin K");await writeFile(path.join(src,"K.txt"),"Kelvin sign");
    const preview=await copy(src+path.sep,dst,true);expect(preview.ok,preview.stderr).toBe(true);expect(preview.filesTransferred).toBe(2);
    expect(await readdir(dst)).toEqual([]);
    const result=await copy(src+path.sep,dst);expect(result.ok,result.stderr).toBe(true);
    expect(await readFile(path.join(dst,"K.txt"),"utf8")).toBe("Latin K");expect(await readFile(path.join(dst,"K.txt"),"utf8")).toBe("Kelvin sign");
  }));

  it.each([false,true])("preserves native directory-link type, including dangling links (dangling=%s)", dangling => fixture(async root => {
    const src=path.join(root,"source-link"),dst=path.join(root,"destination-link"),target=path.join(root,"target");
    if(!dangling){await mkdir(target);await writeFile(path.join(target,"witness"),"retain referent");}
    await symlink("target",src,"dir");await symlink("target",dst,"file");
    const preview=await copy(src,dst,true);
    expect(preview.ok,preview.stderr).toBe(true);expect(preview.stdout).toContain("cL");
    expect(isWindowsDirectoryLink(dst)).toBe(false);
    const repaired=await copy(src,dst);
    expect(repaired).toMatchObject({ok:true,filesTransferred:0,bytesTransferred:0});
    expect(isWindowsDirectoryLink(dst)).toBe(true);
    if(!dangling)expect(await readFile(path.join(dst,"witness"),"utf8")).toBe("retain referent");
    expect((await copy(src,dst,true)).stdout).toBe("");
    expect((await readdir(root)).filter(name=>name.startsWith(".openrig-copy-"))).toEqual([]);
  }));

  it.each(["file", "dir"] as const)("preserves %s link timestamps and repairs drift without touching its referent", type => fixture(async root => {
    const src=path.join(root,"source-link"),dst=path.join(root,"destination-link"),target=path.join(root,"target");
    if(type==="dir")await mkdir(target);else await writeFile(target,"owned referent");
    await utimes(target,1500000000,1500000000);
    await symlink("target",src,type);await lutimes(src,1400000000,1400000000);
    const result=await copy(src,dst);expect(result.ok,result.stderr).toBe(true);
    expect(Math.floor((await lstat(dst)).mtimeMs/1000)).toBe(1400000000);
    await lutimes(dst,1600000000,1600000000);const inode=(await lstat(dst)).ino;
    expect((await copy(src,dst,true)).stdout).toContain(".L..t.");
    expect(Math.floor((await lstat(dst)).mtimeMs/1000)).toBe(1600000000);
    expect(await copy(src,dst)).toMatchObject({ok:true,filesTransferred:0});
    expect((await lstat(dst)).ino).toBe(inode);
    expect(Math.floor((await lstat(dst)).mtimeMs/1000)).toBe(1400000000);
    expect(Math.floor((await lstat(target)).mtimeMs/1000)).toBe(1500000000);
    expect((await copy(src,dst,true)).stdout).toBe("");
  }));

  it.each([false,true])("replaces a readonly destination without mutating its retained hardlink, source readonly=%s", readonly => fixture(async root => {
    const src=path.join(root,"source.txt"),dst=path.join(root,"destination.txt"),alias=path.join(root,"old-alias.txt");
    await writeFile(src,"owned new contents");await writeFile(dst,"old contents");
    await link(dst,alias);await chmod(dst,0o444);
    if(readonly)await chmod(src,0o444);
    try {
      expect(await copy(src,dst,true)).toMatchObject({ok:true,filesTransferred:1});
      expect(await readFile(dst,"utf8")).toBe("old contents");
      const result=await copy(src,dst);
      expect(result.ok,result.stderr).toBe(true);
      expect(await readFile(dst,"utf8")).toBe("owned new contents");
      expect(await readFile(alias,"utf8")).toBe("old contents");
      expect((await lstat(alias)).mode & 0o200).toBe(0);
      expect(Boolean((await lstat(dst)).mode & 0o200)).toBe(!readonly);
      expect((await readdir(root)).filter(name=>name.startsWith(".openrig-copy-"))).toEqual([]);
    }finally{for(const file of [src,dst,alias])await chmod(file,0o666);}
  }));

  it("previews and repairs readonly drift without copying unchanged bytes", () => fixture(async root => {
    const src=path.join(root,"source.txt"),dst=path.join(root,"destination.txt");
    await writeFile(src,"owned metadata"); await writeFile(dst,"owned metadata");
    await utimes(src,1400000000,1400000000); await utimes(dst,1400000000,1400000000);
    try {
      await chmod(src,0o444);
      const preview=await copy(src,dst,true);
      expect(preview).toMatchObject({ok:true,filesTransferred:0,bytesTransferred:0});
      expect(preview.stdout).toContain(".f...p");
      expect((await lstat(dst)).mode & 0o200).not.toBe(0);
      expect(await copy(src,dst)).toMatchObject({ok:true,filesTransferred:0,bytesTransferred:0});
      expect((await lstat(dst)).mode & 0o200).toBe(0);
      await chmod(src,0o666);
      expect(await copy(src,dst)).toMatchObject({ok:true,filesTransferred:0});
      expect((await lstat(dst)).mode & 0o200).not.toBe(0);
      expect((await copy(src,dst,true)).stdout).toBe("");
    }finally{await chmod(src,0o666);await chmod(dst,0o666);}
  }));

  it("previews directory timestamp drift without mutation and repairs it", () => fixture(async root => {
    const src=path.join(root,"source"),dst=path.join(root,"destination");
    await mkdir(src);await mkdir(dst);
    await utimes(src,1400000000,1400000000);await utimes(dst,1500000000,1500000000);
    expect((await copy(src+path.sep,dst,true)).stdout).toContain(".d..t.");
    expect(Math.floor((await lstat(dst)).mtimeMs/1000)).toBe(1500000000);
    expect((await copy(src+path.sep,dst)).ok).toBe(true);
    expect(Math.floor((await lstat(dst)).mtimeMs/1000)).toBe(1400000000);
    expect((await copy(src+path.sep,dst,true)).stdout).toBe("");
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
