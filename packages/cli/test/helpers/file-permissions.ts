import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

/** Deny data access to an owned fixture only; restore its DACL before cleanup. */
export function denyFixtureFile(file: string, access: "read" | "write"): () => void {
  if (process.platform !== "win32") {
    chmodSync(file, access === "read" ? 0o000 : 0o444);
    return () => chmodSync(file, 0o644);
  }
  const run = (script: string, sddl = "") => execFileSync(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_TEST_FILE: file, OPENRIG_TEST_SDDL: sddl }, encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  const original = run(`
$p=$env:OPENRIG_TEST_FILE;$a=[IO.File]::GetAccessControl($p)
[Console]::Write($a.GetSecurityDescriptorSddlForm('Access'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'${access === "read" ? "ReadData" : "WriteData,AppendData"}','Deny')))
[IO.File]::SetAccessControl($p,$a)
`);
  return () => { run("$a=New-Object Security.AccessControl.FileSecurity;$a.SetSecurityDescriptorSddlForm($env:OPENRIG_TEST_SDDL,[Security.AccessControl.AccessControlSections]::Access);[IO.File]::SetAccessControl($env:OPENRIG_TEST_FILE,$a)", original); };
}
