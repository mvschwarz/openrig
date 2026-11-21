import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {TmuxAdapter,type ArgvExecFn} from "../src/adapters/tmux.js";

it.runIf(process.platform==="win32" && !!process.env.OPENRIG_TEST_PSMUX)("held warm claim and cold sibling hooks see private client environment without replacing personal config",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"stock-creation-env-")),registry=path.join(root,"registry"),config=path.join(root,"personal.conf");fs.mkdirSync(registry);
 const shell=path.join(process.env.SystemRoot!,"System32/WindowsPowerShell/v1.0/powershell.exe");
 const output=path.join(root,"hook.json");
 const hook=`[IO.File]::WriteAllText('${output.replaceAll("'","''")}',(ConvertTo-Json @{value=$env:SELECTED}))`;
 const text=`set -g default-shell "${shell.replaceAll("\\","/")}"\nset -g status-left "personal-marker"\nset-hook -g session-created run-shell "${shell.replaceAll("\\","/")}" -NoProfile -EncodedCommand ${Buffer.from(hook,"utf16le").toString("base64")}\n`;
 fs.writeFileSync(config,text);
 const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,PATH:path.dirname(shell),HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,TEMP:root,TMP:root,PSMUX_DATA_DIR:registry,PSMUX_CONFIG_FILE:config};
 const run=promisify(execFile),calls:string[][]=[];
 const invoke:ArgvExecFn=Object.assign(async(argv:string[],options?:{env?:Readonly<Record<string,string|undefined>>})=>{
   calls.push(argv);const result=await run(process.env.OPENRIG_TEST_PSMUX!,argv.slice(1),{env:{...env,...options?.env},cwd:root,windowsHide:true,timeout:10000});
   // Hold the new-session reply until the hook witness exists: the adapter's
   // later source-file cannot supply the value being observed here.
   if(argv.includes("new-session"))await expect.poll(()=>fs.existsSync(output),{timeout:5000}).toBe(true);
   return result.stdout;
 },{supportsEnvironment:true as const});
 const adapter=new TmuxAdapter(async()=>{throw Error("No shell transport");},undefined,invoke,"psmux");
 try{
   const value="synthetic private creation value";
   await invoke(["tmux","start-server",";","set-option","-g","exit-empty","off"]);
   const warmPidFile=path.join(registry,"__warm__.pid");
   await expect.poll(()=>fs.existsSync(warmPidFile),{timeout:5000}).toBe(true);
   const warmPid=fs.readFileSync(warmPidFile,"utf8").trim().split(":")[0];
   expect(warmPid).toMatch(/^\d+$/);expect(fs.existsSync(output)).toBe(false);
   expect(await adapter.createSession("first",root,{SELECTED:value})).toEqual({ok:true});
   expect((await invoke(["tmux","display-message","-p","-t","=first:","#{pid}"])).trim()).toBe(warmPid);
   expect(JSON.parse(fs.readFileSync(output,"utf8"))).toEqual({value});
   expect((await invoke(["tmux","show-options","-t","=first","-gv","status-left"])).trim()).toBe("personal-marker");
   fs.unlinkSync(output);
   expect(await adapter.createSession("second",root,{SELECTED:"different sibling"})).toEqual({ok:true});
   expect((await invoke(["tmux","display-message","-p","-t","=second:","#{pid}"])).trim()).not.toBe(warmPid);
   expect(await invoke(["tmux","show-environment","-t","=first","SELECTED"])).toBe(`SELECTED=${value}\n`);
   expect(JSON.parse(fs.readFileSync(output,"utf8"))).toEqual({value:"different sibling"});
   expect(calls.flat().some(word=>word.includes(value))).toBe(false);
   expect(fs.readFileSync(config,"utf8")).toBe(text);
 }finally{await invoke(["tmux","kill-server"]).catch(()=>{});fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},30000);
