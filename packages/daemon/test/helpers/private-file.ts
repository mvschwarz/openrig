import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

/** Shared test oracle: inspect the OS boundary, not synthetic Windows mode bits. */
export function expectPrivateFile(file: string): void {
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return;
  }
  const script = String.raw`
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[IO.File]::GetAccessControl($env:OPENRIG_PRIVATE_FILE_TEST)
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
[Console]::Write(($acl.AreAccessRulesProtected -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and !$rules[0].IsInherited -and $rules[0].AccessControlType -eq 'Allow' -and ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl).ToString())
`;
  const output = execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_PRIVATE_FILE_TEST: file }, windowsHide: true, encoding: "utf8", timeout: 10_000 });
  expect(output.trim()).toBe("True");
}
