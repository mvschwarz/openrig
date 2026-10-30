import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A background probe must not lose its descendants when its executable exits.
// PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the new process atomically, before it
// can run. The helper alone owns the non-inherited kill-on-close Job handle.
const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class OpenRigProbeJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr reserved, desktop, title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reservedSize; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong rOps,wOps,oOps,rBytes,wBytes,oBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
    public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMITS data,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') { result.Append('\\',slashes*2+1); result.Append(c); }
      else { result.Append('\\',slashes); result.Append(c); }
      slashes=0;
    }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  public static int Run(string file,string[] args,string cwd,string environment,bool verbatim) {
    IntPtr job=IntPtr.Zero, list=IntPtr.Zero, jobValue=IntPtr.Zero, handleValue=IntPtr.Zero, env=IntPtr.Zero;
    bool initialized=false; PROCESS_INFORMATION process=new PROCESS_INFORMATION();
    try {
      job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limits=new EXTENDED_LIMITS(); limits.basic.flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,2,0,ref size)); initialized=true;
      jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var handles=new IntPtr[] {GetStdHandle(-10),GetStdHandle(-11),GetStdHandle(-12)};
      var unique=new System.Collections.Generic.List<IntPtr>();
      foreach(var h in handles) { Check(h!=IntPtr.Zero && h!=new IntPtr(-1)); Check(SetHandleInformation(h,1,1)); if(!unique.Contains(h))unique.Add(h); }
      handleValue=Marshal.AllocHGlobal(IntPtr.Size*unique.Count);
      for(int i=0;i<unique.Count;i++)Marshal.WriteIntPtr(handleValue,i*IntPtr.Size,unique[i]);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handleValue,new IntPtr(IntPtr.Size*unique.Count),IntPtr.Zero,IntPtr.Zero));
      var startup=new STARTUPINFOEX(); startup.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.attributes=list;
      startup.startup.flags=0x100; startup.startup.input=handles[0]; startup.startup.output=handles[1]; startup.startup.error=handles[2];
      var command=new StringBuilder(Quote(file)); foreach(string arg in args)command.Append(' ').Append(verbatim ? arg : Quote(arg));
      env=Marshal.StringToHGlobalUni(environment);
      Check(CreateProcessW(file,command,IntPtr.Zero,IntPtr.Zero,true,0x08080400,env,cwd,ref startup,out process));
      if(WaitForSingleObject(process.process,0xffffffff)!=0)throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code; Check(GetExitCodeProcess(process.process,out code)); return unchecked((int)code);
    } finally {
      // Closing the job ends any descendants still alive, even after root exit.
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);
      if(process.process!=IntPtr.Zero)CloseHandle(process.process);
      if(initialized)DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);
      if(jobValue!=IntPtr.Zero)Marshal.FreeHGlobal(jobValue);
      if(handleValue!=IntPtr.Zero)Marshal.FreeHGlobal(handleValue);
      if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
    }
  }
}
'@
try {
  $encoded = ''
  for ($i=0; $i -lt [int]$env:OPENRIG_WINDOWS_PROBE_JOB_COUNT; $i++) {
    $encoded += [Environment]::GetEnvironmentVariable('OPENRIG_WINDOWS_PROBE_JOB_' + $i)
  }
  $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
  $environment = ([string[]]$launch.environment -join [char]0) + [char]0 + [char]0
  exit [OpenRigProbeJob]::Run($launch.file, [string[]]$launch.args, $launch.cwd, $environment, [bool]$launch.verbatim)
} catch { [Console]::Error.WriteLine('OpenRig native probe job: ' + $_.Exception.Message); exit 125 }
`;

/** Finite Windows 10+ background CLI commands only. Never use this for persistent seats. */
export function prepareWindowsJobProcess(file: string, args: string[], options: SpawnOptions) {
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd ?? process.cwd();
  if ([file, cwd, ...args].some(value => value.includes("\0"))) throw new TypeError("Native probe arguments must not contain NUL");
  const scratch = mkdtempSync(join(tmpdir(), "openrig-probe-job-"));
  const script = join(scratch, "launch.ps1");
  const env = options.env ?? process.env;
  writeFileSync(script, HELPER, "utf8");
  // Match Node's first lexicographic spelling for case-insensitive Windows keys.
  const seen = new Set<string>();
  const environment = Object.keys(env).sort().flatMap(key => {
    if (env[key] === undefined || seen.has(key.toUpperCase())) return [];
    seen.add(key.toUpperCase()); return [`${key}=${env[key]}`];
  });
  // libuv adds these Windows essentials to an explicit spawn environment. In
  // particular, missing SYSTEMROOT breaks native crypto/Winsock initialization.
  for (const name of ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]) {
    if (!seen.has(name) && process.env[name] !== undefined) environment.push(`${name}=${process.env[name]}`);
  }
  environment.sort((a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
  const payload = Buffer.from(JSON.stringify({ file, args, cwd, environment, verbatim: options.windowsVerbatimArguments === true })).toString("base64");
  // Individual Windows environment values are bounded; no payload enters argv
  // or the source-only helper file. The child gets the explicit original block.
  const chunks = payload.match(/.{1,8192}/g)!;
  const metadata = Object.fromEntries(chunks.map((value, index) => [`OPENRIG_WINDOWS_PROBE_JOB_${index}`, value]));
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
  const launchOptions = {
    // Windows PowerShell can exit without running -File under DETACHED_PROCESS.
    // Job ownership replaces the POSIX detached-process-group mechanism.
    ...options, detached: false, shell: false, windowsHide: true,
    env: { ...env, TEMP: scratch, TMP: scratch, ...metadata, OPENRIG_WINDOWS_PROBE_JOB_COUNT: String(chunks.length) },
  };
  const dispose = () => { void rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {
    process.emitWarning(`Native probe helper cleanup failed; source-only invocation retained at ${scratch}`);
  }); };
  return { file: executable, args: argv, options: launchOptions, dispose };
}

export function spawnWindowsJobProcess(file: string, args: string[], options: SpawnOptions) {
  const launch = prepareWindowsJobProcess(file, args, options);
  let child: ReturnType<typeof spawn>;
  try { child = spawn(launch.file, launch.args, launch.options); }
  catch (error) { launch.dispose(); throw error; }
  child.once("close", launch.dispose);
  return child;
}
