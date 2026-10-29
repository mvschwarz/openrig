import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** The opened handle supplies both the ACL and the bytes. FileShare.Read
 * prevents replacing/writing the selected file between verification and read.
 * Inherited rules are acceptable only when they grant access to this SID alone.
 * No ACL is changed and no credential value is returned to the daemon. */
export const OPEN_WINDOWS_PRIVATE_API_KEY = String.raw`
$openrigKeyStream=[IO.File]::Open($openrigKeyPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  if($openrigKeyStream.PSObject.Methods['GetAccessControl']){$openrigKeyAcl=$openrigKeyStream.GetAccessControl()}
  else{$openrigKeyAcl=[IO.FileSystemAclExtensions]::GetAccessControl($openrigKeyStream)}
  $openrigKeySid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  if($openrigKeyAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $openrigKeySid.Value){throw 'API-key file owner mismatch'}
  $openrigKeyRules=$openrigKeyAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  $openrigKeyAllows=@($openrigKeyRules | Where-Object {$_.AccessControlType -eq 'Allow'})
  if($openrigKeyAllows.Count -eq 0){throw 'API-key file has no private access rule'}
  foreach($openrigKeyRule in $openrigKeyAllows){if($openrigKeyRule.IdentityReference.Value -ne $openrigKeySid.Value){throw 'API-key file grants access to another identity'}}
  if($openrigKeyStream.Length -lt 1 -or $openrigKeyStream.Length -gt 8192){throw 'API-key file size is invalid'}
} catch { $openrigKeyStream.Dispose(); throw }
`;

/** Keep credential bytes/strings out of PowerShell variable tracing. The
 * generated script and compiled helper contain no credential or file path. */
export const APPLY_WINDOWS_PRIVATE_API_KEY = String.raw`
if(-not ('OpenRigPrivateApiKeyV1' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
public static class OpenRigPrivateApiKeyV1 {
  public static void Apply(FileStream stream, ProcessStartInfo child) {
    byte[] bytes = new byte[8193];
    try {
      int used = 0, read;
      do { read = stream.Read(bytes, used, bytes.Length - used); used += read; }
      while (read > 0 && used < bytes.Length);
      if (used > 8192) throw new InvalidDataException();
      char[] whitespace = new char[] { (char)9,(char)10,(char)11,(char)12,(char)13,(char)32,(char)160,(char)5760,(char)8192,(char)8193,(char)8194,(char)8195,(char)8196,(char)8197,(char)8198,(char)8199,(char)8200,(char)8201,(char)8202,(char)8232,(char)8233,(char)8239,(char)8287,(char)12288,(char)65279 };
      string key = new UTF8Encoding(false, true).GetString(bytes, 0, used).Trim(whitespace);
      if (key.Length == 0) throw new InvalidDataException();
      foreach (char c in key) if (c < '!' || c > '~') throw new InvalidDataException();
      child.EnvironmentVariables["ANTHROPIC_API_KEY"] = key;
    } finally { Array.Clear(bytes, 0, bytes.Length); }
  }
}
'@
}
`;

export function windowsApiKeyFileProblem(file: string): string | null {
  const script = `$ErrorActionPreference='Stop'; $openrigKeyPath=$env:OPENRIG_API_KEY_FILE; ${OPEN_WINDOWS_PRIVATE_API_KEY}\n$openrigKeyStream.Dispose()`;
  try {
    execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, OPENRIG_API_KEY_FILE: file }, windowsHide: true, stdio: "pipe", timeout: 5000 });
    return null;
  } catch {
    return "the API-key file must be current-user-owned, private to that user, readable and at most 8192 bytes";
  }
}
