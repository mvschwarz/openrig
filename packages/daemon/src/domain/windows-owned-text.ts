import { execFile, execFileSync, spawn } from "node:child_process";
import { rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsPrivateDirectory, createWindowsPrivateDirectoryAsync } from "./private-text-file.js";

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
      if(args[0]=="read" || args[0]=="read-owned")Console.Write(Read(args[1],int.Parse(args[2]),args[0]=="read-owned"));
      else if(args[0]=="auth-mode") { using(var file=Open(args[1],false)) { Private(file); Console.Write("600"); } }
      else if(args[0]=="auth-read")Console.Write(ReadAuth(args[1]));
      else if(args[0]=="auth-copy")CopyAuth(args[1],args[2],args[3],args[4]);
      else if(args[0]=="auth-directory")AuthDirectory(args[1]);
      else if(args[0]=="assess-stdin") { using(var file=new SafeFileHandle(GetStdHandle(-10),false))Console.Write(Assess(file)); }
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
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileEx(string source,string dest,uint flags);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle file,int type,uint requested,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle file,int type,uint requested,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  static SafeFileHandle Open(string path,bool write,bool fresh=false) {
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
      var file=CreateFile(path,write?0x40020000u:0x80000000u,write?0u:1u,ref security,write?(fresh?1u:4u):3u,0x00200000u,IntPtr.Zero);
      if(file.IsInvalid) {
        int error=Marshal.GetLastWin32Error(); file.Dispose();
        if(error==2 || error==3) throw new FileNotFoundException("input file missing");
        throw new Win32Exception(error);
      }
      return file;
    } finally { if(pinned.IsAllocated)pinned.Free(); }
  }
  static FileInformation Regular(SafeFileHandle file,bool write,bool owned=false) {
    FileInformation info;
    if(!GetFileInformationByHandle(file,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
    if(GetFileType(file)!=1 || (info.attributes & (0x10u|0x400u))!=0 || (write && info.links!=1))
      throw new InvalidOperationException(write?"experiment config must be an owned regular file":"input must be a bounded regular file without a reparse point");
    if(write || owned) {
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
  public static string Read(string path,int limit,bool owned) {
    using(var file=Open(path,false)) {
      var info=Regular(file,false,owned);
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
  static string Assess(SafeFileHandle file) {
    Regular(file,false);
    IntPtr owner,group,dacl,sacl,descriptor;
    uint error=GetSecurityInfo(file,1,5,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0)throw new Win32Exception((int)error);
    try {
      var bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);
      var sd=new RawSecurityDescriptor(bytes,0);var acl=sd.DiscretionaryAcl;
      using(var identity=WindowsIdentity.GetCurrent()) {
        bool owned=new SecurityIdentifier(owner).Value==identity.User.Value;
        var ace=acl!=null && acl.Count==1?acl[0] as CommonAce:null;
        bool restricted=(sd.ControlFlags & ControlFlags.DiscretionaryAclProtected)!=0 && ace!=null
          && ace.AceQualifier==AceQualifier.AccessAllowed && !ace.IsInherited
          && ace.SecurityIdentifier.Value==identity.User.Value && (ace.AccessMask & 0x1f01ff)==0x1f01ff;
        return "{\"owned\":"+(owned?"true":"false")+",\"privateAcl\":"+(restricted?"true":"false")+"}";
      }
    } finally { LocalFree(descriptor); }
  }
  static FileInformation Private(SafeFileHandle file) {
    var info=Regular(file,false,true);
    if(info.links!=1)throw new InvalidOperationException("auth file must have one link");
    IntPtr owner,group,dacl,sacl,descriptor;
    uint error=GetSecurityInfo(file,1,5,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0)throw new Win32Exception((int)error);
    try {
      var bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);
      var sd=new RawSecurityDescriptor(bytes,0);
      var acl=sd.DiscretionaryAcl;
      using(var identity=WindowsIdentity.GetCurrent()) {
        if((sd.ControlFlags & ControlFlags.DiscretionaryAclProtected)==0 || acl==null || acl.Count!=1)
          throw new InvalidOperationException("auth file requires a private DACL");
        var ace=acl[0] as CommonAce;
        if(ace==null || ace.AceQualifier!=AceQualifier.AccessAllowed || ace.IsInherited || ace.SecurityIdentifier.Value!=identity.User.Value || (ace.AccessMask & 0x1f01ff)!=0x1f01ff)
          throw new InvalidOperationException("auth file requires a private DACL");
      }
    } finally { LocalFree(descriptor); }
    return info;
  }
  static string ReadAuth(string path) {
    using(var file=Open(path,false)) {
      var info=Private(file);
      if(info.sizeHigh!=0 || info.sizeLow>int.MaxValue)throw new InvalidOperationException("auth file too large");
      var bytes=new byte[info.sizeLow];
      try {
        using(var stream=new FileStream(file,FileAccess.Read)) {
          int used=0,n;while(used<bytes.Length && (n=stream.Read(bytes,used,bytes.Length-used))>0)used+=n;
          if(used!=bytes.Length)throw new InvalidOperationException("auth file changed during read");
          return Convert.ToBase64String(bytes);
        }
      } finally { Array.Clear(bytes,0,bytes.Length); }
    }
  }
  static void CopyAuth(string source,string dest,string expectedDevice,string expectedInode) {
    string temporary=dest+".tmp-"+Guid.NewGuid().ToString("N");
    try {
      using(var input=Open(source,false)) {
        var info=Regular(input,false,true);
        if(info.links!=1)throw new InvalidOperationException("auth source must have one link");
        ulong inode=((ulong)info.indexHigh<<32)|info.indexLow;
        if(expectedDevice!="" && ((ulong)info.volume!=ulong.Parse(expectedDevice,System.Globalization.CultureInfo.InvariantCulture) || inode!=ulong.Parse(expectedInode,System.Globalization.CultureInfo.InvariantCulture)))
          throw new InvalidOperationException("auth source identity changed");
        using(var output=Open(temporary,true,true)) {
          Private(output);
          using(var reader=new FileStream(input,FileAccess.Read))
          using(var writer=new FileStream(output,FileAccess.Write)) {
            var bytes=new byte[8192];long remaining=((long)info.sizeHigh<<32)|info.sizeLow;
            try {
              while(remaining>0) {
                int n=reader.Read(bytes,0,(int)Math.Min(bytes.Length,remaining));
                if(n==0)throw new InvalidOperationException("auth source changed during copy");
                writer.Write(bytes,0,n);remaining-=n;
              }
              writer.Flush(true);
            } finally { Array.Clear(bytes,0,bytes.Length); }
          }
        }
      }
      if(!MoveFileEx(temporary,dest,9))throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { if(File.Exists(temporary))File.Delete(temporary); }
  }
  static void AuthDirectory(string path) {
    using(var identity=WindowsIdentity.GetCurrent()) {
      var acl=new DirectorySecurity();acl.SetOwner(identity.User);acl.SetAccessRuleProtection(true,false);
      acl.AddAccessRule(new FileSystemAccessRule(identity.User,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      if(!Directory.Exists(path))Directory.CreateDirectory(path,acl);
      var security=new SecurityAttributes();security.length=Marshal.SizeOf(security);
      using(var file=CreateFile(path,0x60000u,0,ref security,3,0x02200000u,IntPtr.Zero)) {
        if(file.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
        FileInformation info;
        if(!GetFileInformationByHandle(file,out info) || (info.attributes & 0x410u)!=0x10u)throw new InvalidOperationException("auth profile directory must not be a reparse point");
        IntPtr owner,group,dacl,sacl,descriptor;
        uint error=GetSecurityInfo(file,1,1,out owner,out group,out dacl,out sacl,out descriptor);
        if(error!=0)throw new Win32Exception((int)error);
        try {if(new SecurityIdentifier(owner).Value!=identity.User.Value)throw new InvalidOperationException("auth profile directory must be owned");}
        finally {LocalFree(descriptor);}
        var bytes=acl.GetSecurityDescriptorBinaryForm();var pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
        try {
          bool present,defaulted;IntPtr privateDacl;
          if(!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(),out present,out privateDacl,out defaulted) || !present)throw new InvalidOperationException("private directory DACL missing");
          error=SetSecurityInfo(file,1,0x80000004u,IntPtr.Zero,IntPtr.Zero,privateDacl,IntPtr.Zero);
          if(error!=0)throw new Win32Exception((int)error);
        } finally {pinned.Free();}
      }
    }
  }
}
`;

let executable: string | undefined;
let compiling: Promise<string> | undefined;
async function nativeHelperAsync(): Promise<string> {
  if (executable) return executable;
  if (!compiling) compiling = (async () => {
    const directory = await createWindowsPrivateDirectoryAsync(tmpdir());
    const file = join(directory, "owned-text.exe");
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -OutputAssembly $env:OPENRIG_OWNED_TEXT_HELPER -OutputType ConsoleApplication";
    await new Promise<void>((resolveRun, reject) => {
      const compiler = execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { env: { ...process.env, OPENRIG_OWNED_TEXT_HELPER: file }, windowsHide: true, timeout: 10_000 },
        error => error ? reject(error) : resolveRun());
      compiler.stdin!.end(FILE_SOURCE);
    });
    executable = file;
    process.once("exit", () => {
      try { unlinkSync(file); rmdirSync(directory); } catch { /* retain the exact owned helper if cleanup is unavailable */ }
    });
    return file;
  })().catch(error => { compiling = undefined; throw error; });
  return compiling;
}

/** Inspect the caller's already-open file through inherited stdin. The helper
 * reads security metadata only; no pathname is reopened and no bytes or SIDs
 * leave it. Compilation and inspection do not block the serving event loop. */
export async function assessWindowsFilePermissions(fd: number): Promise<{ owned: boolean; privateAcl: boolean }> {
  const helper = await nativeHelperAsync();
  return new Promise((resolveAssessment, reject) => {
    const child = spawn(helper, ["assess-stdin"], { windowsHide: true, stdio: [fd, "pipe", "ignore"] });
    let output = "";
    child.stdout!.on("data", (data: Buffer) => { output += data.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows file permission assessment timed out")); }, 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error("Windows file permission assessment unavailable")); return; }
      try { resolveAssessment(JSON.parse(output) as { owned: boolean; privateAcl: boolean }); }
      catch (error) { reject(error); }
    });
  });
}
function nativeHelper(): string {
  if (executable) return executable;
  const directory = createWindowsPrivateDirectory(tmpdir());
  const file = join(directory, "owned-text.exe");
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -OutputAssembly $env:OPENRIG_OWNED_TEXT_HELPER -OutputType ConsoleApplication";
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_OWNED_TEXT_HELPER: file }, input: FILE_SOURCE, windowsHide: true, timeout: 10_000, stdio: "pipe" });
  executable = file;
  process.once("exit", () => {
    try { unlinkSync(file); rmdirSync(directory); } catch { /* retain the exact owned helper if cleanup is unavailable */ }
  });
  return file;
}

function operate(file: string, operation: "read" | "read-owned" | "write", limit: number, content = ""): string {
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

/** Bounded, no-final-reparse read with owner SID checked on the reading handle. */
export function readWindowsOwnedText(file: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= 2147483647) throw new RangeError("Invalid input byte limit");
  return Buffer.from(operate(file, "read-owned", limit), "base64").toString("utf8");
}

/** Auth operations keep source identity, reparse checks, ACLs and byte copying
 * on native handles. Auth copy never returns secret bytes to this process. */
export function windowsAuthFile(operation: "auth-mode" | "auth-read" | "auth-copy" | "auth-directory", file: string, dest = "", expected?: { dev: number | bigint; ino: number | bigint }): string {
  return execFileSync(nativeHelper(), [operation, file, dest, expected ? String(expected.dev) : "", expected ? String(expected.ino) : ""],
    { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Existing files keep their ACL; ownership and one-link checks precede
 * truncation. Newly created configuration files receive an owner-only DACL. */
export function writeWindowsOwnedText(file: string, content: string): void {
  operate(file, "write", 0, content);
}
