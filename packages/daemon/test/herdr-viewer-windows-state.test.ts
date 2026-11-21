import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HerdrViewer, type HerdrViewerRun } from "../src/domain/terminal/herdr-viewer.js";
import { windowsTileAttachArgv } from "../src/domain/terminal/windows-tile-attach.js";

test.skipIf(process.platform !== "win32").each(["file", "pipe"])("Windows viewer journals, reuses and retires only its confirmed endpoint (%s)", async endpointKind => {
  const root = mkdtempSync(path.join(tmpdir(), "viewer-win-state-"));
  const socket = endpointKind === "pipe" ? "\\\\.\\pipe\\openrig-herdr-owned-fixture" : path.join(root, "herdr.sock"), tmux = "C:\\owned\\psmux.exe", server = ["-S", "C:\\owned\\server"];
  const argv = windowsTileAttachArgv(tmux, server, "seat", true);
  const calls: string[][] = [];
  let cwd = "", running = false;
  let reportedSocket = socket, unreadableEnumeration = false;
  const ids = () => ({workspace_id:"w",pane_id:"p",terminal_id:"t",cwd:cwd.toUpperCase()+"\\"});
  const run: HerdrViewerRun = async args => {
    calls.push(args);
    switch (args.slice(0,2).join(" ")) {
      case "status server": return JSON.stringify({running:true,version:"0.9.5",protocol:22,socket:reportedSocket});
      case "workspace list": if(unreadableEnumeration)throw Error("unreadable inventory");return JSON.stringify({workspaces:[]});
      case "workspace create": cwd = args[args.indexOf("--cwd")+1]!; return JSON.stringify({root_pane:ids()});
      case "pane get": return JSON.stringify({pane:ids()});
      case "pane process-info": return JSON.stringify({process_info:{shell_pid:42,foreground_processes:[{pid:running?43:42,argv:running?[tmux,...server,"attach","-r","-t","$1"]:["powershell.exe"]}]}});
      case "pane run": running = true; return "";
      default: throw new Error("Unexpected operation "+args.join(" "));
    }
  };
  const make = () => new HerdrViewer(socket,run,"win32",root,async () => ({nodeId:"node",sessionId:"$1"}));
  const target = {paneCommand:"encoded native tile",attachArgv:argv,readOnly:true} as Parameters<HerdrViewer["ensure"]>[1];
  try {
    const first=await make().ensure({hostId:"local",nodeId:"node"},target);
    expect(first).toMatchObject({ok:true,created:true});
    expect(await make().ensure({hostId:"local",nodeId:"node"},target)).toMatchObject({ok:true,created:false});
    expect(calls.filter(a=>a[1]==="create")).toHaveLength(1);
    expect(calls.filter(a=>a[1]==="run")).toHaveLength(1);
    expect(calls.find(a=>a[1]==="run")![3]).toMatch(/^& '/);
    if(!first.ok)throw Error("viewer did not start");
    reportedSocket=socket+"-other";
    expect(await make().forgetClosed({hostId:"local",nodeId:"node"},first.viewer)).toBe(false);
    reportedSocket=socket;unreadableEnumeration=true;
    expect(await make().forgetClosed({hostId:"local",nodeId:"node"},first.viewer)).toBe(false);
    unreadableEnumeration=false;
    expect(await make().forgetClosed({hostId:"local",nodeId:"node"},first.viewer)).toBe(true);
  } finally { rmSync(root,{recursive:true,force:true}); }
},30000);
