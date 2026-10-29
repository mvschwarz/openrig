import { afterEach, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateTextFile } from "../src/lib/private-text-file.js";
import { writeTextAtomically } from "../src/atomic-text-write.js";
import { ConfigStore } from "../src/config-store.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { replaceArtifactFile } from "../src/commands/proof.js";
import { FileWriteService, sha256Hex } from "../../daemon/src/domain/files/file-write-service.js";
import { realpathSync } from "node:fs";
import { registerBundleProject } from "../../daemon/src/domain/workspace/project-registration.js";
import { mkdirSync, writeFileSync } from "node:fs";

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
it.runIf(process.platform === "win32")("replaces a readonly proof while retaining readonly aliases and their original bytes", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-proof-readonly-"));
  const file = join(root, "proof.md"), alias = join(root, "original.md");
  createPrivateTextFile(file, "original synthetic evidence");
  linkSync(file, alias);
  chmodSync(file, 0o444);
  const before = accessPolicy(file);
  replaceArtifactFile(file, "replacement synthetic evidence");
  expect(readFileSync(file, "utf8")).toBe("replacement synthetic evidence");
  expect(readFileSync(alias, "utf8")).toBe("original synthetic evidence");
  expect(statSync(file).mode & 0o222).toBe(0);
  expect(statSync(alias).mode & 0o222).toBe(0);
  expect(accessPolicy(file)).toBe(before);
  expect(accessPolicy(alias)).toBe(before);
  expect(readdirSync(root).sort()).toEqual(["original.md", "proof.md"]);
});
it.runIf(process.platform === "win32")("restores readonly when a native delete-sharing lock refuses proof replacement", async () => {
  root = mkdtempSync(join(tmpdir(), "openrig-proof-locked-"));
  const file = join(root, "proof.md");
  createPrivateTextFile(file, "original synthetic evidence");
  chmodSync(file, 0o444);
  const before = accessPolicy(file);
  const script = "$ErrorActionPreference='Stop'; $s=[IO.File]::Open($env:OPENRIG_TEST_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::WriteLine('ready'); $null=[Console]::ReadLine() } finally { $s.Dispose() }";
  const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_TEST_LOCK_FILE: file }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", data => { if (String(data).includes("ready")) resolve(); });
      child.once("error", reject);
      child.once("close", () => reject(new Error("fixture lock exited before ready")));
    });
    expect(() => replaceArtifactFile(file, "replacement synthetic evidence")).toThrow();
    expect(readFileSync(file, "utf8")).toBe("original synthetic evidence");
    expect(statSync(file).mode & 0o222).toBe(0);
    expect(accessPolicy(file)).toBe(before);
    expect(readdirSync(root)).toEqual(["proof.md"]);
  } finally {
    child.stdin.end("\n");
    await exit;
    clearTimeout(timeout);
  }
});
it.runIf(process.platform === "win32")("retains protected file access through the allowlisted file editor and writes its audit", () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "openrig-editor-acl-")));
  const file = join(root, "notes.md"), audit = join(root, "audit.jsonl");
  createPrivateTextFile(file, "original synthetic content");
  const before = accessPolicy(file);
  const service = new FileWriteService({ allowlist: [{ name: "workspace", canonicalPath: root }], auditFilePath: audit });
  const result = service.writeAtomic({ rootName: "workspace", path: "notes.md", content: "replacement synthetic content",
    expectedMtime: statSync(file).mtime.toISOString(), expectedContentHash: sha256Hex(readFileSync(file)), actor: "fixture@rig" });
  expect(result.newContentHash).toBe(sha256Hex("replacement synthetic content"));
  expect(readFileSync(file, "utf8")).toBe("replacement synthetic content");
  expect(accessPolicy(file)).toBe(before);
  expect(JSON.parse(readFileSync(audit, "utf8")).actor).toBe("fixture@rig");
  expect(readdirSync(root).sort()).toEqual(["audit.jsonl", "notes.md"]);
});
it.runIf(process.platform === "win32")("preserves protected workspace catalog access while registering and associating a bundle project", () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "openrig-catalog-acl-")));
  const bundle = join(root, "bundle"), workspace = join(root, "workspace"), catalog = join(workspace, "workspace.yaml");
  mkdirSync(bundle); mkdirSync(workspace);
  writeFileSync(join(bundle, "project.yaml"), "schema: openrig.project/v0alpha1\nid: bundled\n");
  const original = "schema: openrig.workspace/v0alpha1\n# retain this comment\nprojects:\n  - id: own\n    root: .\n";
  createPrivateTextFile(catalog, original);
  const before = accessPolicy(catalog);
  const input = { bundleProjectDir: bundle, workspaceRoot: workspace, catalogPath: catalog, projectsRoot: join(workspace, "projects"), projectId: "bundled", rigName: "first" };
  expect(registerBundleProject(input).status).toBe("registered");
  expect(accessPolicy(catalog)).toBe(before);
  expect(registerBundleProject({ ...input, rigName: "second" }).status).toBe("associated");
  expect(accessPolicy(catalog)).toBe(before);
  expect(readFileSync(catalog, "utf8")).toContain("# retain this comment");
  expect(readdirSync(workspace).sort()).toEqual(["projects", "workspace.yaml"]);
});
