import { execFileSync } from "node:child_process";
import { rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsPrivateDirectory } from "./private-text-file.js";

// Open the selected file itself, not the target of a final reparse point. The
// same handle supplies type, link count, owner and bytes; no path-based ACL race.
const FILE_SOURCE = String.raw`
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class OpenRigOwnedText {
  public static int Main(string[] args) {
    try {
      if(args[0]=="read")Console.Write(Read(args[1],int.Parse(args[2])));
      else Write(args[1],Convert.FromBase64String(Console.In.ReadToEnd()));
      return 0;
    } catch(Exception error) {
      Console.Error.Write((error is FileNotFoundException?"ENOENT":"EACCES")+"\n"+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(error.Message)));
      return 1;
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential)] struct FileInformation {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInformation info);
  [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle file);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle file,int type,uint requested,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  static SafeFileHandle Open(string path,bool write) {
    byte[] descriptor=null; GCHandle pinned=default(GCHandle);
    var security=new SecurityAttributes(); security.length=Marshal.SizeOf(security);
    if(write) {
      using(var identity=WindowsIdentity.GetCurrent()) {
        var acl=new FileSecurity(); acl.SetOwner(identity.User); acl.SetAccessRuleProtection(true,false);
        acl.AddAccessRule(new FileSystemAccessRule(identity.User,FileSystemRights.FullControl,AccessControlType.Allow));
        descriptor=acl.GetSecurityDescriptorBinaryForm();
      }
      pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned); security.descriptor=pinned.AddrOfPinnedObject();
    }
    try {
      var file=CreateFile(path,write?0x40020000u:0x80000000u,write?0u:1u,ref security,write?4u:3u,0x00200000u,IntPtr.Zero);
      if(file.IsInvalid) {
        int error=Marshal.GetLastWin32Error(); file.Dispose();
        if(error==2 || error==3) throw new FileNotFoundException("input file missing");
        throw new Win32Exception(error);
      }
      return file;
    } finally { if(pinned.IsAllocated)pinned.Free(); }
  }
  static FileInformation Regular(SafeFileHandle file,bool write) {
    FileInformation info;
    if(!GetFileInformationByHandle(file,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
    if(GetFileType(file)!=1 || (info.attributes & (0x10u|0x400u))!=0 || (write && info.links!=1))
      throw new InvalidOperationException(write?"experiment config must be an owned regular file":"input must be a bounded regular file without a reparse point");
    if(write) {
      IntPtr owner,group,dacl,sacl,descriptor;
      uint error=GetSecurityInfo(file,1,1,out owner,out group,out dacl,out sacl,out descriptor);
      if(error!=0)throw new Win32Exception((int)error);
      try {
        using(var identity=WindowsIdentity.GetCurrent()) {
          if(new SecurityIdentifier(owner).Value!=identity.User.Value)throw new InvalidOperationException("experiment config must be an owned regular file");
        }
      } finally { LocalFree(descriptor); }
    }
    return info;
  }
  public static string Read(string path,int limit) {
    using(var file=Open(path,false)) {
      var info=Regular(file,false);
      if(info.sizeHigh!=0 || info.sizeLow>limit)throw new InvalidOperationException("input must be a bounded regular file");
      using(var stream=new FileStream(file,FileAccess.Read)) {
        var bytes=new byte[checked(limit+1)]; int used=0,read;
        while(used<bytes.Length && (read=stream.Read(bytes,used,bytes.Length-used))>0)used+=read;
        if(used>limit)throw new InvalidOperationException("input exceeds byte limit");
        return Convert.ToBase64String(bytes,0,used);
      }
    }
  }
  public static void Write(string path,byte[] bytes) {
    try {
      using(var file=Open(path,true)) {
        Regular(file,true);
        using(var stream=new FileStream(file,FileAccess.Write)) { stream.SetLength(0); stream.Write(bytes,0,bytes.Length); }
      }
    } finally { Array.Clear(bytes,0,bytes.Length); }
  }
}
`;

let executable: string | undefined;
function nativeHelper(): string {
  if (executable) return executable;
  const directory = createWindowsPrivateDirectory(tmpdir());
  const file = join(directory, "owned-text.exe");
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'\nAdd-Type -TypeDefinition @'\n${FILE_SOURCE}\n'@ -OutputAssembly $env:OPENRIG_OWNED_TEXT_HELPER -OutputType ConsoleApplication`;
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_OWNED_TEXT_HELPER: file }, windowsHide: true, timeout: 10_000, stdio: "pipe" });
  executable = file;
  process.once("exit", () => {
    try { unlinkSync(file); rmdirSync(directory); } catch { /* retain the exact owned helper if cleanup is unavailable */ }
  });
  return file;
}

function operate(file: string, operation: "read" | "write", limit: number, content = ""): string {
  try {
    return execFileSync(nativeHelper(), [operation, file, String(limit)], {
      input: operation === "write" ? Buffer.from(content, "utf8").toString("base64") : "", encoding: "utf8",
      maxBuffer: Math.max(64 * 1024, limit * 2 + 4096), windowsHide: true, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    const result = error as { status?: number; stderr?: string | Buffer };
    const [code, message] = String(result.stderr ?? "").split("\n");
    if (result.status !== 1 || !["ENOENT", "EACCES"].includes(code ?? "") || !message) throw error;
    throw Object.assign(new Error(Buffer.from(message, "base64").toString("utf8")), { code });
  }
}

export function readWindowsRegularText(file: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= 2147483647) throw new RangeError("Invalid input byte limit");
  return Buffer.from(operate(file, "read", limit), "base64").toString("utf8");
}

/** Existing files keep their ACL; ownership and one-link checks precede
 * truncation. Newly created configuration files receive an owner-only DACL. */
export function writeWindowsOwnedText(file: string, content: string): void {
  operate(file, "write", 0, content);
}
