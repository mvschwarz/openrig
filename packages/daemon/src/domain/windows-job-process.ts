import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPlatformEnv } from "./platform-env.js";

/** Match libuv's native bare-name search before passing an explicit application
 * path to CreateProcess. PATHEXT shell shims are not part of that search. */
function resolveBareExecutable(file: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32" || /[\\/:]/.test(file)) return file;
  const search=readPlatformEnv(env,"PATH") ?? readPlatformEnv(process.env,"PATH") ?? "";
  const directories:string[]=[];
  if(readPlatformEnv(process.env,"NoDefaultCurrentDirectoryInExePath") === undefined)directories.push(cwd);
  // A quoted PATH entry can itself contain a semicolon. Preserve spaces.
  let start=0;
  while(start<search.length){
    let end=start;
    if(search[start]==='"'||search[start]==="'"){
      const closing=search.indexOf(search[start]!,start+1);end=closing<0?search.length:closing+1;
    }
    while(end<search.length&&search[end]!==';')end++;
    let entry=search.slice(start,end);start=end+1;
    if(entry.startsWith('"')||entry.startsWith("'"))entry=entry.slice(1);
    if(entry.endsWith('"')||entry.endsWith("'"))entry=entry.slice(0,-1);
    if(entry)directories.push(resolve(cwd,entry));
  }
  const dot=file.indexOf('.');
  const names=[...(dot>=0&&dot<file.length-1?[file]:[]),file+(file.endsWith('.')?'':'.')+'com',file+(file.endsWith('.')?'':'.')+'exe'];
  if(file&&file!=='.')for(const directory of directories)for(const name of names){
    const candidate=join(directory,name);
    try{if(statSync(candidate).isFile())return candidate;}catch{/* next candidate */}
  }
  throw Object.assign(new Error(`Native executable not found: ${file}`),{code:"ENOENT",syscall:"spawn",path:file});
}

