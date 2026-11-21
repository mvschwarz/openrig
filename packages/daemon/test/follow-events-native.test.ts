import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("explanation strip shows the last thirty lines and follows replacement by name", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "follow events 中文-"));
  const file = path.join(root,"events.log"), staging = path.join(root,"next.log");
  fs.writeFileSync(file,Array.from({length:40},(_,i)=>`event-${i}`).join("\n")+"\n");
  const child = spawn(process.execPath,[fileURLToPath(new URL("../assets/terminal/follow-events.mjs",import.meta.url)),file],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let output = "", errors = "";
  child.stdout.on("data",bytes=>{output+=bytes.toString();});
  child.stderr.on("data",bytes=>{errors+=bytes.toString();});
  const closed = new Promise<void>(resolve=>child.once("close",()=>resolve()));
  try {
    await expect.poll(()=>output,{timeout:5000}).toContain("event-39");
    expect(output).toContain("event-10\n"); expect(output).not.toContain("event-9\n");
    fs.writeFileSync(staging,"replacement 中文\n"); fs.renameSync(staging,file);
    await expect.poll(()=>output,{timeout:5000}).toContain("replacement 中文");
    expect(errors).toBe("");
  } finally {
    child.kill(); await closed; fs.rmSync(root,{recursive:true,force:true});
  }
},15000);
