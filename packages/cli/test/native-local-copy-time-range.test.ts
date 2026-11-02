import { expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWindowsEntryTimes } from "@openrig/daemon/windows-owned-files";
import { runNativeLocalCopy } from "../src/lib/native-local-copy.js";

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
