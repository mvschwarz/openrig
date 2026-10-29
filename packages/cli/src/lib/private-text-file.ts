import { execFileSync } from "node:child_process";
import { closeSync, linkSync, openSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const CREATE_PRIVATE_FILE = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
$stream=New-Object IO.FileStream($env:OPENRIG_PRIVATE_TEXT_FILE,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]'Write,ReadPermissions',[IO.FileShare]::None,4096,[IO.FileOptions]::None,$acl)
try {
  $actual=$stream.GetAccessControl()
  $rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited -or ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'Private file DACL mismatch'}
  $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
  try {$stream.Write($bytes,0,$bytes.Length)} finally {[Array]::Clear($bytes,0,$bytes.Length)}
} finally {$stream.Dispose()}
`;

/** Create a new staging file with private access before writing any bytes.
 * Existing paths (including links) are never opened or overwritten. Windows
 * mode bits are insufficient: create and verify a protected current-SID DACL
 * on the same handle that writes. Content travels only through child stdin. */
export function createPrivateTextFile(file: string, content: string): void {
  if (process.platform !== "win32") {
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    return;
  }
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(CREATE_PRIVATE_FILE, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_PRIVATE_TEXT_FILE: file }, input: Buffer.from(content, "utf8").toString("base64"),
      windowsHide: true, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
}

const CREATE_PRIVATE_DIRECTORY = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$path=$env:OPENRIG_PRIVATE_TEXT_DIRECTORY
if([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)){throw 'Private staging directory exists'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
$null=[IO.Directory]::CreateDirectory($path,$acl)
if(([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Private staging directory is a reparse point'}
$actual=[IO.Directory]::GetAccessControl($path)
$rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited -or ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'Private staging directory DACL mismatch'}
`;

/** Create and verify a current-SID-only directory before staging any file. */
export function createWindowsPrivateDirectory(parent: string): string {
  const directory = join(parent, `.openrig-private-${randomUUID()}`);
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(CREATE_PRIVATE_DIRECTORY, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_PRIVATE_TEXT_DIRECTORY: directory }, windowsHide: true, timeout: 10_000, stdio: "pipe" });
  return directory;
}

/** An exclusive, private output descriptor for incremental writes. A protected
 * sibling directory establishes the boundary before Node opens its staging
 * file. Linking publishes that already-open inode without replacing any
 * destination; removing the staging name leaves the descriptor bound to it. */
export function openPrivateTextFile(file: string): number {
  if (process.platform !== "win32") return openSync(file, "wx", 0o600);
  const directory = createWindowsPrivateDirectory(dirname(resolve(file)));
  const staging = join(directory, "output");
  let fd: number | undefined;
  try {
    createPrivateTextFile(staging, "");
    fd = openSync(staging, "r+");
    linkSync(staging, file); // EEXIST never overwrites a prior result or link.
    unlinkSync(staging);
    rmdirSync(directory);
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(staging); } catch { /* no file, or retained for recovery */ }
    try { rmdirSync(directory); } catch { /* retain only the owned staging path */ }
    throw error;
  }
}
