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
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { authList, authSave, authSwitch, resolveCodexHome } from "../../daemon/src/domain/codex-auth.js";
import { DEFAULT_HEALTH_POLICY, HealthPolicyStore } from "../../daemon/src/domain/health-policy.js";
import { ActiveLensStore } from "../../daemon/src/domain/active-lens-store.js";
import { TerminalViewsStore } from "../../daemon/src/domain/terminal/terminal-views-store.js";
import { listRecapChain, writeSeatRecap } from "../../daemon/src/domain/context-packs/seat-recap-store.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function accessPolicy(file: string): string {
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $acl=Get-Acl -LiteralPath $env:OPENRIG_TEST_ACL_FILE; @{protected=$acl.AreAccessRulesProtected; rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{identity=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; inherited=$_.IsInherited; type=[int]$_.AccessControlType} })} | ConvertTo-Json -Compress -Depth 4";
  return execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, OPENRIG_TEST_ACL_FILE: file }, encoding: "utf8", windowsHide: true }).trim();
}
it.runIf(process.platform === "win32")("retains recap access and predecessor bytes while superseding an authored recap", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-recap-acl-"));
  const file = join(root, "RECAP.md");
  const original = "# Decisions\nOwned predecessor rationale\n";
  createPrivateTextFile(file, original);
  const before = accessPolicy(file);
  writeSeatRecap({ seatDir: root, content: "# Decisions\nOwned successor rationale\n", now: () => 1 });
  const chain = listRecapChain(root);
  expect(chain).toHaveLength(1);
  expect(readFileSync(chain[0]!.path, "utf8")).toBe(original);
  expect(accessPolicy(chain[0]!.path)).toBe(before);
  expect(accessPolicy(file)).toBe(before);
  expect(readFileSync(file, "utf8")).toContain("Owned successor rationale");
  expect(readdirSync(root).sort()).toEqual(["RECAP.md", "recap-superseded"]);
  expect(readdirSync(join(root, "recap-superseded"))).toHaveLength(1);
});
it.runIf(process.platform === "win32")("rolls back the new recap archive when Windows refuses readonly-current replacement", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-recap-refusal-"));
  const file = join(root, "RECAP.md");
  const original = "# Decisions\nOwned retained rationale\n";
  createPrivateTextFile(file, original);
  chmodSync(file, 0o444);
  const before = accessPolicy(file);
  expect(() => writeSeatRecap({ seatDir: root!, content: "# Decisions\nOwned attempted rationale\n", now: () => 1 })).toThrow();
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(accessPolicy(file)).toBe(before);
  expect(statSync(file).mode & 0o222).toBe(0);
  expect(listRecapChain(root)).toEqual([]);
  expect(readdirSync(root).sort()).toEqual(["RECAP.md", "recap-superseded"]);
  expect(readdirSync(join(root, "recap-superseded"))).toEqual([]);
});
it.runIf(process.platform === "win32").each(["lens", "views"])("retains existing protected %s access across repeated operator updates", kind => {
  root = mkdtempSync(join(tmpdir(), "openrig-operator-acl-"));
  const file = join(root, kind === "lens" ? "lens.json" : "views.yaml");
  createPrivateTextFile(file, kind === "lens" ? "{}" : "version: 1\nviews: []\n");
  const before = accessPolicy(file);
  if (kind === "lens") {
    const store = new ActiveLensStore({ filePath: file });
    store.set("first", "1");
    expect(accessPolicy(file)).toBe(before);
    store.set("second", "2");
    expect(store.get()).toMatchObject({ specName: "second", specVersion: "2" });
  } else {
    const store = new TerminalViewsStore(file);
    store.save({ id: "owned", name: "Owned", members: [{ seat: "owned@fixture" }] });
    expect(accessPolicy(file)).toBe(before);
    expect(store.get("owned")?.members).toEqual([{ seat: "owned@fixture" }]);
    expect(store.remove("owned").views).toEqual([]);
  }
  expect(accessPolicy(file)).toBe(before);
  expect(readdirSync(root)).toEqual([kind === "lens" ? "lens.json" : "views.yaml"]);
});
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
it.runIf(process.platform === "win32")("saves and switches synthetic auth with equivalent native-cased profile paths", () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "openrig-auth-casing-")));
  const account = join(root, "account"); mkdirSync(account);
  const paths = resolveCodexHome({ CODEX_HOME: account });
  paths.profileDir = paths.profileDir.toUpperCase();
  createPrivateTextFile(paths.activeAuth, JSON.stringify({ OPENAI_API_KEY: "synthetic-private-value" }));
  expect(authSave(paths, "fixture")).toMatchObject({ ok: true, name: "fixture", mode: "600" });
  const before = accessPolicy(paths.activeAuth);
  expect(authSwitch(paths, "fixture")).toMatchObject({ ok: true, name: "fixture", mode: "600" });
  expect(accessPolicy(paths.activeAuth)).toBe(before);
  expect(authList(paths)).toEqual(["fixture"]);
  const outside = join(root, "account-other"); mkdirSync(outside);
  createPrivateTextFile(join(outside, "outside.json"), "{}");
  expect(authList({ ...paths, profileDir: outside })).toEqual([]);
  const linked = join(account, "linked-profiles"); symlinkSync(outside, linked, "junction");
  expect(authList({ ...paths, profileDir: linked })).toEqual([]);
});
it.runIf(process.platform === "win32")("retains a protected health policy access policy when applying an authored change", () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "health-policy-acl-")));
  const store = new HealthPolicyStore(root, () => ({ warningPercent: 80, criticalPercent: 95 }));
  mkdirSync(join(root, "health"));
  createPrivateTextFile(store.path, JSON.stringify(DEFAULT_HEALTH_POLICY));
  const before = accessPolicy(store.path);
  const policy = structuredClone(DEFAULT_HEALTH_POLICY); policy.thresholds.ceremonyTransitions++;
  expect(store.apply(policy, "fixture@rig").policy).toEqual(policy);
  expect(accessPolicy(store.path)).toBe(before);
  expect(store.apply(policy, "fixture@rig").policy).toEqual(policy);
  expect(readdirSync(join(root, "health")).sort()).toEqual(["policy-history", "policy.json"]);
  expect(readdirSync(join(root, "health", "policy-history"))).toHaveLength(1);
});
