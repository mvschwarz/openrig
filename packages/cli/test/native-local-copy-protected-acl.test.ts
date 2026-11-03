import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyWindowsFileNew, createPrivateTextFile } from "@openrig/daemon/windows-owned-files";
import { windowsAuthFile } from "../../daemon/src/domain/windows-owned-text.js";
import { runNativeLocalCopy } from "../src/lib/native-local-copy.js";

describe.skipIf(process.platform !== "win32")("local copy protected Windows DACL", () => {
  const fixture = async (fn: (root: string) => Promise<void>) => {
    const root = await mkdtemp(path.join(tmpdir(), "openrig-copy-protected-acl-"));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
  };
  it.each([
    { content: "", stream: false }, { content: "", stream: true },
    { content: "owned private dummy bytes", stream: false }, { content: "owned private dummy bytes", stream: true },
  ])("keeps a new copy private (%j)", ({ content, stream }) => fixture(async root => {
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    createPrivateTextFile(source, content);
    if (stream) await writeFile(`${source}:owned-stream`, "owned alternate stream");
    const result = await runNativeLocalCopy({ src: { kind: "local", path: source }, dst: { kind: "local", path: destination }, dryRun: false });
    expect(result.ok, result.stderr).toBe(true);
    expect(await readFile(destination, "utf8")).toBe(content);
    if (stream) expect(await readFile(`${destination}:owned-stream`, "utf8")).toBe("owned alternate stream");
    // Native verification requires a protected single current-SID full-control
    // ACE; the OS may add an auto-inheritance control bit without widening it.
    expect(windowsAuthFile("auth-mode", destination)).toBe("600");
  }));
  it("does not overwrite a newly occupied destination", () => fixture(async root => {
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    createPrivateTextFile(source, "owned new bytes");await writeFile(destination, "retain occupant");
    expect(() => copyWindowsFileNew(source, destination)).toThrow();
    expect(await readFile(destination, "utf8")).toBe("retain occupant");
  }));
  it("retains the existing destination DACL when replacing content", () => fixture(async root => {
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    await writeFile(source, "ordinary source replacement bytes");createPrivateTextFile(destination, "old");
    const result = await runNativeLocalCopy({ src: { kind: "local", path: source }, dst: { kind: "local", path: destination }, dryRun: false });
    expect(result.ok, result.stderr).toBe(true);
    expect(await readFile(destination, "utf8")).toBe("ordinary source replacement bytes");
    expect(windowsAuthFile("auth-mode", destination)).toBe("600");
  }));
  it("rejects a final source link without publishing its referent", () => fixture(async root => {
    const source = path.join(root, "source"), target = path.join(root, "target"), destination = path.join(root, "destination");
    createPrivateTextFile(target, "retain referent");await symlink(target, source, "file");
    expect(() => copyWindowsFileNew(source, destination)).toThrow();
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target, "utf8")).toBe("retain referent");
  }));
});
