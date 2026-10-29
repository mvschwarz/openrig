import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateTextFile } from "../src/lib/private-text-file.js";
import { writeTextAtomically } from "../src/atomic-text-write.js";
import { ConfigStore } from "../src/config-store.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { replaceArtifactFile } from "../src/commands/proof.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function accessPolicy(file: string): string {
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $acl=Get-Acl -LiteralPath $env:OPENRIG_TEST_ACL_FILE; @{protected=$acl.AreAccessRulesProtected; rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{identity=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; inherited=$_.IsInherited; type=[int]$_.AccessControlType} })} | ConvertTo-Json -Compress -Depth 4";
  return execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_TEST_ACL_FILE: file }, encoding: "utf8", windowsHide: true }).trim();
}
it.runIf(process.platform === "win32")("preserves an existing protected DACL across atomic text replacement", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-atomic-acl-"));
  const file = join(root, "config.json");
  createPrivateTextFile(file, "original");
  const before = accessPolicy(file);
  writeTextAtomically(file, "replacement");
  expect(readFileSync(file, "utf8")).toBe("replacement");
  expect(accessPolicy(file)).toBe(before);
  expect(readdirSync(root)).toEqual(["config.json"]);
});
it.runIf(process.platform === "win32").each([ConfigStore, SettingsStore])("preserves protected settings access through %s set and reset", (Store) => {
  root = mkdtempSync(join(tmpdir(), "openrig-settings-acl-"));
  const file = join(root, "config.json");
  createPrivateTextFile(file, "{}");
  const before = accessPolicy(file);
  const store = new Store(file);
  store.set("transcripts.lines", "20");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ transcripts: { lines: 20 } });
  expect(accessPolicy(file)).toBe(before);
  store.reset("transcripts.lines");
  expect(accessPolicy(file)).toBe(before);
  expect(readdirSync(root)).toEqual(["config.json"]);
});
it.runIf(process.platform === "win32")("preserves protected artifact access during explicit proof replacement", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-proof-acl-"));
  const file = join(root, "proof.md");
  createPrivateTextFile(file, "original synthetic evidence");
  const before = accessPolicy(file);
  replaceArtifactFile(file, "replacement synthetic evidence");
  expect(readFileSync(file, "utf8")).toBe("replacement synthetic evidence");
  expect(accessPolicy(file)).toBe(before);
  expect(readdirSync(root)).toEqual(["proof.md"]);
});
