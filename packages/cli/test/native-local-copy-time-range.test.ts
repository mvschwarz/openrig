import { expect, it } from "vitest";
import { lstat, lutimes, mkdir, mkdtemp, readFile, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWindowsEntryTimes } from "@openrig/daemon/windows-owned-files";
import { runNativeLocalCopy } from "../src/lib/native-local-copy.js";

it.skipIf(process.platform !== "win32").each([
  [-1, "file"], [-1, "dir"], [4294967296, "file"], [4294967296, "dir"],
] as const)("preserves out-of-range link time without touching the referent (%s, %s)", async (seconds, type) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-local-link-time-"));
  try {
    const target = path.join(root, "target"), source = path.join(root, "source"), destination = path.join(root, "destination");
    if (type === "dir") { await mkdir(target); await writeFile(path.join(target, "witness"), "retain"); }
    else await writeFile(target, "retain");
    await utimes(target, new Date(1500000000000), new Date(1500000000000));
    await symlink("target", source, type);
    await lutimes(source, new Date(seconds * 1000), new Date(seconds * 1000));
    const targetBefore = readWindowsEntryTimes(target, await lstat(target));
    const plan = { src: { kind: "local" as const, path: source }, dst: { kind: "local" as const, path: destination }, dryRun: false };
    const copied = await runNativeLocalCopy(plan); expect(copied.ok, copied.stderr).toBe(true);
    expect(await readlink(destination)).toBe("target");
    expect(readWindowsEntryTimes(destination, await lstat(destination)).mtime).toBe(seconds);
    await lutimes(destination, new Date(0), new Date(0));
    const preview = await runNativeLocalCopy({ ...plan, dryRun: true });
    expect(preview.ok, preview.stderr).toBe(true); expect(preview.stdout).toContain(".L..t.");
    expect(readWindowsEntryTimes(destination, await lstat(destination)).mtime).toBe(0);
    const repaired = await runNativeLocalCopy(plan); expect(repaired.ok, repaired.stderr).toBe(true);
    expect(repaired.filesTransferred).toBe(0);
    expect(readWindowsEntryTimes(destination, await lstat(destination)).mtime).toBe(seconds);
    expect(readWindowsEntryTimes(target, await lstat(target))).toEqual(targetBefore);
    expect(await readFile(type === "dir" ? path.join(target, "witness") : target, "utf8")).toBe("retain");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "win32").each([-1, 4294967296])("preserves native local file and directory times outside the uint32 range (%s)", async seconds => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-local-native-time-"));
  try {
    for (const directory of [false, true]) {
      const source = path.join(root, directory ? "source-dir" : "source-file");
      const destination = path.join(root, directory ? "destination-dir" : "destination-file");
      if (directory) { await mkdir(source); await writeFile(path.join(source, "child"), "new"); }
      else { await writeFile(source, "new"); await writeFile(destination, "old"); await utimes(destination, new Date(0), new Date(0)); }
      await utimes(source, new Date(seconds * 1000), new Date(seconds * 1000));
      const plan = { src: { kind: "local" as const, path: source }, dst: { kind: "local" as const, path: destination }, dryRun: false };
      const result = await runNativeLocalCopy(plan); expect(result.ok, result.stderr).toBe(true);
      expect(readWindowsEntryTimes(destination, await lstat(destination)).mtime).toBe(seconds);
      expect(await readFile(directory ? path.join(destination, "child") : destination, "utf8")).toBe("new");
      const preview = await runNativeLocalCopy({ ...plan, src: { ...plan.src, path: directory ? source + path.sep : source }, dryRun: true });
      expect(preview.ok, preview.stderr).toBe(true); expect(preview.filesTransferred).toBe(0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
