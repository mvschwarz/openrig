import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HerdrFollowView } from "../src/domain/terminal/herdr-follow-view.js";
import type { ComposedView } from "../src/domain/terminal/terminal-provider.js";

test.skipIf(process.platform !== "win32")("native following keeps its empty canvas and confirms the explanation helper across restart", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"follow-win-state-")), socket=path.join(root,"herdr.sock");
  let cwd="", running=false;
  const calls:string[][]=[];
  const ids=()=>({workspace_id:"w",pane_id:"p",terminal_id:"t",cwd:cwd+"\\",focused:true});
  const helper=fileURLToPath(new URL("../assets/terminal/follow-events.mjs",import.meta.url));
  const run=async(args:string[])=>{
    calls.push(args);
    switch(args.slice(0,2).join(" ")) {
      case "status server":return JSON.stringify({running:true,version:"0.9.5",protocol:22,socket});
      case "workspace create":cwd=args[args.indexOf("--cwd")+1]!;return JSON.stringify({root_pane:ids()});
      case "pane get":return JSON.stringify({pane:ids()});
      case "pane run":running=true;return "";
      case "pane process-info":return JSON.stringify({process_info:{shell_pid:42,foreground_processes:[{pid:running?43:42,argv:running?[process.execPath,helper,path.join(cwd,"..","events.log")]:["powershell.exe"]}]}});
      default:throw new Error("Unexpected operation "+args);
    }
  };
  const make=()=>new HerdrFollowView({root,socketPath:socket,platform:"win32",run,transport:{probe:async()=>({alive:true}),request:async()=>{throw new Error("No focus mutation expected");}}});
  const view={opened:[],absent:[],degraded:[],task:{kind:"qitem",id:"empty",name:"Empty task",complete:true,issues:[],members:[]}} as unknown as ComposedView;
  try {
    for(let i=0;i<2;i++) expect(await make().follow("qitem:empty",view,{enabled:true},async()=>true)).toMatchObject({ok:true,following:{state:"empty",enabled:false}});
    expect(calls.filter(a=>a[1]==="create")).toHaveLength(1);
    expect(calls.filter(a=>a[1]==="run")).toHaveLength(1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
},30000);
