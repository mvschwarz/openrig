import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface PrivateConfig { path: string; dispose(): Promise<void> }
const exec = promisify(execFile);
const PROTECT_DIRECTORY = String.raw`
$ErrorActionPreference='Stop'
$path=$env:OPENRIG_PRIVATE_CONFIG_DIRECTORY
if ([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)) { throw 'Private config directory already exists' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
$null=[IO.Directory]::CreateDirectory($path,$acl)
if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private config directory is a reparse point' }
$actual=[IO.Directory]::GetAccessControl($path)
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private config ownership/protection mismatch' }
$rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Private config DACL mismatch' }
`;

/** Create with a protected current-SID DACL BEFORE writing any private value.
 * POSIX mode bits alone do not establish an equivalent boundary on Windows. */
export async function writeWindowsPrivateConfig(content: string): Promise<PrivateConfig> {
  const directory = join(tmpdir(), `openrig-private-config-${randomUUID()}`);
  await exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROTECT_DIRECTORY], {
    env: { ...process.env, OPENRIG_PRIVATE_CONFIG_DIRECTORY: directory }, windowsHide: true, timeout: 5000,
  });
  const file = join(directory, "environment.conf");
  const dispose = async () => { await unlink(file); await rmdir(directory); };
  try { await writeFile(file, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { await unlink(file).catch(() => {}); await rmdir(directory).catch(() => {}); throw error; }
  return { path: file, dispose };
}

/** psmux's quoted parser decodes only quote/backslash. Its explicit T modifier
 * creates LF after physical config-line parsing; ## prevents format execution. */
export function psmuxPrivateEnvironmentLine(key: string, value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("Invalid environment assignment");
  const format = value.replaceAll("#", "##").replaceAll("\n", "#{T:#{l:%n}}");
  const quoted = '"' + format.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  return `set-environment -F ${key} ${quoted}\n`;
}
