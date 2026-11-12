import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readWindowsProcessFacts } from "../../src/domain/windows-process-facts.js";

/** Explicit executable, isolated registry/home/config and namespace. Never PATH first. */
export function ownedWindowsTerminalInvoker(dir: string) {
  const registry=path.join(dir,"registry");mkdirSync(registry);
  const windows=process.env.SystemRoot??"C:\\Windows";
  const powershell=path.join(windows,"System32/WindowsPowerShell/v1.0/powershell.exe");
  const config=path.join(dir,"owned-psmux.conf");
  writeFileSync(config,`set -g default-shell '"${powershell.replaceAll("\\","/")}" -NoLogo -NoProfile -NoExit'\n`);
  const namespace=`owned-${randomUUID()}`;
  const environment:NodeJS.ProcessEnv={SystemRoot:windows,WINDIR:windows,ComSpec:path.join(windows,"System32/cmd.exe"),
    PATH:[path.dirname(process.execPath),path.dirname(powershell),path.join(windows,"System32")].join(path.delimiter),
    HOME:dir,USERPROFILE:dir,APPDATA:dir,LOCALAPPDATA:dir,TEMP:dir,TMP:dir,PSMUX_DATA_DIR:registry,PSMUX_CONFIG_FILE:config};
  const run=promisify(execFile);
  const invoke=async(argv:string[])=>(await run(process.env.OPENRIG_TEST_PSMUX!,["-L",namespace,...argv.slice(1)],{
    env:environment,cwd:dir,windowsHide:true,timeout:10000})).stdout;
  const hostExec=async(command:string)=>{
    const match=/^taskkill \/PID ([1-9]\d*) \/T( \/F)?$/.exec(command);
    if(!match || Number(match[1])<=1)throw Error("No unqualified host or POSIX command in the native fixture");
    const facts=await readWindowsProcessFacts(Number(match[1]));
    if(!facts || facts.env.HOME!==dir || facts.env.USERPROFILE!==dir)throw Error("Native fixture PID is not in its owned home");
    return (await run(path.join(windows,"System32/taskkill.exe"),["/PID",match[1]!,"/T",...(match[2]?["/F"]:[])],{env:environment,cwd:dir,windowsHide:true,timeout:10000})).stdout;
  };
  return Object.assign(invoke,{environment,namespace,hostExec});
}
