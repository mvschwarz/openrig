import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Non-SSH command runners can own the same kill-on-close Windows job as sshd. */
export async function windowsDaemonJobNeedsBreakaway(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;using System.Runtime.InteropServices;using System.ComponentModel;
public static class OpenRigDaemonJobProbe {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int t,byte[] b,uint l,out uint n);
 public static bool NeedsBreakaway(){bool inside;if(!IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out inside))throw new Win32Exception();if(!inside)return false;uint n;var b=new byte[144];if(!QueryInformationJobObject(IntPtr.Zero,9,b,144,out n))throw new Win32Exception();return (BitConverter.ToUInt32(b,16)&0x2000)!=0;}
}
'@
if([OpenRigDaemonJobProbe]::NeedsBreakaway()){[Console]::Write('yes')}else{[Console]::Write('no')}
`;
  const result = await promisify(execFile)(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (!["yes", "no"].includes(result.stdout.trim())) throw new Error("Windows daemon job probe returned an unknown result");
  return result.stdout.trim() === "yes";
}

// A Windows OpenSSH session owns a kill-on-close job. DETACHED_PROCESS alone
// does not leave that job. Re-exec the finite startup CLI with an explicit,
// OS-authorized breakaway; its ordinary child/lock/identity checks stay intact.
const HELPER = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.ComponentModel;using System.Runtime.InteropServices;
public static class OpenRigDaemonBreakaway {
 [StructLayout(LayoutKind.Sequential)] struct SI { public int cb;public IntPtr reserved,desktop,title;public int x,y,xs,ys,xc,yc,fill,flags;public short show,reservedSize;public IntPtr reservedBytes,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI startup;public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread;public uint pid,tid; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string file,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,byte[] data,uint length,out uint returned);
 static void Check(bool ok) { if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static string Quote(string text) {
  var b=new StringBuilder("\"");int n=0;
  foreach(char c in text) { if(c=='\\'){n++;continue;}b.Append('\\',c=='"'?n*2+1:n);b.Append(c);n=0; }
  b.Append('\\',n*2);return b.Append('"').ToString();
 }
 public static int Run(string file,string[] args,string cwd) {
  IntPtr list=IntPtr.Zero,values=IntPtr.Zero;bool initialized=false;var pi=new PI();
  try {
   bool inJob;Check(IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out inJob));
   if(inJob) {
    var limits=new byte[144];uint returned;Check(QueryInformationJobObject(IntPtr.Zero,9,limits,144,out returned));
    if((BitConverter.ToUInt32(limits,16)&0x1800)==0)throw new Win32Exception(5,"The current job does not permit daemon breakaway");
   }
   var handles=new IntPtr[]{GetStdHandle(-10),GetStdHandle(-11),GetStdHandle(-12)};var unique=new List<IntPtr>();
   foreach(var h in handles){Check(h!=IntPtr.Zero&&h!=new IntPtr(-1));Check(SetHandleInformation(h,1,1));if(!unique.Contains(h))unique.Add(h);}
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
   list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,1,0,ref size));initialized=true;
   values=Marshal.AllocHGlobal(IntPtr.Size*unique.Count);for(int i=0;i<unique.Count;i++)Marshal.WriteIntPtr(values,i*IntPtr.Size,unique[i]);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),values,new IntPtr(IntPtr.Size*unique.Count),IntPtr.Zero,IntPtr.Zero));
   var si=new SIX();si.startup.cb=Marshal.SizeOf(typeof(SIX));si.attributes=list;si.startup.flags=0x100;
   si.startup.input=handles[0];si.startup.output=handles[1];si.startup.error=handles[2];
   var command=new StringBuilder(Quote(file));foreach(var arg in args)command.Append(' ').Append(Quote(arg));
   // BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT.
   // A job that disallows breakaway fails here; no broker or silent fallback.
   Check(CreateProcessW(file,command,IntPtr.Zero,IntPtr.Zero,true,0x09080000,IntPtr.Zero,cwd,ref si,out pi));
   Check(WaitForSingleObject(pi.process,0xffffffff)==0);uint code;Check(GetExitCodeProcess(pi.process,out code));return unchecked((int)code);
  } finally {
   if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);
   if(initialized)DeleteProcThreadAttributeList(list);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(values!=IntPtr.Zero)Marshal.FreeHGlobal(values);
  }
 }
}
'@
$launch=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENRIG_DAEMON_DETACH_PAYLOAD)) | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('OPENRIG_DAEMON_DETACH_PAYLOAD',$null)
[Environment]::SetEnvironmentVariable('TEMP',$launch.temp)
[Environment]::SetEnvironmentVariable('TMP',$launch.tmp)
try { exit [OpenRigDaemonBreakaway]::Run($launch.file,[string[]]$launch.args,$launch.cwd) }
catch {
 $cause=$_.Exception
 while($cause.InnerException) { $cause=$cause.InnerException }
 [Console]::Error.WriteLine('Native daemon breakaway failed: '+$cause.Message+' (Win32 '+$cause.NativeErrorCode+')')
 exit 1
}
`;

/** Internal finite CLI re-exec. Never used for seats or ordinary subprocesses. */
export async function runWindowsBreakawayCommand(file: string, args: string[], cwd = process.cwd()): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32" || !path.isAbsolute(file) || [file, cwd, ...args].some(value => value.includes("\0"))) throw new Error("Invalid native daemon startup command");
  const scratch = await mkdtemp(path.join(tmpdir(), "openrig-daemon-detach-"));
  try {
    const script = path.join(scratch, "launch.ps1");
    await writeFile(script, HELPER);
    const payload = Buffer.from(JSON.stringify({ file, args, cwd, temp: process.env.TEMP ?? null, tmp: process.env.TMP ?? null })).toString("base64");
    return await promisify(execFile)(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
        env: { ...process.env, TEMP: scratch, TMP: scratch, OPENRIG_DAEMON_BREAKAWAY: "1", OPENRIG_DAEMON_DETACH_PAYLOAD: payload } });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