// Finite commands retain custody of descendants when their executable exits.
// PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the new process atomically, before it
// can run. The helper alone owns the non-inherited kill-on-close Job handle.
const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class OpenRigProbeJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr reserved, desktop, title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reservedSize; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int size; public IntPtr descriptor; public bool inherit; }
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES security,uint size);
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
  static Task Pump(IntPtr read,Stream output) {
    var input=new FileStream(new SafeFileHandle(read,true),FileAccess.Read,81920,false);
    return Task.Run(() => { using(input) { input.CopyTo(output); output.Flush(); } });
  }
  public static int Run(string file,string argv0,string[] args,string cwd,string environment,bool verbatim,bool preserveClosedStdio) {
    IntPtr job=IntPtr.Zero, list=IntPtr.Zero, jobValue=IntPtr.Zero, handleValue=IntPtr.Zero, env=IntPtr.Zero;
    IntPtr outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero;
    Task outputPump=null,errorPump=null;
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
      if(preserveClosedStdio) {
        var security=new SECURITY_ATTRIBUTES(); security.size=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); security.inherit=true;
        Check(CreatePipe(out outputRead,out outputWrite,ref security,0)); Check(SetHandleInformation(outputRead,1,0));
        Check(CreatePipe(out errorRead,out errorWrite,ref security,0)); Check(SetHandleInformation(errorRead,1,0));
        handles[1]=outputWrite; handles[2]=errorWrite;
      }
      var unique=new System.Collections.Generic.List<IntPtr>();
      foreach(var h in handles) { Check(h!=IntPtr.Zero && h!=new IntPtr(-1)); Check(SetHandleInformation(h,1,1)); if(!unique.Contains(h))unique.Add(h); }
      handleValue=Marshal.AllocHGlobal(IntPtr.Size*unique.Count);
      for(int i=0;i<unique.Count;i++)Marshal.WriteIntPtr(handleValue,i*IntPtr.Size,unique[i]);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handleValue,new IntPtr(IntPtr.Size*unique.Count),IntPtr.Zero,IntPtr.Zero));
      var startup=new STARTUPINFOEX(); startup.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.attributes=list;
      startup.startup.flags=0x100; startup.startup.input=handles[0]; startup.startup.output=handles[1]; startup.startup.error=handles[2];
      var command=new StringBuilder(Quote(argv0)); foreach(string arg in args)command.Append(' ').Append(verbatim ? arg : Quote(arg));
      env=Marshal.StringToHGlobalUni(environment);
      Check(CreateProcessW(file,command,IntPtr.Zero,IntPtr.Zero,true,0x08080400,env,cwd,ref startup,out process));
      if(preserveClosedStdio) {
        // Only the child tree owns the write ends. EOF therefore proves the
        // surviving descendants no longer hold either probe output stream.
        CloseHandle(outputWrite); outputWrite=IntPtr.Zero; CloseHandle(errorWrite); errorWrite=IntPtr.Zero;
        outputPump=Pump(outputRead,Console.OpenStandardOutput()); outputRead=IntPtr.Zero;
        errorPump=Pump(errorRead,Console.OpenStandardError()); errorRead=IntPtr.Zero;
      }
      if(WaitForSingleObject(process.process,0xffffffff)!=0)throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code; Check(GetExitCodeProcess(process.process,out code));
      if(preserveClosedStdio && Task.WaitAll(new Task[] {outputPump,errorPump},200)) {
        // Match POSIX's healthy-probe policy only after real root exit and EOF.
        // Until this point an interrupted helper still kills its owned Job.
        limits.basic.flags=0;
        Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
      }
      return unchecked((int)code);
    } finally {
      // The default and failure paths end descendants even after root exit.
      // Only a positively drained normal probe clears kill-on-close above.
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(outputWrite!=IntPtr.Zero)CloseHandle(outputWrite);
      if(errorWrite!=IntPtr.Zero)CloseHandle(errorWrite);
      if(outputRead!=IntPtr.Zero)CloseHandle(outputRead);
      if(errorRead!=IntPtr.Zero)CloseHandle(errorRead);
      // If a descendant held output, closing the Job ends it. Forward already
      // written bytes through EOF before the helper reports its own exit.
      if(outputPump!=null && errorPump!=null)try { Task.WaitAll(new Task[] {outputPump,errorPump},1000); } catch { }
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
  exit [OpenRigProbeJob]::Run($launch.file, $launch.argv0, [string[]]$launch.args, $launch.cwd, $environment, [bool]$launch.verbatim, [bool]$launch.preserveClosedStdio)
} catch { [Console]::Error.WriteLine('OpenRig native probe job: ' + $_.Exception.Message); exit 125 }
`;

/** Finite Windows 10+ background CLI commands only. Never use this for persistent seats. */
export type WindowsJobExitPolicy = "terminate-descendants" | "preserve-closed-stdio";
export function prepareWindowsJobProcess(file: string, args: string[], options: SpawnOptions, exitPolicy: WindowsJobExitPolicy = "terminate-descendants") {
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd ?? process.cwd();
  const argv0=options.argv0 ?? file;
  if ([file, argv0, cwd, ...args].some(value => value.includes("\0"))) throw new TypeError("Native probe arguments must not contain NUL");
  const env = options.env ?? process.env;
  file=resolveBareExecutable(file,cwd,env);
  const scratch = mkdtempSync(join(tmpdir(), "openrig-probe-job-"));
  const script = join(scratch, "launch.ps1");
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
  const payload = Buffer.from(JSON.stringify({ file, argv0, args, cwd, environment, verbatim: options.windowsVerbatimArguments === true,
    preserveClosedStdio: exitPolicy === "preserve-closed-stdio" })).toString("base64");
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

export function spawnWindowsJobProcess(file: string, args: string[], options: SpawnOptions, exitPolicy: WindowsJobExitPolicy = "terminate-descendants") {
  const launch = prepareWindowsJobProcess(file, args, options, exitPolicy);
  let child: ReturnType<typeof spawn>;
  try { child = spawn(launch.file, launch.args, launch.options); }
  catch (error) { launch.dispose(); throw error; }
  child.once("close", launch.dispose);
  return child;
}
