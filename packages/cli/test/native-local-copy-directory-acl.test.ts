import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { windowsAuthFile } from "../../daemon/src/domain/windows-owned-text.js";
import { runNativeLocalCopy } from "../src/lib/native-local-copy.js";
import { createPrivateTextFile, createWindowsCopiedDirectory, finishWindowsCopiedDirectory } from "@openrig/daemon/windows-owned-files";

function powershell(script: string) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';${script}`, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

function setDirectoryRights(file: string, restricted: boolean) {
  const encoded = Buffer.from(file, "utf8").toString("base64");
  powershell(`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=[IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access);$a.SetAccessRuleProtection($true,$false);$a.PurgeAccessRules($sid);$rights=[Security.AccessControl.FileSystemRights]::${restricted ? "ReadAndExecute" : "FullControl"};$inherit=${restricted ? "[Security.AccessControl.InheritanceFlags]::None" : "([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)"};$r=New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r);[IO.Directory]::SetAccessControl($p,$a)`);
}

function acl(file: string) {
  const encoded = Buffer.from(file, "utf8").toString("base64");
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$a=Get-Acl -LiteralPath $p;@{Protected=$a.AreAccessRulesProtected;Rules=@($a.Access|ForEach-Object{@{Sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;Rights=[int]$_.FileSystemRights;Type=[int]$_.AccessControlType;Inheritance=[int]$_.InheritanceFlags;Propagation=[int]$_.PropagationFlags;Inherited=$_.IsInherited}})}|ConvertTo-Json -Depth 4 -Compress`;
  return JSON.parse(powershell(script));
}

describe.skipIf(process.platform !== "win32")("new local directory protected DACL", () => {
  const fixture = async (fn: (root: string) => Promise<void>) => {
    const root = await mkdtemp(path.join(tmpdir(), "openrig-copy-directory-acl-"));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
  };
  it.each([false, true])("retains a private directory and its inherited child access (replace file=%s)", replace => fixture(async root => {
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    windowsAuthFile("auth-directory", source);
    await writeFile(path.join(source, "child"), "owned dummy child");
    if (replace) await writeFile(destination, "old file");
    const before = acl(source), childBefore = acl(path.join(source, "child"));
    const result = await runNativeLocalCopy({ src: { kind: "local", path: source }, dst: { kind: "local", path: destination }, dryRun: false });
    expect(result.ok, result.stderr).toBe(true);
    expect(await readFile(path.join(destination, "child"), "utf8")).toBe("owned dummy child");
    expect(acl(destination)).toEqual(before);
    expect(acl(path.join(destination, "child"))).toEqual(childBefore);
  }));
  it("delays restrictive source permissions until children and timestamps are copied", () => fixture(async root => {
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    windowsAuthFile("auth-directory", source);createPrivateTextFile(path.join(source, "child"), "readable source child");
    setDirectoryRights(source, true);
    try {
      const expected = acl(source);
      const result = await runNativeLocalCopy({ src: { kind: "local", path: source }, dst: { kind: "local", path: destination }, dryRun: false });
      expect(result.ok, result.stderr).toBe(true);
      expect(await readFile(path.join(destination, "child"), "utf8")).toBe("readable source child");
      expect(acl(destination)).toEqual(expected);
    } finally { setDirectoryRights(source, false);setDirectoryRights(destination, false); }
  }));
  it("uses the captured DACL, and creates private staging before child data", () => fixture(async root => {
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    windowsAuthFile("auth-directory", source);const expected = acl(source);
    const security = createWindowsCopiedDirectory(source, destination);
    expect(security).toBeDefined();expect(acl(destination)).toEqual(expected);
    setDirectoryRights(source, true);
    try { finishWindowsCopiedDirectory(destination, security!);expect(acl(destination)).toEqual(expected); }
    finally { setDirectoryRights(source, false); }
  }));
  it("refuses finalization after the created directory inode was replaced", () => fixture(async root => {
    const source = path.join(root, "source"), destination = path.join(root, "destination"), retained = path.join(root, "retained");
    windowsAuthFile("auth-directory", source);
    const security = createWindowsCopiedDirectory(source, destination);
    await rename(destination, retained);await mkdir(destination);const before = acl(destination);
    expect(() => finishWindowsCopiedDirectory(destination, security!)).toThrow();
    expect(acl(destination)).toEqual(before);
  }));
});
