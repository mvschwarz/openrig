import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

function acl(directory: string, script: string, sddl = ""): string {
  return execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_TEST_DIRECTORY: directory, OPENRIG_TEST_SDDL: sddl }, encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

export function windowsDirectoryAccess(directory: string): string {
  return acl(directory, "[Console]::Write([IO.Directory]::GetAccessControl($env:OPENRIG_TEST_DIRECTORY).GetSecurityDescriptorSddlForm('Access'))");
}

/** Deny new directory entries without changing existing files' inherited access. */
export function denyWindowsDirectoryCreation(directory: string): () => void {
  const original = acl(directory, String.raw`
$path=$env:OPENRIG_TEST_DIRECTORY; $a=[IO.Directory]::GetAccessControl($path)
[Console]::Write($a.GetSecurityDescriptorSddlForm('Access'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'CreateFiles,CreateDirectories','None','None','Deny')))
[IO.Directory]::SetAccessControl($path,$a)
`);
  return () => { acl(directory, "$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm($env:OPENRIG_TEST_SDDL,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($env:OPENRIG_TEST_DIRECTORY,$a)", original); };
}

/** Permit new subdirectories but deny file creation in them (owned fixtures only). */
export function denyWindowsFileCreation(directory: string): () => void {
  const original = acl(directory, String.raw`
$path=$env:OPENRIG_TEST_DIRECTORY; $a=[IO.Directory]::GetAccessControl($path)
[Console]::Write($a.GetSecurityDescriptorSddlForm('Access'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'CreateFiles','ContainerInherit','None','Deny')))
[IO.Directory]::SetAccessControl($path,$a)
`);
  return () => { acl(directory, "$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm($env:OPENRIG_TEST_SDDL,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($env:OPENRIG_TEST_DIRECTORY,$a)", original); };
}

/** Only call for this test's newly created directory; restore before cleanup. */
export function denyDirectoryChildren(directory: string): () => void {
  if (process.platform !== "win32") { chmodSync(directory, 0o500); return () => chmodSync(directory, 0o700); }
  const original = acl(directory, String.raw`
$path=$env:OPENRIG_TEST_DIRECTORY; $a=[IO.Directory]::GetAccessControl($path)
[Console]::Write($a.GetSecurityDescriptorSddlForm('Access'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'CreateFiles,CreateDirectories','ContainerInherit,ObjectInherit','None','Deny')))
[IO.Directory]::SetAccessControl($path,$a)
`);
  return () => { acl(directory, "$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm($env:OPENRIG_TEST_SDDL,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($env:OPENRIG_TEST_DIRECTORY,$a)", original); };
}

/** Make an owned synthetic directory observably nonprivate on either OS. */
export function grantDirectoryReadToOthers(directory: string): void {
  if (process.platform !== "win32") { chmodSync(directory, 0o755); return; }
  acl(directory, String.raw`
$path=$env:OPENRIG_TEST_DIRECTORY; $a=[IO.Directory]::GetAccessControl($path)
$sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
[IO.Directory]::SetAccessControl($path,$a)
`);
}
