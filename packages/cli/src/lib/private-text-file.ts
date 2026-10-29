import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
