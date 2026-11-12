import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { closeSync, linkSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
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
try {
  $stream=New-Object IO.FileStream($env:OPENRIG_PRIVATE_TEXT_FILE,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]'Write,ReadPermissions',[IO.FileShare]::None,4096,[IO.FileOptions]::None,$acl)
} catch {
  $cause=$_.Exception
  while($cause.InnerException){$cause=$cause.InnerException}
  if(($cause.HResult -band 65535) -in @(80,183)){[Console]::Error.WriteLine('OPENRIG_PRIVATE_FILE_EXISTS');exit 17}
  throw
}
try {
  $actual=$stream.GetAccessControl()
  $rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited -or ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'Private file DACL mismatch'}
  $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
  try {$stream.Write($bytes,0,$bytes.Length)} finally {[Array]::Clear($bytes,0,$bytes.Length)}
} finally {$stream.Dispose()}
`;

function privateCreationError(error: unknown): unknown {
  const failure = error as Error & { status?: number; code?: string | number; stderr?: string | Buffer };
  if ((failure.status === 17 || failure.code === 17) && String(failure.stderr).trim() === "OPENRIG_PRIVATE_FILE_EXISTS") failure.code = "EEXIST";
  return error;
}

/** Create a new staging file with private access before writing any bytes.
 * Existing paths (including links) are never opened or overwritten. Windows
 * mode bits are insufficient: create and verify a protected current-SID DACL
 * on the same handle that writes. Content travels only through child stdin. */
export function createPrivateTextFile(file: string, content: string): void {
  if (process.platform !== "win32") {
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    return;
  }
  try { execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(CREATE_PRIVATE_FILE, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_PRIVATE_TEXT_FILE: file }, input: Buffer.from(content, "utf8").toString("base64"),
      windowsHide: true, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) { throw privateCreationError(error); }
}

/** Windows atomic replacement: establish private access before content, then
 * publish the staging inode. A failed publish leaves the prior destination.
 * Callers retain their existing POSIX persistence and failure contracts. */
export function replaceWindowsPrivateTextFile(file: string, content: string): void {
  const staging = join(dirname(file), `.openrig-private-${randomUUID()}.tmp`);
  let created = false;
  try {
    createPrivateTextFile(staging, content);
    created = true;
    renameSync(staging, file);
  } finally {
    if (created) {
      try { unlinkSync(staging); } catch { /* published, or retain owned private staging on cleanup failure */ }
    }
  }
}

/** Async publication for callers whose serialization already awaits storage.
 * Private creation precedes bytes; rename preserves the prior destination on
 * failure without blocking the daemon while PowerShell establishes the DACL. */
export async function replaceWindowsPrivateTextFileAsync(file: string, content: string): Promise<void> {
  const staging = join(dirname(file), `.openrig-private-${randomUUID()}.tmp`);
  let created = false;
  try {
    await createPrivateTextFileAsync(staging, content);
    created = true;
    await fs.rename(staging, file);
  } finally {
    if (created) {
      try { await fs.unlink(staging); } catch { /* published, or retain owned private staging on cleanup failure */ }
    }
  }
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

/** Establish the same private directory boundary without blocking async callers. */
export async function createWindowsPrivateDirectoryAsync(parent: string): Promise<string> {
  const directory = join(parent, `.openrig-private-${randomUUID()}`);
  await runPrivateScript(CREATE_PRIVATE_DIRECTORY, { OPENRIG_PRIVATE_TEXT_DIRECTORY: directory });
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

function runPrivateScript(script: string, values: NodeJS.ProcessEnv, input = ""): Promise<void> {
  return new Promise((resolveRun, reject) => {
    let inputError: Error | undefined;
    const child = execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, ...values }, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, _stdout, stderr) => {
        if (error) reject(privateCreationError(Object.assign(error, { stderr })));
        else if (inputError) reject(inputError);
        else resolveRun();
      });
    // A constructor refusal can close stdin before its structured error is
    // delivered. Keep that process error authoritative over the resulting EPIPE.
    child.stdin?.on("error", error => { inputError = error; });
    child.stdin?.end(input);
  });
}

/** Exclusive private creation without blocking the daemon on native startup. */
export async function createPrivateTextFileAsync(file: string, content: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.writeFile(file, content, { mode: 0o600, flag: "wx" });
    return;
  }
  await runPrivateScript(CREATE_PRIVATE_FILE, { OPENRIG_PRIVATE_TEXT_FILE: file }, Buffer.from(content, "utf8").toString("base64"));
}

const CHECK_PRIVATE_DIRECTORY = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$path=$env:OPENRIG_PRIVATE_TEXT_DIRECTORY
if(([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Private parent is a reparse point'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[IO.Directory]::GetAccessControl($path)
if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Private parent owner mismatch'}
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'})
if($rules.Count -eq 0){throw 'Private parent has no access rule'}
foreach($rule in $rules){if($rule.IdentityReference.Value -ne $sid.Value){throw 'Private parent grants another identity access'}}
`;

/** Check the existing parent policy, like the POSIX UID/mode check. This does
 * not change ACLs or grant access to a shared destination. */
export async function assertWindowsPrivateDirectory(directory: string): Promise<void> {
  await runPrivateScript(CHECK_PRIVATE_DIRECTORY, { OPENRIG_PRIVATE_TEXT_DIRECTORY: directory });
}

/** Async counterpart for observational sinks: preparing or appending to an
 * archive must not block ordinary sends on PowerShell compilation/startup. */
export async function openPrivateTextHandle(file: string): Promise<fs.FileHandle> {
  if (process.platform !== "win32") return fs.open(file, "wx", 0o600);
  const directory = join(dirname(resolve(file)), `.openrig-private-${randomUUID()}`);
  await runPrivateScript(CREATE_PRIVATE_DIRECTORY, { OPENRIG_PRIVATE_TEXT_DIRECTORY: directory });
  const staging = join(directory, "output");
  let handle: fs.FileHandle | undefined;
  try {
    await runPrivateScript(CREATE_PRIVATE_FILE, { OPENRIG_PRIVATE_TEXT_FILE: staging });
    handle = await fs.open(staging, "r+");
    await fs.link(staging, file);
    await fs.unlink(staging);
    await fs.rmdir(directory);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(staging).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
}
