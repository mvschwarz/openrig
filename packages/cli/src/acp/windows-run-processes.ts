import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Read-only PEB query, as used by Microsoft's Azure Pipelines WindowsEnvVarHelper.
// The private environment bytes never leave this helper; only exact-marker PIDs do.
// No debug privilege, remote writes, injection or cross-account environment access.
const QUERY = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class OpenRigRunProcesses {
  [StructLayout(LayoutKind.Sequential)] struct BasicInfo {
    public IntPtr reserved, peb, reserved2, reserved3, pid, reserved4;
  }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("ntdll.dll", EntryPoint="NtQueryInformationProcess")] static extern int QueryBasic(IntPtr process, int kind, out BasicInfo info, int size, out int returned);
  [DllImport("ntdll.dll", EntryPoint="NtQueryInformationProcess")] static extern int QueryPointer(IntPtr process, int kind, out IntPtr info, int size, out int returned);
  static IntPtr Pointer(IntPtr process, IntPtr address, int width) {
    var bytes=new byte[width]; IntPtr read;
    if(!ReadProcessMemory(process,address,bytes,new IntPtr(width),out read) || read.ToInt64()!=width) throw new InvalidOperationException();
    return width==4 ? new IntPtr((long)BitConverter.ToUInt32(bytes,0)) : new IntPtr(BitConverter.ToInt64(bytes,0));
  }
  static bool HasMarker(IntPtr process, string marker) {
    BasicInfo info; int returned;
    if(QueryBasic(process,0,out info,Marshal.SizeOf(typeof(BasicInfo)),out returned)!=0) return false;
    bool wow64;
    if(!IsWow64Process(process,out wow64)) return false;
    int width=IntPtr.Size;
    IntPtr peb=info.peb;
    if(IntPtr.Size==8 && wow64) {
      if(QueryPointer(process,26,out peb,IntPtr.Size,out returned)!=0 || peb==IntPtr.Zero) return false;
      width=4;
    }
    // A 32-bit query host cannot represent a native 64-bit target's pointers.
    if(IntPtr.Size==4 && Environment.Is64BitOperatingSystem && !wow64) return false;
    var parameters=Pointer(process,IntPtr.Add(peb,width==8?0x20:0x10),width);
    var environment=Pointer(process,IntPtr.Add(parameters,width==8?0x80:0x48),width);
    var entry=new StringBuilder();
    // Page-aligned reads avoid asking ReadProcessMemory to cross an unreadable region.
    // Bound malformed/changing blocks rather than scanning arbitrary process memory.
    for(int offset=0; offset<2*1024*1024;) {
      long address=environment.ToInt64()+offset;
      int size=(int)Math.Min(4096-(address&4095),2*1024*1024-offset);
      var bytes=new byte[size]; IntPtr read;
      if(!ReadProcessMemory(process,new IntPtr(address),bytes,new IntPtr(size),out read) || read.ToInt64()!=size) return false;
      for(int i=0;i+1<size;i+=2) {
        char c=(char)(bytes[i]|(bytes[i+1]<<8));
        if(c!='\\0') { entry.Append(c); continue; }
        if(entry.Length==0) return false;
        if(String.Equals(entry.ToString(),marker,StringComparison.Ordinal)) return true;
        entry.Length=0;
      }
      offset+=size;
    }
    return false;
  }
  public static int[] Find(string marker) {
    var result=new List<int>();
    string user=WindowsIdentity.GetCurrent().User.Value;
    foreach(var candidate in Process.GetProcesses()) {
      using(candidate) {
        IntPtr handle=IntPtr.Zero, token=IntPtr.Zero;
        try {
          handle=OpenProcess(0x1010,false,candidate.Id);
          if(handle==IntPtr.Zero || !OpenProcessToken(handle,8,out token)) continue;
          using(var owner=new WindowsIdentity(token)) {
            if(owner.User==null || owner.User.Value!=user) continue;
          }
          if(HasMarker(handle,marker)) result.Add(candidate.Id);
        } catch { /* exited, protected, inaccessible, or unsupported layout: no witness */ }
        finally { if(token!=IntPtr.Zero) CloseHandle(token); if(handle!=IntPtr.Zero) CloseHandle(handle); }
      }
    }
    return result.ToArray();
  }
}
'@
ConvertTo-Json -InputObject @([OpenRigRunProcesses]::Find($env:OPENRIG_MARKER_QUERY)) -Compress
`;

export async function findWindowsRunProcesses(marker: string): Promise<{ pid: number }[]> {
  const temporary = await mkdtemp(join(tmpdir(), "openrig-run-query-"));
  try {
    const { stdout } = await exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(QUERY, "utf16le").toString("base64")],
      { windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, TEMP: temporary, TMP: temporary, OPENRIG_MARKER_QUERY: marker } });
    const pids: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!Array.isArray(pids) || !pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error("Invalid native run-process query");
    return pids.map(pid => ({ pid }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
