import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeLocalCopy } from "../src/lib/native-local-copy.js";

it("copies between distinct case-sensitive entries without treating them as overlapping", async context => {
  const root=await mkdtemp(path.join(os.tmpdir(),"copy-case-identity-"));
  try {
    if(process.platform==="win32"){
      const enabled=spawnSync(path.join(process.env.SystemRoot!,"System32","fsutil.exe"),["file","setCaseSensitiveInfo",root,"enable"],{windowsHide:true,encoding:"utf8"});
      if(enabled.status!==0)context.skip();
    }
    const src=path.join(root,"Source"),dst=path.join(root,"source");
    await mkdir(src);await mkdir(dst);await writeFile(path.join(src,"witness"),"owned directory bytes");
    const copied=await runNativeLocalCopy({src:{kind:"local",path:src+path.sep},dst:{kind:"local",path:dst},dryRun:false});
    expect(copied.ok,copied.stderr).toBe(true);
    expect(await readFile(path.join(dst,"witness"),"utf8")).toBe("owned directory bytes");
    const upper=path.join(root,"File.txt"),lower=path.join(root,"file.txt");
    await writeFile(upper,"owned file bytes");await writeFile(lower,"old");
    const file=await runNativeLocalCopy({src:{kind:"local",path:upper},dst:{kind:"local",path:lower},dryRun:false});
    expect(file.ok,file.stderr).toBe(true);
    expect(await readFile(lower,"utf8")).toBe("owned file bytes");
    expect(await readFile(upper,"utf8")).toBe("owned file bytes");
  }finally{await rm(root,{recursive:true,force:true});}
});
