import { execFile, execFileSync, spawn } from "node:child_process";
import { rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
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
      else if(args[0]=="append-private")AppendPrivate(args[1],Convert.FromBase64String(Console.In.ReadToEnd()));
      else if(args[0]=="seal-private") { using(var file=Open(args[1],true,false,true))SealPrivate(file); }
      else if(args[0]=="assess-stdin") { using(var file=new SafeFileHandle(GetStdHandle(-10),false))Console.Write(Assess(file)); }
      else if(args[0]=="directory-write-access")DirectoryWriteAccess(args[1]);
      else if(args[0]=="flush-file" || args[0]=="flush-directory")FlushOwnedPath(args[1],args[0]=="flush-directory");
      else if(args[0]=="owned-pipe")OwnedPipe(args[1]);
      else if(args[0]=="replace-preserve") { if(!ReplaceFile(args[1],args[2],null,0u,IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error()); }
      else if(args[0]=="replace-artifact")ReplaceArtifact(args[1],args[2]);
      else if(args[0]=="replace-copy")ReplaceArtifact(args[1],args[2],false);
      else if(args[0]=="copy-new")CopyNew(args[1],args[2]);
      else if(args[0]=="copy-directory-new")CopyDirectoryNew(args[1],args[2]);
      else if(args[0]=="copy-directory-finish")CopyDirectoryFinish(args[1],Console.In.ReadToEnd(),args[2],args[3],args[4]);
      else if(args[0]=="copy-directory-merge")CopyDirectoryMerge(args[1],args[2],args[3]=="preview");
      else if(args[0]=="move-no-replace") { if(!MoveFileEx(args[1],args[2],8))throw new Win32Exception(Marshal.GetLastWin32Error()); }
      else if(args[0]=="directory-link") { uint attrs=GetFileAttributes(args[1]); if(attrs==uint.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error()); if((attrs&0x400u)==0)throw new InvalidOperationException("Selected entry is not a link"); Console.Write((attrs&0x10u)!=0?"true":"false"); }
      else if(args[0]=="directory-case-sensitive")DirectoryCaseSensitive(args[1]);
      else if(args[0]=="entry-times")EntryTimes(args[1]);
      else if(args[0]=="names-collide")NamesCollide();
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
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation { public long created,accessed,written,changed; public uint attributes; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file,int kind,ref BasicInformation info,uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ReplaceFile(string replaced,string replacement,string backup,uint flags,IntPtr exclude,IntPtr reserved);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInformation info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int kind,out uint info,uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern int CompareStringOrdinal(string a,int aLength,string b,int bLength,bool ignoreCase);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle file);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileEx(string source,string dest,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string path,ref SecurityAttributes security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributes(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DeleteFile(string path);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle file,int type,uint requested,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle file,int type,uint requested,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  delegate uint CopyProgress(long total,long transferred,long size,long used,uint stream,uint reason,IntPtr source,IntPtr destination,IntPtr data);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CopyFileEx(string source,string destination,CopyProgress progress,IntPtr data,IntPtr cancel,uint flags);
  static void CopyNew(string source,string destination) {
    // CopyFileEx keeps alternate streams and native attributes. A protected
    // source DACL must be applied through the copy handle before any bytes,
    // rather than exposing copied content under the parent's inherited ACL.
    using(var pinned=Open(source,false)) {
      var expected=Regular(pinned,false);Exception failure=null;bool checkedAcl=false;
      CopyProgress callback=delegate(long total,long transferred,long size,long used,uint stream,uint reason,IntPtr src,IntPtr dst,IntPtr data) {
        if(checkedAcl)return 0;
        try {
          if(reason!=1 || transferred!=0)throw new InvalidOperationException("Copy lacks a pre-content security callback");
          using(var input=new SafeFileHandle(src,false))using(var output=new SafeFileHandle(dst,false)) {
            var observed=Regular(input,false);Regular(output,false);
            if(observed.volume!=expected.volume || observed.indexHigh!=expected.indexHigh || observed.indexLow!=expected.indexLow)
              throw new InvalidOperationException("Copy source identity changed");
            IntPtr owner,group,dacl,sacl,descriptor;
            uint error=GetSecurityInfo(input,1,4,out owner,out group,out dacl,out sacl,out descriptor);
            if(error!=0)throw new Win32Exception((int)error);
            try {
              var bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);
              var security=new RawSecurityDescriptor(bytes,0);
              if((security.ControlFlags & ControlFlags.DiscretionaryAclProtected)!=0) {
                error=SetSecurityInfo(output,1,0x80000004u,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);
                if(error!=0)throw new Win32Exception((int)error);
                IntPtr o,g,d,s,readback;
                error=GetSecurityInfo(output,1,4,out o,out g,out d,out s,out readback);
                if(error!=0)throw new Win32Exception((int)error);
                try {
                  var actual=new byte[GetSecurityDescriptorLength(readback)];Marshal.Copy(readback,actual,0,actual.Length);
                  var verified=new RawSecurityDescriptor(actual,0);
                  if((verified.ControlFlags & ControlFlags.DiscretionaryAclProtected)==0 || !SameAcl(security.DiscretionaryAcl,verified.DiscretionaryAcl))
                    throw new InvalidOperationException("Copied protected DACL did not persist");
                } finally {LocalFree(readback);}
              }
            } finally {LocalFree(descriptor);}
          }
          checkedAcl=true;return 0;
        } catch(Exception error) {failure=error;return 1;}
      };
      bool copied=CopyFileEx(source,destination,callback,IntPtr.Zero,IntPtr.Zero,1u);
      int code=Marshal.GetLastWin32Error();GC.KeepAlive(callback);
      if(failure!=null)throw failure;
      if(!copied)throw new Win32Exception(code);
      if(!checkedAcl)throw new InvalidOperationException("Copy did not qualify destination security");
    }
  }
  static bool SameAcl(RawAcl left,RawAcl right) {
    if(left==null || right==null)return left==right;
    if(left.BinaryLength!=right.BinaryLength)return false;
    var a=new byte[left.BinaryLength];var b=new byte[right.BinaryLength];left.GetBinaryForm(a,0);right.GetBinaryForm(b,0);
    for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;
    return true;
  }
  static SafeFileHandle CopyDirectoryHandle(string path,bool write) {
    var security=new SecurityAttributes();security.length=Marshal.SizeOf(security);
    var file=CreateFile(path,write?0x60000u:0x20000u,7,ref security,3,0x02200000u,IntPtr.Zero);
    if(file.IsInvalid){int error=Marshal.GetLastWin32Error();file.Dispose();throw new Win32Exception(error);}
    try {CopyDirectoryInfo(file);return file;}catch{file.Dispose();throw;}
  }
  static FileInformation CopyDirectoryInfo(SafeFileHandle file) {
    FileInformation info;
    if(!GetFileInformationByHandle(file,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
    if(GetFileType(file)!=1 || (info.attributes&0x410u)!=0x10u)throw new InvalidOperationException("Copy requires an ordinary directory without a final reparse point");
    return info;
  }
  static byte[] CopyDirectoryDacl(SafeFileHandle file) {
    IntPtr owner,group,dacl,sacl,descriptor;
    uint error=GetSecurityInfo(file,1,4,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0)throw new Win32Exception((int)error);
    try {var bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);return bytes;}
    finally {LocalFree(descriptor);}
  }
  static byte[] PrivateCopyDirectoryDescriptor() {
    using(var identity=WindowsIdentity.GetCurrent()) {
      var acl=new DirectorySecurity();acl.SetOwner(identity.User);acl.SetAccessRuleProtection(true,false);
      acl.AddAccessRule(new FileSystemAccessRule(identity.User,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      return acl.GetSecurityDescriptorBinaryForm();
    }
  }
  static void ApplyCopyDirectoryDacl(SafeFileHandle output,byte[] bytes) {
    var expected=new RawSecurityDescriptor(bytes,0);
    if((expected.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)throw new InvalidOperationException("Captured directory DACL is not protected");
    var pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
    try {
      bool present,defaulted;IntPtr dacl;
      if(!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(),out present,out dacl,out defaulted))throw new InvalidOperationException("Captured directory DACL is invalid");
      uint error=SetSecurityInfo(output,1,0x80000004u,IntPtr.Zero,IntPtr.Zero,present?dacl:IntPtr.Zero,IntPtr.Zero);
      if(error!=0)throw new Win32Exception((int)error);
    } finally {pinned.Free();}
    var actual=new RawSecurityDescriptor(CopyDirectoryDacl(output),0);
    if((actual.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0 || !SameAcl(expected.DiscretionaryAcl,actual.DiscretionaryAcl))throw new InvalidOperationException("Copied directory DACL did not persist");
  }
  static void CopyDirectoryMerge(string source,string destination,bool preview) {
    byte[] snapshot;
    using(var input=CopyDirectoryHandle(source,false))snapshot=CopyDirectoryDacl(input);
    var expected=new RawSecurityDescriptor(snapshot,0);
    if((expected.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0){Console.Write("-\t0");return;}
    FileInformation identity;
    using(var output=CopyDirectoryHandle(destination,false)) {
      identity=CopyDirectoryInfo(output);var actual=new RawSecurityDescriptor(CopyDirectoryDacl(output),0);
      bool changed=(actual.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0 || !SameAcl(expected.DiscretionaryAcl,actual.DiscretionaryAcl);
      if(!changed){Console.Write("-\t0");return;}
      if(preview){Console.Write("-\t1");return;}
    }
    using(var output=CopyDirectoryHandle(destination,true)) {
      var observed=CopyDirectoryInfo(output);
      if(observed.volume!=identity.volume || observed.indexHigh!=identity.indexHigh || observed.indexLow!=identity.indexLow)throw new InvalidOperationException("Merge directory identity changed");
      // Narrow access before copying inherited private children. If final
      // source permissions cannot be applied, do not restore a broader ACL
      // over partially copied content; the failure remains explicit.
      ApplyCopyDirectoryDacl(output,PrivateCopyDirectoryDescriptor());
    }
    Console.Write(Convert.ToBase64String(snapshot)+"\t"+identity.volume+"\t"+identity.indexHigh+"\t"+identity.indexLow);
  }
  static void CopyDirectoryNew(string source,string destination) {
    byte[] snapshot;
    using(var input=CopyDirectoryHandle(source,false))snapshot=CopyDirectoryDacl(input);
    bool protectedAcl=(new RawSecurityDescriptor(snapshot,0).ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0;
    var attributes=new SecurityAttributes();attributes.length=Marshal.SizeOf(attributes);
    GCHandle pinned=default(GCHandle);byte[] creationSecurity=null;
    try {
      // Restrictive final permissions must not prevent recursion. A protected
      // source gets a current-user-only staging DACL from the creation instant;
      // its captured source DACL is restored after children and timestamps.
      if(protectedAcl) {
        creationSecurity=PrivateCopyDirectoryDescriptor();pinned=GCHandle.Alloc(creationSecurity,GCHandleType.Pinned);attributes.descriptor=pinned.AddrOfPinnedObject();
      }
      if(!CreateDirectory(destination,ref attributes))throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {if(pinned.IsAllocated)pinned.Free();}
    using(var output=CopyDirectoryHandle(destination,false)) {
      var info=CopyDirectoryInfo(output);
      if(protectedAcl) {
        var actual=new RawSecurityDescriptor(CopyDirectoryDacl(output),0);var expected=new RawSecurityDescriptor(creationSecurity,0);
        if((actual.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0 || !SameAcl(expected.DiscretionaryAcl,actual.DiscretionaryAcl))throw new InvalidOperationException("Created directory private DACL did not persist");
      }
      Console.Write((protectedAcl?Convert.ToBase64String(snapshot):"-")+"\t"+info.volume+"\t"+info.indexHigh+"\t"+info.indexLow);
    }
  }
  static void CopyDirectoryFinish(string destination,string encoded,string volume,string high,string low) {
    var bytes=Convert.FromBase64String(encoded);
    using(var output=CopyDirectoryHandle(destination,true)) {
      var info=CopyDirectoryInfo(output);
      if(info.volume!=uint.Parse(volume) || info.indexHigh!=uint.Parse(high) || info.indexLow!=uint.Parse(low))throw new InvalidOperationException("Copy directory identity changed");
      ApplyCopyDirectoryDacl(output,bytes);
    }
  }
  static void OwnedPipe(string name) {
    using(var pipe=new System.IO.Pipes.NamedPipeClientStream(".",name,System.IO.Pipes.PipeDirection.InOut,System.IO.Pipes.PipeOptions.None)) {
      pipe.Connect(1500); uint pid;
      if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid))throw new Win32Exception(Marshal.GetLastWin32Error());
      using(var process=System.Diagnostics.Process.GetProcessById((int)pid)) {
        IntPtr token;
        if(!OpenProcessToken(process.Handle,8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
        try { using(var owner=new WindowsIdentity(token))using(var caller=WindowsIdentity.GetCurrent()) {
          if(owner.User.Value!=caller.User.Value)throw new InvalidOperationException("Pipe server must belong to the current user");
          Console.Write(pid+"\t"+process.StartTime.ToUniversalTime().Ticks+"\t"+owner.User.Value);
        } } finally { CloseHandle(token); }
      }
    }
  }
  static void FlushOwnedPath(string path,bool directory) {
    var security=new SecurityAttributes();security.length=Marshal.SizeOf(security);
    using(var file=CreateFile(path,0x40020000u,7,ref security,3,0x02200000u,IntPtr.Zero)) {
      if(file.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInformation info;
      if(GetFileType(file)!=1 || !GetFileInformationByHandle(file,out info) || (info.attributes&0x400u)!=0
        || ((info.attributes&0x10u)!=0)!=directory)throw new InvalidOperationException("Flush requires the selected ordinary file or directory");
      IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(file,1,1,out owner,out group,out dacl,out sacl,out descriptor);
      if(error!=0)throw new Win32Exception((int)error);
      try { using(var identity=WindowsIdentity.GetCurrent()) { if(new SecurityIdentifier(owner).Value!=identity.User.Value)throw new InvalidOperationException("Flush path must be owned"); } }
      finally { LocalFree(descriptor); }
      if(!FlushFileBuffers(file))throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
  static void EntryTimes(string path) {
    var security=new SecurityAttributes();security.length=Marshal.SizeOf(security);
    using(var file=CreateFile(path,0x80u,7,ref security,3,0x02200000u,IntPtr.Zero)) {
      if(file.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInformation info;if(!GetFileInformationByHandle(file,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
      long accessed=((long)info.accessed.dwHighDateTime<<32)|(uint)info.accessed.dwLowDateTime;
      long written=((long)info.written.dwHighDateTime<<32)|(uint)info.written.dwLowDateTime;
      ulong inode=((ulong)info.indexHigh<<32)|info.indexLow;
      Console.Write(info.volume+" "+inode+" "+(accessed-116444736000000000L)+" "+(written-116444736000000000L));
    }
  }
  static void DirectoryCaseSensitive(string path) {
    var security=new SecurityAttributes();security.length=Marshal.SizeOf(security);
    using(var file=CreateFile(path,0x80u,7,ref security,3,0x02200000u,IntPtr.Zero)) {
      if(file.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInformation info;if(!GetFileInformationByHandle(file,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
      if((info.attributes&0x410u)!=0x10u)throw new InvalidOperationException("Case query requires an ordinary directory");
      uint flags;
      // FILE_INFO_BY_HANDLE_CLASS.FileCaseSensitiveInfo = 23; enabled flag = 1.
      if(!GetFileInformationByHandleEx(file,23,out flags,4)) {
        int error=Marshal.GetLastWin32Error();if(error==87 || error==50){Console.Write("false");return;}throw new Win32Exception(error);
      }
      Console.Write((flags&1u)!=0?"true":"false");
    }
  }
  static int CompareNames(string a,string b) {
    int result=CompareStringOrdinal(a,a.Length,b,b.Length,true);
    if(result==0)throw new Win32Exception(Marshal.GetLastWin32Error());return result-2;
  }
  static void NamesCollide() {
    string[] encoded=Console.In.ReadToEnd().Split(new char[]{'\n'},StringSplitOptions.RemoveEmptyEntries);
    string[] names=Array.ConvertAll(encoded,value=>System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(value)));
    Array.Sort(names,CompareNames);
    for(int i=1;i<names.Length;i++)if(CompareNames(names[i-1],names[i])==0){Console.Write("true");return;}
    Console.Write("false");
  }
  static SafeFileHandle Open(string path,bool write,bool fresh=false,bool seal=false) {
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
      var file=CreateFile(path,write?(seal?0x40060000u:0x40020000u):0x80000000u,write?0u:1u,ref security,write?(fresh?1u:4u):3u,0x00200000u,IntPtr.Zero);
      if(file.IsInvalid) {
        int error=Marshal.GetLastWin32Error(); file.Dispose();
        if(error==2 || error==3) throw new FileNotFoundException("input file missing");
        throw new Win32Exception(error);
      }
      return file;
    } finally { if(pinned.IsAllocated)pinned.Free(); }
  }
  static void DirectoryWriteAccess(string path) {
    var security=new SecurityAttributes(); security.length=Marshal.SizeOf(security);
    // FILE_ADD_FILE, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS. Windows checks
    // the calling token against the directory DACL without creating a child.
    using(var file=CreateFile(path,2u,7u,ref security,3u,0x02000000u,IntPtr.Zero)) {
      if(file.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInformation info;
      if(!GetFileInformationByHandle(file,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
      if((info.attributes & 0x10u)==0)throw new InvalidOperationException("state path must be a directory");
    }
  }
  static SafeFileHandle AttributeHandle(string path) {
    var security=new SecurityAttributes(); security.length=Marshal.SizeOf(security);
    var file=CreateFile(path,0x180u,7u,ref security,3u,0x00200000u,IntPtr.Zero);
    if(file.IsInvalid) { int error=Marshal.GetLastWin32Error(); file.Dispose(); throw new Win32Exception(error); }
    return file;
  }
  static void Attributes(SafeFileHandle file,uint attributes) {
    var basic=new BasicInformation(); basic.attributes=attributes==0?0x80u:attributes;
    if(!SetFileInformationByHandle(file,0,ref basic,(uint)Marshal.SizeOf(basic)))throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static void ReplaceArtifact(string target,string staging,bool retainDestinationReadonly=true) {
    using(var original=AttributeHandle(target))using(var replacement=AttributeHandle(staging)) {
      var oldInfo=Regular(original,false); var newInfo=Regular(replacement,false);
      bool oldReadOnly=(oldInfo.attributes&1u)!=0, newReadOnly=(newInfo.attributes&1u)!=0, replaced=false;
      try {
        if(oldReadOnly)Attributes(original,oldInfo.attributes&~1u);
        if(newReadOnly)Attributes(replacement,newInfo.attributes&~1u);
        if(!ReplaceFile(target,staging,null,0u,IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
        replaced=true;
      } finally {
        // Restore through pinned handles, never an uncertain pathname after a
        // failed native replacement. Retained hard-link aliases keep readonly.
        try { if(oldReadOnly && (!replaced || oldInfo.links>1))Attributes(original,oldInfo.attributes); }
        finally {
          if(replaced && oldReadOnly && retainDestinationReadonly)Attributes(replacement,newInfo.attributes|1u);
          else if(newReadOnly)Attributes(replacement,newInfo.attributes);
        }
      }
    }
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
  static void AppendPrivate(string path,byte[] bytes) {
    try {
      using(var file=Open(path,true,false,true)) {
        SealPrivate(file);
        using(var stream=new FileStream(file,FileAccess.Write)) {
          stream.Seek(0,SeekOrigin.End);stream.Write(bytes,0,bytes.Length);stream.Flush(true);
        }
      }
    } finally { Array.Clear(bytes,0,bytes.Length); }
  }
  static void SealPrivate(SafeFileHandle file) {
    Regular(file,true,true); // ownership and one-link checks precede ACL changes.
    using(var identity=WindowsIdentity.GetCurrent()) {
      var acl=new FileSecurity();acl.SetOwner(identity.User);acl.SetAccessRuleProtection(true,false);
      acl.AddAccessRule(new FileSystemAccessRule(identity.User,FileSystemRights.FullControl,AccessControlType.Allow));
      var bytes=acl.GetSecurityDescriptorBinaryForm();var pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
      try {
        bool present,defaulted;IntPtr dacl;
        if(!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(),out present,out dacl,out defaulted) || !present)throw new InvalidOperationException("private file DACL missing");
        uint error=SetSecurityInfo(file,1,0x80000004u,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);
        if(error!=0)throw new Win32Exception((int)error);
      } finally { pinned.Free(); }
    }
    Private(file);
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
    } finally {
      if(!DeleteFile(temporary)) {
        int error=Marshal.GetLastWin32Error();
        if(error!=2 && error!=3)throw new Win32Exception(error);
      }
    }
  }
  static void EnsurePrivateDirectory(string path,ref SecurityAttributes security) {
    uint attributes=GetFileAttributes(path);
    if(attributes!=uint.MaxValue) {
      if((attributes & 0x10u)==0)throw new InvalidOperationException("auth profile path must be a directory");
      return;
    }
    int error=Marshal.GetLastWin32Error();
    if(error!=2 && error!=3)throw new Win32Exception(error);
    int split=path.LastIndexOf('\\');
    if(split<0)throw new InvalidOperationException("auth profile path must be absolute");
    string parent=path.Substring(0,split);
    if(parent.Length==6 && parent[5]==':')parent+="\\";
    EnsurePrivateDirectory(parent,ref security);
    if(!CreateDirectory(path,ref security)) {
      error=Marshal.GetLastWin32Error();
      if(error!=183)throw new Win32Exception(error);
    }
  }
  static void AuthDirectory(string path) {
    using(var identity=WindowsIdentity.GetCurrent()) {
      var acl=new DirectorySecurity();acl.SetOwner(identity.User);acl.SetAccessRuleProtection(true,false);
      acl.AddAccessRule(new FileSystemAccessRule(identity.User,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      var security=new SecurityAttributes();security.length=Marshal.SizeOf(security);
      var creationBytes=acl.GetSecurityDescriptorBinaryForm();var creation=GCHandle.Alloc(creationBytes,GCHandleType.Pinned);
      try { security.descriptor=creation.AddrOfPinnedObject();EnsurePrivateDirectory(path,ref security); }
      finally { creation.Free(); }
      security.descriptor=IntPtr.Zero;
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
function retireFailedCompilation(file: string, directory: string, error: unknown): void {
  if (!error || typeof error !== "object") return;
  const failure = error as { status?: number; code?: string | number; signal?: string; killed?: boolean; syscall?: string };
  if (failure.killed || failure.signal || failure.code === "ETIMEDOUT") return;
  const exited = (typeof failure.status === "number" && failure.status > 0)
    || (typeof failure.code === "number" && failure.code > 0);
  const neverStarted = failure.syscall?.startsWith("spawn")
    && ["ENOENT", "EACCES", "ENOEXEC"].includes(String(failure.code));
  if (!exited && !neverStarted) return;
  // These are the exact paths this compilation created. Never recursively
  // remove an unexpected entry, or discard output after uncertain termination.
  try { unlinkSync(file); } catch { /* Missing or still held: retain safely. */ }
  try { rmdirSync(directory); } catch { /* Keep any remaining owned material. */ }
}
async function nativeHelperAsync(): Promise<string> {
  if (executable) return executable;
  if (!compiling) compiling = (async () => {
    const directory = await createWindowsPrivateDirectoryAsync(tmpdir());
    const file = join(directory, "owned-text.exe");
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -OutputAssembly $env:OPENRIG_OWNED_TEXT_HELPER -OutputType ConsoleApplication";
    await new Promise<void>((resolveRun, reject) => {
      const compiler = execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { env: { ...process.env, TEMP: directory, TMP: directory, OPENRIG_OWNED_TEXT_HELPER: file }, windowsHide: true, timeout: 10_000 },
        error => error ? reject(error) : resolveRun());
      compiler.stdin!.end(FILE_SOURCE);
    }).catch(error => { retireFailedCompilation(file, directory, error); throw error; });
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
  try {
    execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, TEMP: directory, TMP: directory, OPENRIG_OWNED_TEXT_HELPER: file }, input: FILE_SOURCE, windowsHide: true, timeout: 10_000, stdio: "pipe" });
  } catch (error) { retireFailedCompilation(file, directory, error); throw error; }
  executable = file;
  process.once("exit", () => {
    try { unlinkSync(file); rmdirSync(directory); } catch { /* retain the exact owned helper if cleanup is unavailable */ }
  });
  return file;
}

/** Stage the native assembly once before a worker's synchronous log barrier.
 * The worker receives only the executable path and performs all log I/O. */
export function windowsPrivateAppendHelper(): string { return nativeHelper(); }

/** Ask Windows for FILE_ADD_FILE on the existing directory, without creating
 * a child or changing its metadata. The OS evaluates the actual process token. */
export function checkWindowsDirectoryWriteAccess(directory: string): void {
  execFileSync(nativeHelper(), ["directory-write-access", toNamespacedPath(directory)], {
    windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Native file data/metadata barrier; directories require a writable backup-semantics handle. */
export function flushWindowsOwnedPath(file: string, directory = false): void {
  execFileSync(nativeHelper(), [directory ? "flush-directory" : "flush-file", toNamespacedPath(file)], {
    windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Apply the native owner-only inherited directory ACL before writing private state. */
export function ensureWindowsPrivateDirectory(directory: string): void {
  execFileSync(nativeHelper(), ["auth-directory", toNamespacedPath(directory)], {
    windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Observe the local pipe's real server process and require the caller's SID. */
export function inspectWindowsOwnedPipe(pipe: string): { pid: number; started: string; sid: string } {
  if (!/^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/i.test(pipe)) throw new Error("Select a local named pipe with a single literal name");
  const output = execFileSync(nativeHelper(), ["owned-pipe", pipe.slice(9)], {
    windowsHide: true, timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const [pid, started, sid] = output.split("\t");
  if (!pid || !/^[1-9][0-9]*$/.test(pid) || !started || !/^[0-9]+$/.test(started) || !sid || !/^S-1-[0-9-]+$/.test(sid)) throw new Error("Incomplete native pipe identity");
  return { pid: Number(pid), started, sid };
}

/** Replace an existing file using Windows metadata-preserving replacement.
 * Only explicit proof replacement may temporarily clear readonly attributes;
 * pinned handles restore them on success/failure. No ignore-ACL-errors flags. */
export function replaceWindowsFilePreservingMetadata(target: string, staging: string, explicitArtifactReplacement = false): void {
  execFileSync(nativeHelper(), [explicitArtifactReplacement ? "replace-artifact" : "replace-preserve", toNamespacedPath(target), toNamespacedPath(staging)], {
    windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** File-copy replacement takes the staged source's readonly state, while
 * preserving the destination DACL and restoring any retained hardlink inode. */
export function replaceWindowsCopiedFile(target: string, staging: string): void {
  execFileSync(nativeHelper(), ["replace-copy", toNamespacedPath(target), toNamespacedPath(staging)], {
    windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Exclusive native regular-file copy. Protected source DACLs are installed
 * before content; unprotected ACL inheritance and owner/group are unchanged. */
export function copyWindowsFileNew(source: string, destination: string): void {
  execFileSync(nativeHelper(), ["copy-new", toNamespacedPath(source), toNamespacedPath(destination)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface WindowsCopiedDirectorySecurity { descriptor: string; volume: string; high: string; low: string }

function copiedDirectorySecurity(output: string): WindowsCopiedDirectorySecurity | undefined {
  const [descriptor, volume, high, low] = output.split("\t");
  if (!descriptor || !volume || !high || !low || ![volume, high, low].every(value => /^[0-9]+$/.test(value))) throw new Error("Incomplete copied directory security identity");
  return descriptor === "-" ? undefined : { descriptor, volume, high, low };
}

/** Create exclusively; protected source directories stay private throughout recursion. */
export function createWindowsCopiedDirectory(source: string, destination: string): WindowsCopiedDirectorySecurity | undefined {
  const output = execFileSync(nativeHelper(), ["copy-directory-new", toNamespacedPath(source), toNamespacedPath(destination)], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  return copiedDirectorySecurity(output);
}

/** Preview protected ACL drift without writes, or narrow an existing merge
 * directory before content and return its captured final DACL and identity. */
export function prepareWindowsDirectoryMerge(source: string, destination: string, preview: boolean): { changed: boolean; security?: WindowsCopiedDirectorySecurity } {
  const output = execFileSync(nativeHelper(), ["copy-directory-merge", toNamespacedPath(source), toNamespacedPath(destination), preview ? "preview" : "apply"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (output === "-\t0") return { changed: false };
  if (preview && output === "-\t1") return { changed: true };
  const security = copiedDirectorySecurity(output);
  if (!security) throw new Error("Incomplete merge directory security");
  return { changed: true, security };
}

/** Apply the captured protected DACL only to the qualified ordinary directory inode. */
export function finishWindowsCopiedDirectory(destination: string, security: WindowsCopiedDirectorySecurity): void {
  execFileSync(nativeHelper(), ["copy-directory-finish", toNamespacedPath(destination), security.volume, security.high, security.low], {
    input: security.descriptor, windowsHide: true, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Same-volume move without MOVEFILE_REPLACE_EXISTING; never clobbers a new occupant. */
export function moveWindowsEntryNoReplace(source: string, destination: string): void {
  execFileSync(nativeHelper(), ["move-no-replace", toNamespacedPath(source), toNamespacedPath(destination)], {
    windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Inspect the link entry itself; following a file-typed link to a directory fails on NTFS. */
export function isWindowsDirectoryLink(file: string): boolean {
  return execFileSync(nativeHelper(), ["directory-link", toNamespacedPath(file)], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  }) === "true";
}

/** No-follow native timestamps, checked against the caller's lstat identity. */
export function readWindowsEntryTimes(file: string, expected: { dev: number; ino: number }): { atime: number; mtime: number; atimeMs: number; mtimeMs: number } {
  const output = execFileSync(nativeHelper(), ["entry-times", toNamespacedPath(file)], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(" ");
  if (output.length !== 4 || output.some(value => !/^-?\d+$/.test(value))) throw new Error("Invalid native entry times");
  if (Number(output[0]) !== expected.dev || Number(output[1]) !== expected.ino) throw new Error("File identity changed while reading native entry times");
  const seconds = (value: string) => { const ticks = BigInt(value); return Number(ticks >= 0n ? ticks / 10_000_000n : (ticks - 9_999_999n) / 10_000_000n); };
  return { atime: seconds(output[2]!), mtime: seconds(output[3]!), atimeMs: Number(BigInt(output[2]!)) / 10_000, mtimeMs: Number(BigInt(output[3]!)) / 10_000 };
}

export function isWindowsDirectoryCaseSensitive(file: string): boolean {
  return execFileSync(nativeHelper(), ["directory-case-sensitive", toNamespacedPath(file)], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  }) === "true";
}

/** Use Windows ordinal casing rather than JavaScript's Unicode lowercase mapping. */
export function windowsNamesCollide(names: readonly string[]): boolean {
  if (names.length < 2) return false;
  // ASCII casing is identical and needs no helper process for ordinary trees.
  if (names.every(name => /^[\x00-\x7f]*$/.test(name))) return new Set(names.map(name => name.toLowerCase())).size !== names.length;
  return execFileSync(nativeHelper(), ["names-collide"], {
    input: names.map(name => Buffer.from(name,"utf8").toString("base64")).join("\n"),
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
  }) === "true";
}

/** Synchronous append for existing synchronous receipt writers: native owner,
 * one-link and DACL checks/tightening precede append and durable flush. */
export function appendWindowsPrivateText(file: string, content: string): void {
  execFileSync(nativeHelper(), ["append-private", toNamespacedPath(file)], {
    input: Buffer.from(content, "utf8").toString("base64"), windowsHide: true,
    timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
  });
}

function operate(file: string, operation: "read" | "read-owned" | "write", limit: number, content = ""): string {
  try {
    return execFileSync(nativeHelper(), [operation, toNamespacedPath(file), String(limit)], {
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
  return execFileSync(nativeHelper(), [operation, toNamespacedPath(file), dest ? toNamespacedPath(dest) : "", expected ? String(expected.dev) : "", expected ? String(expected.ino) : ""],
    { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Existing files keep their ACL; ownership and one-link checks precede
 * truncation. Newly created configuration files receive an owner-only DACL. */
export function writeWindowsOwnedText(file: string, content: string): void {
  operate(file, "write", 0, content);
}
