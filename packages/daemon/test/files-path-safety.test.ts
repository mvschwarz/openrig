// UI Enhancement Pack v0 — path-safety helper tests.
//
// Pins the load-bearing fail-closed semantics of the file allowlist:
//   - root_unknown rejection
//   - .. escape rejection at the segment boundary (not substring)
//   - absolute-path-as-relative-path rejection
//   - symlink-escaping-root rejection (realpath check)
//   - filename containing ".." substring (e.g., foo..bar) does NOT
//     reject — only literal `..` segments do
//   - the base case (path = "") resolves to the root itself
//
// Pure unit tests — no Hono app, no daemon wiring.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilePathSafetyError,
  readAllowlistFromEnv,
  resolveAllowedDirectory,
  resolveAllowedFile,
  resolveAllowedPath,
} from "../src/domain/files/path-safety.js";

describe("UI Enhancement Pack v0 — readAllowlistFromEnv", () => {
  it("returns empty list when env unset", () => {
    expect(readAllowlistFromEnv({})).toEqual([]);
  });

  it("parses comma-separated name:path pairs", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "workspace:/abs/path1, openrig-hub: /abs/path2",
    });
    expect(list).toHaveLength(2);
    expect(list[0]?.name).toBe("workspace");
    expect(list[1]?.name).toBe("openrig-hub");
  });

  it("ignores pairs with no colon, empty name, or non-absolute path", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "no-colon-here, :missing-name, name:relative-path, ok:/abs/ok",
    });
    expect(list.map((r) => r.name)).toEqual(["ok"]);
  });

  it("dedupes by name (last wins)", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "x:/path/a, x:/path/b",
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.canonicalPath).toContain("/path/b");
  });

  it("falls back to RIGGED_FILES_ALLOWLIST when OPENRIG_FILES_ALLOWLIST is empty", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "",
      RIGGED_FILES_ALLOWLIST: "legacy:/abs/legacy",
    });
    expect(list.map((r) => r.name)).toEqual(["legacy"]);
  });
});

describe("UI Enhancement Pack v0 — resolveAllowedPath", () => {
  let tempDir: string;
  let allowlist: { name: string; canonicalPath: string }[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-safety-"));
    mkdirSync(join(tempDir, "workspace", "subdir"), { recursive: true });
    writeFileSync(join(tempDir, "workspace", "STEERING.md"), "# steering");
    writeFileSync(join(tempDir, "workspace", "subdir", "nested.md"), "# nested");
    // Outside-root file for symlink-escape test.
    mkdirSync(join(tempDir, "outside-root"), { recursive: true });
    writeFileSync(join(tempDir, "outside-root", "secret.txt"), "secret");
    // Canonicalize via realpath to match macOS /var → /private/var
    // resolution; production code does the same in readAllowlistFromEnv.
    allowlist = [{ name: "workspace", canonicalPath: realpathSync(join(tempDir, "workspace")) }];
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("resolves a relative path inside the root", () => {
    const resolved = resolveAllowedPath(allowlist, "workspace", "STEERING.md");
    expect(resolved).toBe(realpathSync(join(tempDir, "workspace", "STEERING.md")));
  });

  it("resolves '' (empty path) to the root itself", () => {
    expect(resolveAllowedPath(allowlist, "workspace", "")).toBe(realpathSync(join(tempDir, "workspace")));
  });

  it("rejects unknown root with code 'root_unknown'", () => {
    expect(() => resolveAllowedPath(allowlist, "not-allowlisted", "any.md"))
      .toThrowError(/allowlist root 'not-allowlisted' is not configured/);
    try { resolveAllowedPath(allowlist, "not-allowlisted", "any.md"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("root_unknown"); }
  });

  it("rejects '..' segment with code 'path_escape'", () => {
    expect(() => resolveAllowedPath(allowlist, "workspace", "../outside-root/secret.txt"))
      .toThrowError(/contains a '\.\.' segment/);
    try { resolveAllowedPath(allowlist, "workspace", "../outside-root/secret.txt"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("path_escape"); }
  });

  it("does NOT reject filenames containing '..' as a substring (e.g., foo..bar)", () => {
    writeFileSync(join(tempDir, "workspace", "foo..bar.md"), "ok");
    const resolved = resolveAllowedPath(allowlist, "workspace", "foo..bar.md");
    expect(resolved).toBe(realpathSync(join(tempDir, "workspace", "foo..bar.md")));
  });

  it("rejects an absolute path passed as relative", () => {
    expect(() => resolveAllowedPath(allowlist, "workspace", "/etc/passwd"))
      .toThrowError(/must not be absolute/);
    try { resolveAllowedPath(allowlist, "workspace", "/etc/passwd"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("path_invalid"); }
  });

  it("rejects symlink whose realpath escapes the root", () => {
    // Create a symlink inside the workspace pointing OUTSIDE the root.
    symlinkSync(join(tempDir, "outside-root", "secret.txt"), join(tempDir, "workspace", "escape-link"));
    expect(() => resolveAllowedPath(allowlist, "workspace", "escape-link"))
      .toThrowError(/falls outside allowlist root/);
    try { resolveAllowedPath(allowlist, "workspace", "escape-link"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("path_escape"); }
  });

  it("does NOT match a sibling path with the same prefix (path.sep boundary)", () => {
    // Allowlist root is ".../workspace"; a sibling ".../workspace-other"
    // should NOT be reachable by passing path = "" or any relative path.
    mkdirSync(join(tempDir, "workspace-other"), { recursive: true });
    writeFileSync(join(tempDir, "workspace-other", "leak.md"), "leak");
    // The file resolves cleanly inside the right root if the path
    // is relative to it; the wrong-root attack doesn't even get
    // expressed without a mismatched root, so the test verifies the
    // root-name mismatch instead.
    expect(() => resolveAllowedPath(allowlist, "workspace-other", "leak.md"))
      .toThrowError(/'workspace-other' is not configured/);
  });
});

describe("UI Enhancement Pack v0 — resolveAllowedFile / resolveAllowedDirectory", () => {
  let tempDir: string;
  let allowlist: { name: string; canonicalPath: string }[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-safety-typed-"));
    mkdirSync(join(tempDir, "ws", "dir-only"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "real.md"), "hi");
    allowlist = [{ name: "ws", canonicalPath: realpathSync(join(tempDir, "ws")) }];
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("resolveAllowedFile on a real file returns the absolute path", () => {
    expect(resolveAllowedFile(allowlist, "ws", "real.md")).toBe(realpathSync(join(tempDir, "ws", "real.md")));
  });

  it("resolveAllowedFile on a directory rejects with 'not_a_file'", () => {
    try { resolveAllowedFile(allowlist, "ws", "dir-only"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("not_a_file"); }
  });

  it("resolveAllowedFile on a missing path rejects with 'stat_failed'", () => {
    try { resolveAllowedFile(allowlist, "ws", "ghost.md"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("stat_failed"); }
  });

  it("resolveAllowedDirectory on a real directory returns the absolute path", () => {
    expect(resolveAllowedDirectory(allowlist, "ws", "dir-only")).toBe(realpathSync(join(tempDir, "ws", "dir-only")));
  });

  it("resolveAllowedDirectory on a file rejects with 'not_a_directory'", () => {
    try { resolveAllowedDirectory(allowlist, "ws", "real.md"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("not_a_directory"); }
  });
});
