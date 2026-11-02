import {it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {TmuxAdapter,defaultTmuxFileOps} from "../src/adapters/tmux.js";
import {renderWindowsLaunchArgv} from "../src/adapters/windows-launch.js";
import {verifyWindowsManagedRunner} from "../src/domain/windows-managed-runner.js";
import {readProcessTable} from "../src/domain/process-table.js";

const bash="C:/Program Files/Git/usr/bin/bash.exe";
it.runIf(process.platform==="win32" && fs.existsSync(bash) && !!process.env.OPENRIG_TEST_PSMUX)("delivers a private managed launch through real Git Bash and stock psmux with exact runner attribution",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"bash-managed-")),registry=path.join(root,"registry");fs.mkdirSync(registry);
 const entry=path.join(root,"runner.cjs"),ready=path.join(root,"ready.json"),state=path.join(root,"state"),launch="owned-bash-launch";
 fs.writeFileSync(entry,`require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));setInterval(()=>{},1000)`);
 const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,TEMP:root,TMP:root,SHELL:bash,PSMUX_DATA_DIR:registry,PSMUX_CONFIG_FILE:"NUL",PATH:[path.dirname(bash),path.dirname(process.execPath),path.join(process.env.SystemRoot!,"System32")].join(";")};
 const run=promisify(execFile),invoke=async(argv:string[])=>(await run(process.env.OPENRIG_TEST_PSMUX!,argv.slice(1),{env,cwd:root,windowsHide:true,timeout:10000})).stdout;
 const ops=defaultTmuxFileOps(),write=ops.writeFile,files:string[]=[];
 ops.writeFile=async(file,content,options)=>{files.push(file);await write(file,content,options);};
 const adapter=new TmuxAdapter(async()=>{throw Error("No POSIX control transport");},ops,invoke,"psmux");
 let pid:number|undefined;
 try{
   expect(await adapter.startServer()).toEqual({ok:true});
   await invoke(["tmux","set-option","-g","default-shell",`"${bash}" --noprofile --norc -i`]);
   expect(await adapter.createSession("owned-bash",root)).toEqual({ok:true});
   await expect.poll(()=>adapter.getPaneCommand("owned-bash"),{timeout:6000}).toMatch(/bash(?:\.exe)?$/i);
   const args=[entry,"--session-name","owned-bash","--state-root",state,"--cwd",root,"--launch-id",launch];
   expect(await adapter.sendShellCommand("owned-bash",renderWindowsLaunchArgv([process.execPath,...args]))).toEqual({ok:true});
   await expect.poll(()=>fs.existsSync(ready),{timeout:7000}).toBe(true);
   const receipt=JSON.parse(fs.readFileSync(ready,"utf8"));pid=receipt.pid;expect(receipt.args).toEqual(args.slice(1));
   const input={runtime:"pi" as const,sessionName:"owned-bash",entryPath:entry,cwd:root,stateRoot:state,launchId:launch,
     getPanePid:()=>adapter.getPanePid("owned-bash"),listProcesses:readProcessTable};
   const verified=await verifyWindowsManagedRunner(input);
   if(!verified){
     const panePid=await input.getPanePid(),all=await readProcessTable(),owned=new Set<number>(panePid?[panePid]:[]);
     for(let i=0;i<8;i++)for(const row of all)if(owned.has(row.ppid))owned.add(row.pid);
     console.log("owned bash ancestry",JSON.stringify({panePid,rows:all.filter(row=>owned.has(row.pid)).map(row=>({pid:row.pid,ppid:row.ppid,exe:row.executablePath,started:row.startedAt,command:row.command.slice(0,650)}))}));
   }
   expect(verified).toBe(true);
   expect(await verifyWindowsManagedRunner({...input,launchId:"foreign-launch"})).toBe(false);
   expect(files.every(file=>!fs.existsSync(file))).toBe(true);
 }finally{
   await invoke(["tmux","kill-server"]).catch(()=>{});
   if(pid)await expect.poll(()=>{try{process.kill(pid!,0);return true;}catch{return false;}},{timeout:5000}).toBe(false);
   for(const file of files)if(fs.existsSync(file))fs.unlinkSync(file);
   fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
},30000);
