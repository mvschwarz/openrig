import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FileWriteService, sha256Hex } from "../src/domain/files/file-write-service.js";

let root: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32")("writes default file-edit audit under USERPROFILE when HOME is empty", () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "file-editor-home-")));
  const profile = join(root, "profile"), workspace = join(root, "workspace");
  mkdirSync(profile); mkdirSync(workspace);
  vi.stubEnv("HOME", ""); vi.stubEnv("USERPROFILE", profile);
  const file = join(workspace, "notes.md"); writeFileSync(file, "before");
  const service = new FileWriteService({ allowlist: [{ name: "workspace", canonicalPath: workspace }] });
  expect(service.getAuditFilePath()).toBe(join(profile, ".openrig", "file-edit-audit.jsonl"));
  service.writeAtomic({ rootName: "workspace", path: "notes.md", content: "after", actor: "fixture@rig",
    expectedMtime: statSync(file).mtime.toISOString(), expectedContentHash: sha256Hex("before") });
  expect(JSON.parse(readFileSync(service.getAuditFilePath(), "utf8")).actor).toBe("fixture@rig");
  expect(new FileWriteService({ allowlist: [], auditFilePath: join(root, "explicit.jsonl") }).getAuditFilePath()).toBe(join(root, "explicit.jsonl"));
});
it.runIf(process.platform === "win32")("resolves an absolute OS-home audit path with no home environment selectors", () => {
  vi.stubEnv("HOME", undefined); vi.stubEnv("USERPROFILE", undefined);
  expect(new FileWriteService({ allowlist: [] }).getAuditFilePath()).toBe(join(homedir(), ".openrig", "file-edit-audit.jsonl"));
});
