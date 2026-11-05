import { expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeLocalCopy } from "../src/lib/native-local-copy.js";

it.skipIf(process.platform === "win32")("repairs directory mode without data transfer and finalizes new directory modes after children", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-copy-directory-mode-"));
  const src = path.join(root, "source"), dst = path.join(root, "destination");
  const copy = (dryRun: boolean) => runNativeLocalCopy({ src: { kind: "local", path: src + path.sep }, dst: { kind: "local", path: dst }, dryRun });
  try {
    await mkdir(src); await mkdir(dst); await chmod(src, 0o751); await chmod(dst, 0o700);
    await utimes(src, 1500000000, 1500000000); await utimes(dst, 1500000000, 1500000000);
    expect(await copy(true)).toMatchObject({ ok: true, filesTransferred: 0, stdout: `.d...p ${dst}` });
    expect((await lstat(dst)).mode & 0o777).toBe(0o700);
    expect(await copy(false)).toMatchObject({ ok: true, filesTransferred: 0 });
    expect((await lstat(dst)).mode & 0o777).toBe(0o751);
    expect((await copy(true)).stdout).toBe("");
    const nested = path.join(src, "nested"); await mkdir(nested); await writeFile(path.join(nested, "child"), "owned data"); await chmod(nested, 0o555);
    const previous = process.umask(0o077);
    try { expect(await copy(false)).toMatchObject({ ok: true, filesTransferred: 1 }); }
    finally { process.umask(previous); }
    expect((await lstat(path.join(dst, "nested"))).mode & 0o777).toBe(0o555);
    expect(await readFile(path.join(dst, "nested", "child"), "utf8")).toBe("owned data");
  } finally {
    for (const dir of [path.join(src, "nested"), path.join(dst, "nested")]) await chmod(dir, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32").each([false,true])("merges into an existing readonly directory and finalizes source permissions after failure=%s",async fail=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-copy-readonly-merge-'));
  const src=path.join(root,'source'),dst=path.join(root,'destination');
  const copy=(dryRun:boolean)=>runNativeLocalCopy({src:{kind:'local',path:src+path.sep},dst:{kind:'local',path:dst},dryRun});
  try{
    await mkdir(src);await mkdir(dst);await writeFile(path.join(src,'file'),'new contents');
    if(fail){await mkdir(path.join(dst,'file'));await writeFile(path.join(dst,'file','retained'),'retain conflict');}else await writeFile(path.join(dst,'retained'),'retain extra');
    await chmod(src,fail?0o750:0o555);await chmod(dst,0o555);
    await copy(true);expect((await lstat(dst)).mode&0o777).toBe(0o555);
    const result=await copy(false);expect(result.ok,result.stderr).toBe(!fail);
    expect((await lstat(dst)).mode&0o777).toBe(fail?0o750:0o555);
    if(fail)expect((await lstat(path.join(dst,'file'))).isDirectory()).toBe(true);
    else{expect(await readFile(path.join(dst,'file'),'utf8')).toBe('new contents');expect(await readFile(path.join(dst,'retained'),'utf8')).toBe('retain extra');}
  }finally{await chmod(src,0o700).catch(()=>{});await chmod(dst,0o700).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
