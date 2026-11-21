import { test, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { windowsHerdrEnvironmentCommand } from "../src/windows-herdr-command.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import type { DaemonClient } from "../src/client.js";

test.skipIf(process.platform !== "win32")("native Herdr env execution preserves literal argv and child exit status", () => {
  const script=windowsHerdrEnvironmentCommand(["-u","HERDR_SESSION","HERDR_SOCKET_PATH=C:\\owned ' 中文\\socket",process.execPath,"-e","process.stdout.write(JSON.stringify({socket:process.env.HERDR_SOCKET_PATH,session:process.env.HERDR_SESSION,args:process.argv.slice(1)}));process.exit(7)","%PATH%;$x"]);
  try {
    execFileSync(path.win32.join(process.env.SystemRoot!,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{env:{...process.env,HERDR_SESSION:"stale"},encoding:"utf8",windowsHide:true});
    throw new Error("Expected child status 7");
  }catch(error){
    const result=error as {status:number;stdout:string}; expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({socket:"C:\\owned ' 中文\\socket",args:["%PATH%;$x"]});
  }
});

test("Windows following launches one native window, then focuses only its confirmed endpoint",async()=>{
  const socket="C:\\owned\\herdr.sock";
  const get=vi.fn(async(url:string)=>({status:200,data:url.includes("preview")?{planId:"plan",session:"named",tmux:{mode:"inherit"},status:{launch:{socketPath:socket,session:"named"}},composed:{id:"task",opened:[],pages:[],absent:[],degraded:[]}}:{session:"named",providers:[{liveness:{alive:true},status:{launch:{socketPath:socket}}}]}}));
  const post=vi.fn(async()=>({status:200,data:{provider:"herdr",ok:true,opened:[],absent:[],degraded:[],pages:1,workspaceId:"owned"}}));
  const launch=vi.fn(async()=>{});
  const nativeScripts:string[]=[];
  const deps:WindowDeps={platform:"win32",env:{SystemRoot:"C:\\Windows",path:"C:\\tools",herdr_session:"stale"},exists:()=>true,id:()=>"id",sleep:async()=>{},herdrConfig:()=>"C:\\owned\\config.toml",launch,
    exec:async(file,args)=>{
      if(args[0]==="herdr.exe")return "C:\\tools\\herdr.exe\n";
      if(args[0]==="wt.exe")return "C:\\tools\\wt.exe\n";
      if(args[0]==="--version")return "herdr 0.9.5";
      if(args.includes("-Command"))return "1";
      const encoded=args.at(-1)!;const text=Buffer.from(encoded,"base64").toString("utf16le");nativeScripts.push(text);
      if(text.includes("status"))return JSON.stringify({running:true,socket});
      if(text.includes("list"))return JSON.stringify({result:{tabs:[{workspace_id:"owned",tab_id:"owned-tab",label:"task"}]}});
      if(text.includes("focus"))return JSON.stringify({result:{tab:{workspace_id:"owned",tab_id:"owned-tab"}}});
      throw new Error("Unexpected native CLI "+file);
    }};
  const answer=await openTerminalWindow({baseUrl:"http://127.0.0.1:17433",get,post} as unknown as DaemonClient,"qitem:task","herdr",deps,"plan","named",{enabled:true});
  expect(answer.ok).toBe(true);expect(launch).toHaveBeenCalledTimes(1);
  const command=Buffer.from(launch.mock.calls[0]![1].at(-1)!,"base64").toString("utf16le");
  expect(command).toContain(socket);expect(command).toContain("HERDR_SESSION");
  expect(post).toHaveBeenCalledWith("/api/terminal/follow",expect.objectContaining({session:"named",expectedPlan:"plan"}),expect.anything());
  expect(nativeScripts).toHaveLength(3);
});
