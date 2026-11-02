import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Windows exposes no GetEnvironmentStrings API for another process. Read the
// same-bitness PEB/RTL_USER_PROCESS_PARAMETERS layout used by x86/x64 Windows.
// Reject other architectures rather than guessing their layout. Only the
// terminal allowlist leaves this helper; process environment bytes never do.
const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class OpenRigViewerEnvironment {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] data,IntPtr size,out IntPtr read);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort machine,out ushort native);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,IntPtr[] info,int size,out int returned);
  static byte[] Read(IntPtr process,IntPtr address,int count) {
    var bytes=new byte[count]; IntPtr read;
    if(!ReadProcessMemory(process,address,bytes,(IntPtr)count,out read)||read.ToInt64()!=count)throw new Win32Exception();
    return bytes;
  }
  static IntPtr Pointer(IntPtr process,IntPtr address) {
    var bytes=Read(process,address,IntPtr.Size);
    return IntPtr.Size==8?new IntPtr(BitConverter.ToInt64(bytes,0)):new IntPtr(BitConverter.ToInt32(bytes,0));
  }
  public static Dictionary<string,string> ReadMarkers(int pid) {
    var result=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    IntPtr process=OpenProcess(0x410,false,pid);
    if(process==IntPtr.Zero)throw new Win32Exception();
    try {
      ushort machine,native,selfMachine,selfNative;
      if(!IsWow64Process2(process,out machine,out native)||!IsWow64Process2(GetCurrentProcess(),out selfMachine,out selfNative))throw new Win32Exception();
      if(native!=0x8664&&native!=0x14c)throw new InvalidOperationException("Unsupported process architecture");
      if(machine!=selfMachine||native!=selfNative)throw new InvalidOperationException("Process bitness differs");
      IntPtr token;
      if(!OpenProcessToken(process,8,out token))throw new Win32Exception();
      try { using(var owner=new WindowsIdentity(token))using(var self=WindowsIdentity.GetCurrent()) {
        if(owner.User==null||self.User==null||owner.User.Value!=self.User.Value)throw new UnauthorizedAccessException();
      } } finally { CloseHandle(token); }
      uint code;
      if(!GetExitCodeProcess(process,out code)||code!=259)throw new InvalidOperationException("Client exited");
      var info=new IntPtr[6]; int returned;
      if(NtQueryInformationProcess(process,0,info,IntPtr.Size*info.Length,out returned)!=0||returned<IntPtr.Size*info.Length)throw new InvalidOperationException("No process parameters");
      var parameters=Pointer(process,IntPtr.Add(info[1],IntPtr.Size==8?0x20:0x10));
      var environment=Pointer(process,IntPtr.Add(parameters,IntPtr.Size==8?0x80:0x48));
      var allowed=new HashSet<string>(new string[]{"TERM_PROGRAM","HERDR_ENV","HERDR_PANE_ID","HERDR_SOCKET_PATH","HERDR_SESSION","REX_SESSION","REX_BLOCK","REX_SERVER","REX_BIN_DIR"},StringComparer.OrdinalIgnoreCase);
      var entry=new System.Text.StringBuilder(); bool previousNul=false,complete=false; int total=0;
      // Read to page boundaries: the allocation may end immediately after the
      // final NUL. A fixed large read could cross into an inaccessible region.
      while(total<1024*1024&&!complete) {
        long address=environment.ToInt64()+total;
        int count=(int)Math.Min(4096-(address&4095),1024*1024-total);
        if((count&1)!=0)throw new InvalidOperationException("Unaligned environment");
        var bytes=Read(process,new IntPtr(address),count);
        for(int i=0;i<count;i+=2) {
          char c=(char)(bytes[i]|(bytes[i+1]<<8));
          if(c=='\0') {
            if(previousNul) { complete=true; break; }
            string value=entry.ToString(); int at=value.IndexOf('=');
            if(at>0&&allowed.Contains(value.Substring(0,at))) {
              if(value.Length>8192)throw new InvalidOperationException("Oversized terminal marker");
              result[value.Substring(0,at).ToUpperInvariant()]=value.Substring(at+1);
            }
            entry.Length=0; previousNul=true;
          } else { entry.Append(c); previousNul=false; }
        }
        total+=count;
      }
      if(!complete||!GetExitCodeProcess(process,out code)||code!=259)throw new InvalidOperationException("Incomplete or exited client");
      return result;
    } finally { CloseHandle(process); }
  }
}
`;

/** Own-user terminal markers only; unsupported/denied/stale clients stay unknown. */
export async function windowsViewerEnvironment(pid: number): Promise<NodeJS.ProcessEnv | undefined> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return undefined;
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -TypeDefinition @'\n${SOURCE}\n'@; [OpenRigViewerEnvironment]::ReadMarkers(${pid}) | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
    const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(v => typeof v !== "string")) return undefined;
    return value as NodeJS.ProcessEnv;
  } catch { return undefined; }
}
