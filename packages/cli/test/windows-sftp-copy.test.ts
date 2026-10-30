import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import type { CopyPlan } from "../src/lib/file-transfer.js";

const server = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "sftp-server.exe");
describe.skipIf(process.platform !== "win32" || !existsSync(server))("native recursive SFTP copy", () => {
  it("retains the local original and reports staging when Windows refuses readonly replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-readonly-"));
    const source = path.join(root, "source.txt"), destination = path.join(root, "destination.txt");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    try {
      await writeFile(source, "owned new remote bytes\n");
      await writeFile(destination, "owned original\n");
      await chmod(destination, 0o444);
      const result = await runNativeSftpCopy({
        src: { kind: "remote", path: "/" + source.replaceAll("\\", "/"), host: { id: "fixture", target: "fixture", transport: "ssh" } },
        dst: { kind: "local", path: destination }, dryRun: false,
      }, start);
      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe("local-copy-failed");
      expect(await readFile(destination, "utf8")).toBe("owned original\n");
      expect(result.hint).toContain("existing destination was not removed");
      const staged = (await readdir(root)).filter(file => file.startsWith(".openrig-copy-"));
      expect(staged).toHaveLength(1);
      expect(await readFile(path.join(root, staged[0]!), "utf8")).toBe("owned new remote bytes\n");
    } finally {
      await chmod(destination, 0o666).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it("uploads, downloads, previews and preserves extra files through the real subsystem", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-copy-"));
    const source = path.join(root, "source"), remote = path.join(root, "remote"), download = path.join(root, "download");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    const plan: CopyPlan = { src: { kind: "local", path: source + path.sep }, dst: { kind: "remote", path: "/" + remote.replaceAll("\\", "/"), host: { id: "fixture", target: "fixture", transport: "ssh" } }, dryRun: true };
    try {
      await mkdir(source); await mkdir(remote); await mkdir(download);
      await mkdir(path.join(source, "nested"));
      await writeFile(path.join(source, "nested", "日本語.txt"), "actual native transfer\n");
      await writeFile(path.join(remote, "extra.txt"), "retain");
      const preview = await runNativeSftpCopy(plan, start);
      expect(preview.ok, preview.stderr).toBe(true);
      expect(preview.filesTransferred).toBe(1);
      expect(await readdir(remote)).toEqual(["extra.txt"]);
      plan.dryRun = false;
      const upload = await runNativeSftpCopy(plan, start);
      expect(upload.ok, upload.stderr).toBe(true);
      expect(await readFile(path.join(remote, "nested", "日本語.txt"), "utf8")).toBe("actual native transfer\n");
      expect((await runNativeSftpCopy(plan, start)).filesTransferred).toBe(0);
      // Same-size overwrite at a different timestamp must replace the entry.
      await writeFile(path.join(source, "nested", "日本語.txt"), "changed native transfer\n");
      const replacement = await runNativeSftpCopy(plan, start);
      expect(replacement.ok, replacement.stderr).toBe(true);
      const pull = await runNativeSftpCopy({ src: { ...plan.dst, path: plan.dst.path + "/" }, dst: { kind: "local", path: download }, dryRun: false }, start);
      expect(pull.ok, pull.stderr).toBe(true);
      expect(await readFile(path.join(download, "nested", "日本語.txt"), "utf8")).toBe("changed native transfer\n");
      expect(await readFile(path.join(download, "extra.txt"), "utf8")).toBe("retain");
      const missing = await runNativeSftpCopy({ ...plan, src: { kind: "local", path: path.join(root, "missing") } }, start);
      expect(missing.failedStep).toBe("remote-command-failed");
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
