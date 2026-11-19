import { test, expect } from "vitest";
import { buildGridRoot } from "../src/domain/terminal/herdr-adapter.js";
import { windowsTileAttachArgv } from "../src/domain/terminal/windows-tile-attach.js";
import type { ComposedPane } from "../src/domain/terminal/terminal-provider.js";

test("native Herdr layout uses structured PowerShell tiles and native blank panes",()=>{
  const argv=windowsTileAttachArgv("C:\\owned\\psmux.exe",["-S","C:\\owned\\server"],"seat ' 中文",true);
  const panes=Array.from({length:5},(_,i)=>({seat:`seat-${i}`,label:`Seat ${i}`,paneCommand:"unused POSIX display",attachArgv:argv,runtime:"pi",readOnly:true}) as ComposedPane);
  const grid=buildGridRoot(panes,3);
  const text=JSON.stringify(grid);
  expect(text).not.toContain('"sh"');expect(text).not.toContain("unused POSIX display");
  const leaves: Array<{command:string[]}>=[];
  const visit=(node:unknown)=>{if(!node || typeof node!=="object")return;const value=node as Record<string,unknown>;if(value.type==="pane")leaves.push(value as {command:string[]});else for(const child of Object.values(value))if(typeof child==="object")visit(child);};
  visit(grid);
  expect(leaves).toHaveLength(6);
  for(const leaf of leaves.filter(l=>l.command.includes("-EncodedCommand"))){
    const script=Buffer.from(leaf.command.at(-1)!,"base64").toString("utf16le");
    expect(script).toContain("HERDR_AGENT");expect(script).toContain("'pi'");expect(script).toContain(argv[5]);
  }
});
