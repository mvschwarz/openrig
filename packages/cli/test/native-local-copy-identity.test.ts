import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeLocalCopy } from "../src/lib/native-local-copy.js";

it.runIf(process.platform==="win32")("refuses case-colliding local copies before file writes and preserves both names in an enabled destination", async context=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"local-case-collision-"));
  const source=path.join(root,"source"),strict=path.join(root,"strict"),ordinary=path.join(root,"ordinary");
  try{
    for(const dir of [source,strict,ordinary])await mkdir(dir);
    for(const dir of [source,strict])if(spawnSync(path.join(process.env.SystemRoot!,"System32","fsutil.exe"),["file","setCaseSensitiveInfo",dir,"enable"],{windowsHide:true}).status!==0)context.skip();
    await writeFile(path.join(source,"Name.txt"),"upper");await writeFile(path.join(source,"name.txt"),"lower");
    const copy=(dst:string,dryRun=false)=>runNativeLocalCopy({src:{kind:"local",path:source+path.sep},dst:{kind:"local",path:dst},dryRun});
    for(const dryRun of [true,false]){
      const refused=await copy(ordinary,dryRun);
      expect(refused.ok).toBe(false);expect(refused.stderr).toContain("collide");expect(await readdir(ordinary)).toEqual([]);
    }
    const preview=await copy(strict,true);expect(preview.ok,preview.stderr).toBe(true);expect(preview.filesTransferred).toBe(2);expect(await readdir(strict)).toEqual([]);
    const result=await copy(strict);expect(result.ok,result.stderr).toBe(true);
    expect(await readFile(path.join(strict,"Name.txt"),"utf8")).toBe("upper");expect(await readFile(path.join(strict,"name.txt"),"utf8")).toBe("lower");
  }finally{await rm(root,{recursive:true,force:true});}
});

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
