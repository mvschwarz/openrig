import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import { promisify } from "node:util";
import { parseWindowsCommandLine } from "../adapters/windows-argv.js";

const exec = promisify(execFile);

// Read-only PEB query, as used by Microsoft's Azure Pipelines WindowsEnvVarHelper.
// Unrelated environment bytes never leave this helper: only marker PIDs or
// the explicitly requested cwd/argv/executable and three home selectors do.
// No debug privilege, remote writes, injection or cross-account environment access.
const QUERY = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new()
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
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] processes, uint capacity);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool SetStdHandle(int kind, IntPtr handle);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("ntdll.dll", EntryPoint="NtQueryInformationProcess")] static extern int QueryBasic(IntPtr process, int kind, out BasicInfo info, int size, out int returned);
  [DllImport("ntdll.dll", EntryPoint="NtQueryInformationProcess")] static extern int QueryPointer(IntPtr process, int kind, out IntPtr info, int size, out int returned);
  static IntPtr Pointer(IntPtr process, IntPtr address, int width) {
    var bytes=new byte[width]; IntPtr read;
    if(!ReadProcessMemory(process,address,bytes,new IntPtr(width),out read) || read.ToInt64()!=width) throw new InvalidOperationException();
    return width==4 ? new IntPtr((long)BitConverter.ToUInt32(bytes,0)) : new IntPtr(BitConverter.ToInt64(bytes,0));
  }
  static IntPtr OwnProcess(int pid) {
    IntPtr handle=OpenProcess(0x1010,false,pid), token=IntPtr.Zero;
    if(handle==IntPtr.Zero) return IntPtr.Zero;
    try {
      if(!OpenProcessToken(handle,8,out token)) { CloseHandle(handle); return IntPtr.Zero; }
      using(var current=WindowsIdentity.GetCurrent())
      using(var owner=new WindowsIdentity(token)) {
        if(owner.User==null || current.User==null || owner.User.Value!=current.User.Value) { CloseHandle(handle); return IntPtr.Zero; }
      }
      return handle;
    } catch { CloseHandle(handle); return IntPtr.Zero; }
    finally { if(token!=IntPtr.Zero) CloseHandle(token); }
  }
  static string Text(IntPtr process, IntPtr descriptor, int width) {
    var lengthBytes=new byte[2]; IntPtr read;
    if(!ReadProcessMemory(process,descriptor,lengthBytes,new IntPtr(2),out read) || read.ToInt64()!=2) throw new InvalidOperationException();
    int length=BitConverter.ToUInt16(lengthBytes,0);
    if(length==0) return "";
    if(length%2!=0) throw new InvalidOperationException();
    var address=Pointer(process,IntPtr.Add(descriptor,width==8?8:4),width);
    var bytes=new byte[length];
    if(!ReadProcessMemory(process,address,bytes,new IntPtr(length),out read) || read.ToInt64()!=length) throw new InvalidOperationException();
    return Encoding.Unicode.GetString(bytes);
  }
  static IntPtr Parameters(IntPtr process, out int width) {
    BasicInfo info; int returned;
    width=IntPtr.Size;
    if(QueryBasic(process,0,out info,Marshal.SizeOf(typeof(BasicInfo)),out returned)!=0) throw new InvalidOperationException();
    bool wow64;
    if(!IsWow64Process(process,out wow64)) throw new InvalidOperationException();
    IntPtr peb=info.peb;
    if(IntPtr.Size==8 && wow64) {
      if(QueryPointer(process,26,out peb,IntPtr.Size,out returned)!=0 || peb==IntPtr.Zero) throw new InvalidOperationException();
      width=4;
    }
    if(IntPtr.Size==4 && Environment.Is64BitOperatingSystem && !wow64) throw new InvalidOperationException();
    return Pointer(process,IntPtr.Add(peb,width==8?0x20:0x10),width);
  }
  static bool HasMarker(IntPtr process, string marker) {
    int markerEquals=marker.IndexOf('=');
    if(markerEquals<=0) return false;
    string markerKey=marker.Substring(0,markerEquals), markerValue=marker.Substring(markerEquals+1);
    int width; var parameters=Parameters(process,out width);
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
        string value=entry.ToString(); int equals=value.IndexOf('=');
        if(equals>0 && String.Equals(value.Substring(0,equals),markerKey,StringComparison.OrdinalIgnoreCase)
          && String.Equals(value.Substring(equals+1),markerValue,StringComparison.Ordinal)) return true;
        entry.Length=0;
      }
      offset+=size;
    }
    return false;
  }
  public static object Facts(int pid) {
    IntPtr handle=OwnProcess(pid);
    if(handle==IntPtr.Zero) return null;
    try {
      int width; var parameters=Parameters(handle,out width);
      var executable=new StringBuilder(32768); int capacity=executable.Capacity;
      if(!QueryFullProcessImageName(handle,0,executable,ref capacity)) return null;
      var env=new Dictionary<string,string>();
      ReadNamedEnvironment(handle,parameters,width,env);
      return new Dictionary<string,object> {
        {"cwd",Text(handle,IntPtr.Add(parameters,width==8?0x38:0x24),width)},
        {"exe",executable.ToString()},
        {"command",Text(handle,IntPtr.Add(parameters,width==8?0x70:0x40),width)}, {"env",env}
      };
    } catch { return null; }
    finally { CloseHandle(handle); }
  }
  static void ReadNamedEnvironment(IntPtr process, IntPtr parameters, int width, Dictionary<string,string> env) {
    var environment=Pointer(process,IntPtr.Add(parameters,width==8?0x80:0x48),width);
    var entry=new StringBuilder();
    for(int offset=0;offset<2*1024*1024;) {
      long address=environment.ToInt64()+offset;
      int size=(int)Math.Min(4096-(address&4095),2*1024*1024-offset);
      var bytes=new byte[size]; IntPtr read;
      if(!ReadProcessMemory(process,new IntPtr(address),bytes,new IntPtr(size),out read) || read.ToInt64()!=size) throw new InvalidOperationException();
      for(int i=0;i+1<size;i+=2) {
        char c=(char)(bytes[i]|(bytes[i+1]<<8));
        if(c!='\\0') { entry.Append(c); continue; }
        if(entry.Length==0) return;
        string value=entry.ToString(); int equals=value.IndexOf('=');
        if(equals>0) {
          string key=value.Substring(0,equals).ToUpperInvariant();
          if(key=="HOME" || key=="USERPROFILE" || key=="CODEX_HOME") env[key]=value.Substring(equals+1);
        }
        entry.Length=0;
      }
      offset+=size;
    }
    throw new InvalidOperationException();
  }
  public static uint[] ConsoleMembers(int pid) {
    IntPtr process=OwnProcess(pid);
    if(process==IntPtr.Zero) return null;
    var input=GetStdHandle(-10); var output=GetStdHandle(-11); var error=GetStdHandle(-12);
    bool attached=false;
    try {
      // This helper alone leaves its console; no control event is sent to any target.
      FreeConsole();
      attached=AttachConsole((uint)pid);
      if(!attached) return null;
      uint capacity=16;
      for(int attempt=0;attempt<3;attempt++) {
        var members=new uint[capacity];
        uint count=GetConsoleProcessList(members,capacity);
        if(count==0) return null;
        if(count>capacity) { capacity=count; continue; }
        var result=new List<uint>(); bool target=false;
        uint self=(uint)Process.GetCurrentProcess().Id;
        for(int i=0;i<count;i++) {
          if(members[i]==pid) target=true;
          if(members[i]!=self) result.Add(members[i]);
        }
        return target ? result.ToArray() : null;
      }
      return null;
    } finally {
      if(attached) FreeConsole();
      SetStdHandle(-10,input); SetStdHandle(-11,output); SetStdHandle(-12,error);
      CloseHandle(process);
    }
  }
  public static int[] Find(string marker) {
    var result=new List<int>();
    foreach(var candidate in Process.GetProcesses()) {
      using(candidate) {
        IntPtr handle=IntPtr.Zero;
        try {
          handle=OwnProcess(candidate.Id);
          if(handle==IntPtr.Zero) continue;
          if(HasMarker(handle,marker)) result.Add(candidate.Id);
        } catch { /* exited, protected, inaccessible, or unsupported layout: no witness */ }
        finally { if(handle!=IntPtr.Zero) CloseHandle(handle); }
      }
    }
    return result.ToArray();
  }
}
'@
if($env:OPENRIG_PROCESS_CONSOLE_PID) {
  $members=[OpenRigRunProcesses]::ConsoleMembers([int]$env:OPENRIG_PROCESS_CONSOLE_PID)
  if($null -eq $members) { 'null' } else { ConvertTo-Json -InputObject @($members) -Compress }
} elseif($env:OPENRIG_PROCESS_QUERY_PIDS) {
  $rows=@(foreach($requestedPid in ($env:OPENRIG_PROCESS_QUERY_PIDS | ConvertFrom-Json)) {
    @{pid=[int]$requestedPid;facts=[OpenRigRunProcesses]::Facts([int]$requestedPid)}
  })
  ConvertTo-Json -InputObject $rows -Depth 5 -Compress
} elseif($env:OPENRIG_PROCESS_QUERY_PID) {
  $facts=[OpenRigRunProcesses]::Facts([int]$env:OPENRIG_PROCESS_QUERY_PID)
  if($null -eq $facts) { 'null' } else { ConvertTo-Json -InputObject $facts -Depth 4 -Compress }
} else {
  ConvertTo-Json -InputObject @([OpenRigRunProcesses]::Find($env:OPENRIG_MARKER_QUERY)) -Compress
}
`;

async function query(values: Record<string, string>): Promise<unknown> {
  const temporary = await mkdtemp(join(tmpdir(), "openrig-run-query-"));
  try {
    const { stdout } = await exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(QUERY, "utf16le").toString("base64")],
      { windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, TEMP: temporary, TMP: temporary, OPENRIG_PROCESS_QUERY_PID: "", OPENRIG_PROCESS_QUERY_PIDS: "", OPENRIG_PROCESS_CONSOLE_PID: "", OPENRIG_MARKER_QUERY: "", ...values } });
    return JSON.parse(stdout.replace(/^\uFEFF/, ""));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function findWindowsRunProcesses(marker: string): Promise<{ pid: number }[]> {
  const pids = await query({ OPENRIG_MARKER_QUERY: marker });
  if (!Array.isArray(pids) || !pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error("Invalid native run-process query");
  return pids.map(pid => ({ pid }));
}

export interface WindowsProcessFacts {
  cwd: string;
  exe: string;
  argv: string[];
  env: { HOME?: string; USERPROFILE?: string; CODEX_HOME?: string };
}

/** Target-owned process parameters and three whitelisted home selectors only. */
export async function readWindowsProcessFacts(pid: number): Promise<WindowsProcessFacts | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  const row = await query({ OPENRIG_PROCESS_QUERY_PID: String(pid) }) as Record<string, unknown> | null;
  return parseProcessFacts(row);
}

function parseProcessFacts(row: Record<string, unknown> | null): WindowsProcessFacts | null {
  if (!row) return null;
  if (typeof row.cwd !== "string" || typeof row.exe !== "string" || typeof row.command !== "string" || !row.env || typeof row.env !== "object") throw new Error("Invalid native process facts");
  if (!isAbsolute(row.cwd) || !isAbsolute(row.exe) || !row.command) return null;
  const env: WindowsProcessFacts["env"] = {};
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME"] as const) {
    const value = (row.env as Record<string, unknown>)[key];
    if (value !== undefined) {
      if (typeof value !== "string") throw new Error("Invalid native process home");
      env[key] = value;
    }
  }
  return { cwd: pathResolve(row.cwd), exe: row.exe, argv: parseWindowsCommandLine(row.command), env };
}

/** One compiler/OS invocation for a bounded candidate set; never enumerate other
 * users or return their environment. Exited/inaccessible targets have no facts. */
export async function readWindowsProcessFactsBatch(requested: number[]): Promise<Map<number, WindowsProcessFacts>> {
  const pids = [...new Set(requested.filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647))].slice(0, 128);
  const result = new Map<number, WindowsProcessFacts>();
  if (!pids.length) return result;
  const rows = await query({ OPENRIG_PROCESS_QUERY_PIDS: JSON.stringify(pids) });
  if (!Array.isArray(rows)) throw new Error("Invalid native process facts batch");
  for (const row of rows) {
    if (!row || !pids.includes(row.pid)) throw new Error("Unexpected native process facts identity");
    const facts = parseProcessFacts(row.facts);
    if (facts) result.set(row.pid, facts);
  }
  return result;
}

/** Kernel console members, including orphan receivers no longer linked by parent PID. */
export async function readWindowsConsoleProcesses(pid: number): Promise<number[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  const members = await query({ OPENRIG_PROCESS_CONSOLE_PID: String(pid) });
  if (members === null) return null;
  if (!Array.isArray(members) || !members.every(value => Number.isSafeInteger(value) && value > 0) || !members.includes(pid)) throw new Error("Invalid native console membership");
  return [...new Set(members)].sort((a, b) => a - b);
}
