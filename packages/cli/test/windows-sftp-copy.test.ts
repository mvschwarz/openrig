import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, lutimes, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import type { CopyPlan } from "../src/lib/file-transfer.js";
import { planFileCopy } from "../src/lib/file-transfer.js";

const server = process.env.OPENRIG_TEST_SFTP_SERVER ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "sftp-server.exe");
describe.skipIf(process.platform !== "win32" || !existsSync(server))("native recursive SFTP copy", () => {
  it("refuses an unqualified Windows server trailing name before copying aliased bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sftp-windows-name-alias-"));
    try {
      const source = path.join(root, "source"), destination = path.join(root, "destination");
      await mkdir(source); await mkdir(destination);
      await writeFile(path.join(source, "ambiguous"), "different ordinary name");
      await writeFile(path.toNamespacedPath(path.join(source, "ambiguous.")), "literal trailing name");
      const result = await runNativeSftpCopy({ src: { kind: "remote", path: "/" + source.replaceAll("\\", "/") + "/", host: { id: "owned", target: "owned", transport: "ssh" } }, dst: { kind: "local", path: destination }, dryRun: false }, () => spawn(server, [], { stdio: "pipe", windowsHide: true }));
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Unqualified Windows SFTP directory entry");
      expect(await readdir(destination)).not.toContain("ambiguous.");
    } finally { await rm(path.toNamespacedPath(root), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
  it.skipIf(!process.env.OPENRIG_TEST_WSL_SFTP_SERVER)("receives exact reserved and trailing names from Linux SFTP without normalization collisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sftp-exact-native-names-"));
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    const names = ["con", "nul", "aux.txt", "trailing", "trailing.", "trailing "];
    const literal = (file: string) => path.toNamespacedPath(file);
    try {
      await mkdir(source); await mkdir(destination);
      await mkdir(path.join(source, "files")); await mkdir(path.join(source, "directories"));
      for (const name of names) {
        await writeFile(literal(path.join(source, "files", name)), "file:" + name);
        await mkdir(literal(path.join(source, "directories", name)));
        await writeFile(literal(path.join(source, "directories", name, "witness.txt")), "directory:" + name);
      }
      expect((await readdir(literal(path.join(source, "files")))).sort()).toEqual([...names].sort());
      const linuxSource = "/mnt/" + source[0]!.toLowerCase() + source.slice(2).replaceAll("\\", "/");
      const plan: CopyPlan = { src: { kind: "remote", path: linuxSource + "/", host: { id: "owned", target: "owned", transport: "ssh" } },
        dst: { kind: "local", path: destination }, dryRun: true };
      const start = () => spawn("wsl.exe", ["--distribution", "Ubuntu-24.04", "--user", "codexqa", "--", process.env.OPENRIG_TEST_WSL_SFTP_SERVER!], { stdio: "pipe", windowsHide: true, windowsVerbatimArguments: true });
      const preview = await runNativeSftpCopy(plan, start); expect(preview.ok, preview.stderr).toBe(true);
      expect(await readdir(destination)).toEqual([]);
      const copied = await runNativeSftpCopy({ ...plan, dryRun: false }, start); expect(copied.ok, copied.stderr).toBe(true);
      expect(copied.filesTransferred, JSON.stringify({ changes: copied.stdout, files: await readdir(literal(path.join(destination, "files"))), directories: await readdir(literal(path.join(destination, "directories"))) })).toBe(names.length * 2);
      for (const branch of ["files", "directories"]) expect((await readdir(literal(path.join(destination, branch)))).sort()).toEqual([...names].sort());
      for (const name of names) {
        expect(await readFile(literal(path.join(destination, "files", name)), "utf8")).toBe("file:" + name);
        expect(await readFile(literal(path.join(destination, "directories", name, "witness.txt")), "utf8")).toBe("directory:" + name);
      }
      const repeated = await runNativeSftpCopy(plan, start); expect(repeated.ok, repeated.stderr).toBe(true); expect(repeated.filesTransferred).toBe(0);
    } finally { await rm(literal(root), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 40000);
  it.each([
    ['upload','file'],['upload','file-link'],['upload','directory-link'],
    ['download','file'],['download','file-link'],['download','directory-link'],
  ] as const)('replaces a %s destination %s with a staged directory',async(direction,type)=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'sftp-directory-over-file-'));
    const source=path.join(root,'source'),destination=path.join(root,'destination'),entry=path.join(destination,'directory'),referent=path.join(root,'referent');
    try{
      await mkdir(source);await mkdir(destination);await mkdir(path.join(source,'directory'));await writeFile(path.join(source,'directory','child'),'new bytes');
      if(type==='directory-link'){await mkdir(referent);await writeFile(path.join(referent,'retained'),'retain referent');await symlink(referent,entry,'dir');}
      else if(type==='file-link'){await writeFile(referent,'retain referent');await symlink(referent,entry,'file');}
      else await writeFile(entry,'old bytes');
      const remote=(file:string)=>({kind:'remote' as const,path:'/'+file.replaceAll('\\','/'),host:{id:'owned',target:'owned',transport:'ssh' as const}});
      const local=(file:string)=>({kind:'local' as const,path:file});
      const plan:CopyPlan={src:direction==='upload'?local(source+path.sep):remote(source+'/'),dst:direction==='upload'?remote(destination):local(destination),dryRun:true};
      const start=()=>spawn(server,[],{stdio:'pipe',windowsHide:true});
      const preview=await runNativeSftpCopy(plan,start);expect(preview.ok,preview.stderr).toBe(true);expect((await lstat(entry)).isDirectory()).toBe(false);
      const result=await runNativeSftpCopy({...plan,dryRun:false},start);expect(result.ok,result.stderr).toBe(true);
      expect(await readFile(path.join(entry,'child'),'utf8')).toBe('new bytes');expect((await lstat(entry)).isSymbolicLink()).toBe(false);
      expect(result.stdout).not.toContain('.openrig-copy-');expect((await readdir(destination)).some(name=>name.startsWith('.openrig-'))).toBe(false);
      if(type==='directory-link')expect(await readFile(path.join(referent,'retained'),'utf8')).toBe('retain referent');
      if(type==='file-link')expect(await readFile(referent,'utf8')).toBe('retain referent');
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it.each([
    ['upload','empty'],['upload','nonempty'],['upload','race'],
    ['download','empty'],['download','nonempty'],['download','race'],
  ] as const)('replaces only an empty destination directory (%s, %s)',async(direction,mode)=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'sftp-directory-replace-'));
    const source=path.join(root,'source'),destination=path.join(root,'destination'),entry=path.join(destination,'file');
    let injected=false;
    try{
      await mkdir(source);await mkdir(destination);await mkdir(entry);await writeFile(path.join(source,'file'),'owned staged bytes');
      if(mode==='nonempty')await writeFile(path.join(entry,'retained'),'retain data');
      const remote=(file:string)=>({kind:'remote' as const,path:'/'+file.replaceAll('\\','/'),host:{id:'owned',target:'owned',transport:'ssh' as const}});
      const local=(file:string)=>({kind:'local' as const,path:file});
      const plan:CopyPlan={src:direction==='upload'?local(source+path.sep):remote(source+'/'),dst:direction==='upload'?remote(destination):local(destination),dryRun:false};
      const start=()=>{
        const child=spawn(server,[],{stdio:'pipe',windowsHide:true});
        if(mode==='race')child.stdout.on('data',()=>{
          if(!injected&&existsSync(entry)&&readdirSync(destination).some(name=>name.startsWith('.openrig-copy-'))){writeFileSync(path.join(entry,'retained'),'retain data');injected=true;}
        });
        return child;
      };
      const result=await runNativeSftpCopy(plan,start);expect(result.ok,result.stderr).toBe(mode==='empty');
      if(mode==='empty')expect(await readFile(entry,'utf8')).toBe('owned staged bytes');
      else expect(await readFile(path.join(entry,'retained'),'utf8')).toBe('retain data');
      if(mode==='race'){
        expect(injected).toBe(true);expect(result.hint).toContain('inspect the destination');
        const stages=(await readdir(destination)).filter(name=>name.startsWith('.openrig-copy-'));expect(stages).toHaveLength(1);
        expect(await readFile(path.join(destination,stages[0]!),'utf8')).toBe('owned staged bytes');
      }
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it.each([false,true])("qualifies advertised no-follow metadata before touching the referent (dangling=%s)",async dangling=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"openrig-sftp-upload-linktime-"));
    const source=path.join(root,"source"),destination=path.join(root,"destination"),target=path.join(root,"target");
    try{
      if(!dangling){await writeFile(target,"owned referent");await utimes(target,1500000000,1500000000);}
      await symlink("target",source,"file");await lutimes(source,1400000000,1400000000);
      const plan:CopyPlan={src:{kind:"local",path:source},dst:{kind:"remote",path:"/"+destination.replaceAll("\\","/"),host:{id:"fixture",target:"fixture",transport:"ssh"}},dryRun:false};
      const start=()=>spawn(server,[],{stdio:"pipe",windowsHide:true});
      const result=await runNativeSftpCopy(plan,start);
      if(result.ok){
        expect(Math.floor((await lstat(destination)).mtimeMs/1000)).toBe(1400000000);
        expect(await readlink(destination)).toBe("target");
      }else{
        // Current Windows OpenSSH follows lsetstat links; it also cannot create
        // a dangling link. A future corrected server must pass the safe path.
        expect(result.stderr).toMatch(dangling ? /No such file|does not preserve no-follow/ : /does not preserve no-follow/);
        expect(result.hint).toContain("existing destination was not removed");
      }
      expect((await readdir(root)).filter(name=>name.startsWith(".openrig-linktime-"))).toEqual([]);
      if(!dangling)expect(Math.floor((await lstat(target)).mtimeMs/1000)).toBe(1500000000);
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("downloads and repairs link timestamps without mutating the referent",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"openrig-sftp-linktime-"));
    const source=path.join(root,"source"),destination=path.join(root,"destination"),target=path.join(root,"target");
    try{
      await writeFile(target,"owned referent");await utimes(target,1500000000,1500000000);
      await symlink("target",source,"file");await lutimes(source,1400000000,1400000000);
      const plan:CopyPlan={src:{kind:"remote",path:"/"+source.replaceAll("\\","/"),host:{id:"fixture",target:"fixture",transport:"ssh"}},dst:{kind:"local",path:destination},dryRun:false};
      const start=()=>spawn(server,[],{stdio:"pipe",windowsHide:true});
      const result=await runNativeSftpCopy(plan,start);expect(result.ok,result.stderr).toBe(true);
      expect(Math.floor((await lstat(destination)).mtimeMs/1000)).toBe(1400000000);
      await lutimes(destination,1600000000,1600000000);const inode=(await lstat(destination)).ino;
      expect((await runNativeSftpCopy({...plan,dryRun:true},start)).stdout).toContain(".L..t.");
      expect(Math.floor((await lstat(destination)).mtimeMs/1000)).toBe(1600000000);
      expect((await runNativeSftpCopy(plan,start)).ok).toBe(true);
      expect((await lstat(destination)).ino).toBe(inode);
      expect(Math.floor((await lstat(destination)).mtimeMs/1000)).toBe(1400000000);
      expect(Math.floor((await lstat(target)).mtimeMs/1000)).toBe(1500000000);
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("downloads distinct Unicode names without JavaScript lowercase conflation",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"sftp-unicode-case-")),source=path.join(root,"source"),destination=path.join(root,"destination");
    try{
      await mkdir(source);await mkdir(destination);await writeFile(path.join(source,"K.txt"),"Latin K");await writeFile(path.join(source,"K.txt"),"Kelvin sign");
      const plan:CopyPlan={src:{kind:"remote",path:"/"+source.replaceAll("\\","/")+"/",host:{id:"fixture",target:"fixture",transport:"ssh"}},dst:{kind:"local",path:destination},dryRun:true};
      const start=()=>spawn(server,[],{stdio:"pipe",windowsHide:true});
      const preview=await runNativeSftpCopy(plan,start);expect(preview.ok,preview.stderr).toBe(true);expect(preview.filesTransferred).toBe(2);expect(await readdir(destination)).toEqual([]);
      const result=await runNativeSftpCopy({...plan,dryRun:false},start);expect(result.ok,result.stderr).toBe(true);
      expect(await readFile(path.join(destination,"K.txt"),"utf8")).toBe("Latin K");expect(await readFile(path.join(destination,"K.txt"),"utf8")).toBe("Kelvin sign");
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("retains case-distinct names only in a confirmed case-sensitive destination", async context => {
    const root=await mkdtemp(path.join(os.tmpdir(),"sftp-case-distinct-"));
    const source=path.join(root,"source"),strict=path.join(root,"strict"),ordinary=path.join(root,"ordinary");
    try{
      for(const dir of [source,strict,ordinary])await mkdir(dir);
      for(const dir of [source,strict])if(spawnSync(path.join(process.env.SystemRoot!,"System32","fsutil.exe"),["file","setCaseSensitiveInfo",dir,"enable"],{windowsHide:true}).status!==0)context.skip();
      await writeFile(path.join(source,"Name.txt"),"upper");await writeFile(path.join(source,"name.txt"),"lower");
      const plan=(dst:string,dryRun=false):CopyPlan=>({src:{kind:"remote",path:"/"+source.replaceAll("\\","/")+"/",host:{id:"fixture",target:"fixture",transport:"ssh"}},dst:{kind:"local",path:dst},dryRun});
      const start=()=>spawn(server,[],{stdio:"pipe",windowsHide:true});
      const refused=await runNativeSftpCopy(plan(ordinary),start);
      expect(refused.ok).toBe(false);expect(refused.stderr).toContain("collide");expect(await readdir(ordinary)).toEqual([]);
      const preview=await runNativeSftpCopy(plan(strict,true),start);
      expect(preview.ok,preview.stderr).toBe(true);expect(preview.filesTransferred).toBe(2);expect(await readdir(strict)).toEqual([]);
      for(const dst of [strict,path.join(strict,"new-directory")]){
        const result=await runNativeSftpCopy(plan(dst),start);
        expect(result.ok,result.stderr).toBe(true);
        expect(await readFile(path.join(dst,"Name.txt"),"utf8")).toBe("upper");
        expect(await readFile(path.join(dst,"name.txt"),"utf8")).toBe("lower");
      }
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("retains an existing dangling directory link when SFTP cannot establish its referent type", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"openrig-sftp-dangling-"));
    const source=path.join(root,"source"),destination=path.join(root,"destination");
    try{
      await symlink("absent-target",source,"dir");await symlink("absent-target",destination,"dir");
      const before=await lstat(destination);
      const result=await runNativeSftpCopy({src:{kind:"remote",path:"/"+source.replaceAll("\\","/"),host:{id:"fixture",target:"fixture",transport:"ssh"}},dst:{kind:"local",path:destination},dryRun:false},()=>spawn(server,[],{stdio:"pipe",windowsHide:true}));
      expect(result.ok,result.stderr).toBe(true);expect(result.stdout).toBe("");
      expect((await lstat(destination)).ino).toBe(before.ino);
      expect(await readlink(destination)).toBe("absent-target");
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it.each([false,true])("downloads or repairs a directory symlink without copying its referent (legacy wrong type=%s)", async legacy => {
    const root=await mkdtemp(path.join(os.tmpdir(),"openrig-sftp-dirlink-"));
    const target=path.join(root,"target"), source=path.join(root,"source-link"), destination=path.join(root,"destination-link");
    try {
      await mkdir(target); await writeFile(path.join(target,"witness.txt"),"owned referent");
      await symlink("target",source,"dir");
      const plan:CopyPlan={src:{kind:"remote",path:"/"+source.replaceAll("\\","/"),host:{id:"fixture",target:"fixture",transport:"ssh"}},dst:{kind:"local",path:destination},dryRun:false};
      const start=()=>spawn(server,[],{stdio:"pipe",windowsHide:true});
      if(legacy){
        await symlink("target",destination,"file");
        const preview=await runNativeSftpCopy({...plan,dryRun:true},start);
        expect(preview.ok,preview.stderr).toBe(true);expect(preview.stdout).toContain("cL");
        await expect(readdir(destination)).rejects.toMatchObject({code:"EPERM"});
      }
      const result=await runNativeSftpCopy(plan,start);
      expect(result.ok,result.stderr).toBe(true);
      expect((await lstat(destination)).isSymbolicLink()).toBe(true);
      expect(await readlink(destination)).toBe(await readlink(source));
      expect(await readFile(path.join(destination,"witness.txt"),"utf8")).toBe("owned referent");
      expect(result.filesTransferred).toBe(0); expect(result.bytesTransferred).toBe(0);
      const repeated=await runNativeSftpCopy({...plan,dryRun:true},start);
      expect(repeated.ok,repeated.stderr).toBe(true);expect(repeated.stdout).toBe("");
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("previews directory time drift and restores parent times after copying children", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"openrig-sftp-directory-"));
    const source=path.join(root,"source"), destination=path.join(root,"destination");
    const start=()=>spawn(server,[],{stdio:"pipe",windowsHide:true});
    try {
      for(const base of [source,destination])await mkdir(path.join(base,"nested"),{recursive:true});
      await writeFile(path.join(source,"nested","new.txt"),"directory metadata acceptance\n");
      for(const [base,time] of [[source,1400000000],[destination,1500000000]] as const){
        await utimes(path.join(base,"nested"),time,time);await utimes(base,time,time);
      }
      const plan:CopyPlan={src:{kind:"remote",path:"/"+source.replaceAll("\\","/")+"/",host:{id:"fixture",target:"fixture",transport:"ssh"}},dst:{kind:"local",path:destination},dryRun:true};
      const preview=await runNativeSftpCopy(plan,start);
      expect(preview.ok,preview.stderr).toBe(true);
      expect(preview.stdout.split("\n").filter(line=>line.startsWith(".d..t"))).toHaveLength(2);
      expect(Math.floor((await lstat(destination)).mtimeMs/1000)).toBe(1500000000);
      expect(await readdir(path.join(destination,"nested"))).toEqual([]);
      const copied=await runNativeSftpCopy({...plan,dryRun:false},start);
      expect(copied.ok,copied.stderr).toBe(true);expect(copied.filesTransferred).toBe(1);
      for(const directory of [destination,path.join(destination,"nested")])expect(Math.floor((await lstat(directory)).mtimeMs/1000)).toBe(1400000000);
      const repeated=await runNativeSftpCopy(plan,start);
      expect(repeated.ok,repeated.stderr).toBe(true);expect(repeated.stdout).toBe("");expect(repeated.filesTransferred).toBe(0);
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("preserves remote readonly state and repairs metadata-only drift without retransferring bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-mode-"));
    const source = path.join(root, "source.txt"), destination = path.join(root, "destination.txt");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    try {
      await writeFile(source, "owned readonly bytes\n"); await chmod(source, 0o444);
      const plan: CopyPlan = { src: { kind: "remote", path: "/" + source.replaceAll("\\", "/"), host: { id: "fixture", target: "fixture", transport: "ssh" } }, dst: { kind: "local", path: destination }, dryRun: false };
      const first = await runNativeSftpCopy(plan, start);
      expect(first.ok, first.stderr).toBe(true);
      expect((await lstat(destination)).mode & 0o200).toBe(0);
      await chmod(destination, 0o666);
      const preview = await runNativeSftpCopy({ ...plan, dryRun: true }, start);
      expect(preview.stdout).toContain(".f...p");
      expect((await lstat(destination)).mode & 0o200).not.toBe(0);
      const repaired = await runNativeSftpCopy(plan, start);
      expect(repaired.ok, repaired.stderr).toBe(true);
      expect(repaired.filesTransferred).toBe(0);
      expect(repaired.bytesTransferred).toBe(0);
      expect((await lstat(destination)).mode & 0o200).toBe(0);
      expect(await readFile(destination, "utf8")).toBe("owned readonly bytes\n");
    } finally {
      await chmod(source, 0o666).catch(() => {}); await chmod(destination, 0o666).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it.each([false,true])("replaces an owned readonly destination while retaining its old hardlink (source readonly=%s)", async readonly => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-readonly-"));
    const source = path.join(root, "source.txt"), destination = path.join(root, "destination.txt"), alias = path.join(root, "retained-alias.txt");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    try {
      await writeFile(source, "owned new remote bytes\n");
      if (readonly) await chmod(source, 0o444);
      await writeFile(destination, "owned original\n");
      await link(destination, alias);
      await chmod(destination, 0o444);
      const result = await runNativeSftpCopy({
        src: { kind: "remote", path: "/" + source.replaceAll("\\", "/"), host: { id: "fixture", target: "fixture", transport: "ssh" } },
        dst: { kind: "local", path: destination }, dryRun: false,
      }, start);
      expect(result.ok, result.stderr).toBe(true);
      expect(await readFile(destination, "utf8")).toBe("owned new remote bytes\n");
      expect(Boolean((await lstat(destination)).mode & 0o200)).toBe(!readonly);
      expect(await readFile(alias, "utf8")).toBe("owned original\n");
      expect((await lstat(alias)).mode & 0o200).toBe(0);
      const staged = (await readdir(root)).filter(file => file.startsWith(".openrig-copy-"));
      expect(staged).toHaveLength(0);
    } finally {
      await chmod(destination, 0o666).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it("uploads, downloads, previews and preserves extra files through the real subsystem", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-copy-"));
    const source = path.join(root, "source"), remote = path.join(root, "remote space 中文"), download = path.join(root, "download");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    const planned = planFileCopy(source + path.sep, "fixture:/" + remote.replaceAll("\\", "/"), {
      dryRun: true, registryLoader: () => ({ ok: true, registry: { hosts: [{ id: "fixture", target: "fixture", transport: "ssh" }] } }),
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const plan: CopyPlan = planned.plan;
    try {
      await mkdir(source); await mkdir(remote); await mkdir(download);
      await mkdir(path.join(source, "nested"));
      await writeFile(path.join(source, "nested", "日本語.txt"), "actual native transfer\n");
      await writeFile(path.join(remote, "extra.txt"), "retain");
      const preview = await runNativeSftpCopy(plan, start);
      expect(preview.ok, preview.stderr).toBe(true);
      expect(preview.filesTransferred).toBe(1);
      expect(await readdir(remote)).toEqual(["extra.txt"]);
      plan.dryRun = false;
      const upload = await runNativeSftpCopy(plan, start);
      expect(upload.ok, upload.stderr).toBe(true);
      expect(await readFile(path.join(remote, "nested", "日本語.txt"), "utf8")).toBe("actual native transfer\n");
      expect((await runNativeSftpCopy(plan, start)).filesTransferred).toBe(0);
      // Same-size overwrite at a different timestamp must replace the entry.
      await writeFile(path.join(source, "nested", "日本語.txt"), "changed native transfer\n");
      const replacement = await runNativeSftpCopy(plan, start);
      expect(replacement.ok, replacement.stderr).toBe(true);
      const pull = await runNativeSftpCopy({ src: { ...plan.dst, path: plan.dst.path + "/" }, dst: { kind: "local", path: download }, dryRun: false }, start);
      expect(pull.ok, pull.stderr).toBe(true);
      expect(await readFile(path.join(download, "nested", "日本語.txt"), "utf8")).toBe("changed native transfer\n");
      expect(await readFile(path.join(download, "extra.txt"), "utf8")).toBe("retain");
      const missing = await runNativeSftpCopy({ ...plan, src: { kind: "local", path: path.join(root, "missing") } }, start);
      expect(missing.failedStep).toBe("remote-command-failed");
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
