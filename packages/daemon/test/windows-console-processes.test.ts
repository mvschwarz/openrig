import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { windowsArguments } from "../src/adapters/windows-argv.js";
import { powershellQuote } from "../src/adapters/windows-launch.js";
import { readWindowsConsoleProcesses } from "../src/domain/windows-process-facts.js";

const exec = promisify(execFile);
describe.skipIf(process.platform !== "win32")("native Windows console receiver census", () => {
  it.each([false, true])("observes an owned hidden console, additional receiver=%s", async additional => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-console-census-"));
    const receipt = path.join(root, "ready.json");
    const source = `const fs=require('node:fs');const c=${additional ? "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'})" : "null"};fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,child:c&&c.pid}));setInterval(()=>{},1000);`;
    const command = windowsArguments([process.execPath, "-e", source]);
    const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OwnedConsole {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,width,height,xchars,ychars,fill,flags;
    public short show,reserved2; public IntPtr reserved3,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public int pid,tid;}
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr process,IntPtr thread,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Start(string command,string cwd) {
    var startup=new Startup();startup.cb=Marshal.SizeOf(typeof(Startup));startup.flags=1;startup.show=0;
    Info info;
    if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,16,IntPtr.Zero,cwd,ref startup,out info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(info.thread);CloseHandle(info.process);return info.pid;
  }
}
'@
[OwnedConsole]::Start(${powershellQuote(command)},${powershellQuote(root)})`;
    let pid: number | undefined, child: number | undefined;
    try {
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, TEMP: root, TMP: root },
      });
      pid = Number(stdout.trim()); expect(pid).toBeGreaterThan(0);
      let ready: { pid: number; child?: number } | undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        try { ready = JSON.parse(await readFile(receipt, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      expect(ready?.pid).toBe(pid); child = ready?.child;
      const members = await readWindowsConsoleProcesses(pid);
      expect(members).toContain(pid);
      if (additional) { expect(child).toBeGreaterThan(0); expect(members).toContain(child); }
      else expect(members).toEqual([pid]);
      expect(await readWindowsConsoleProcesses(0)).toBeNull();
    } finally {
      for (const owned of [child, pid]) if (owned) { try { process.kill(owned); } catch { /* already exited */ } }
      for (const owned of [child, pid]) if (owned) {
        let alive = true;
        for (let attempt = 0; attempt < 50; attempt++) {
          try { process.kill(owned, 0); } catch { alive = false; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (alive) throw new Error(`Owned console process ${owned} did not stop; fixture retained at ${root}`);
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 20000);
});
