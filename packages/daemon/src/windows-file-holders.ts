import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
export interface WindowsFileHolder { pid: number; startedAt: string }

// Restart Manager only observes the registered file; no shutdown/restart API is called.
// RM_UNIQUE_PROCESS includes creation time, so a recycled PID is not a holder identity.
const QUERY = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OpenRigFileHolders {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {
    public uint pid;
    public System.Runtime.InteropServices.ComTypes.FILETIME started;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, UniqueProcess[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, out uint reasons);
  static void Check(int code) { if(code!=0) throw new System.ComponentModel.Win32Exception(code); }
  public static ProcessInfo[] Read(string file) {
    uint handle; Check(RmStartSession(out handle, 0, new StringBuilder(33)));
    try {
      Check(RmRegisterResources(handle, 1, new string[]{file}, 0, null, 0, null));
      uint needed, count=0, reasons;
      int code=RmGetList(handle, out needed, ref count, null, out reasons);
      for(int attempt=0; code==234 && attempt<3; attempt++) {
        count=needed;
        var info=new ProcessInfo[count];
        code=RmGetList(handle, out needed, ref count, info, out reasons);
        if(code==0) { Array.Resize(ref info, (int)count); return info; }
      }
      Check(code);
      return new ProcessInfo[0];
    } finally { Check(RmEndSession(handle)); }
  }
}
'@
$rows=@([OpenRigFileHolders]::Read($env:OPENRIG_FILE_HOLDER_PATH) | ForEach-Object {
  $bits=([long]$_.process.started.dwHighDateTime -shl 32) -bor ([long]$_.process.started.dwLowDateTime -band 0xffffffffL)
  $created=[datetime]::FromFileTimeUtc($bits)
  $current=Get-Process -Id $_.process.pid -ErrorAction Stop
  if($current.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $bits) { throw 'File holder identity changed' }
  @{pid=[int]$_.process.pid;startedAt=$created.ToString('o')}
})
ConvertTo-Json -InputObject $rows -Compress
`;

export async function readWindowsFileHolders(file: string): Promise<WindowsFileHolder[]> {
  // Add-Type's compiler and PowerShell must use the same invocation-owned TEMP.
  // The system TEMP root can resolve differently across their process boundary.
  const temp = mkdtempSync(join(tmpdir(), "openrig-file-query-"));
  try {
    const { stdout } = await exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(QUERY, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, TEMP: temp, TMP: temp, OPENRIG_FILE_HOLDER_PATH: file } });
    const rows: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!Array.isArray(rows) || !rows.every(row => row && Number.isSafeInteger(row.pid) && row.pid > 0
      && typeof row.startedAt === "string" && Number.isFinite(Date.parse(row.startedAt)))) throw new Error("Invalid native file-holder response");
    return rows;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
