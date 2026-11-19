import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatroomWatcherCommand, chatroomWatchTmuxArgs } from "../src/commands/chatroom.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it("selects the paired Node CLI on Windows and keeps the POSIX watcher", () => {
  expect(chatroomWatcherCommand("linux")).toEqual(["rig"]);
  expect(chatroomWatcherCommand("win32")).toEqual([process.execPath, fileURLToPath(new URL("../src/index.js", import.meta.url))]);
  const argv = chatroomWatchTmuxArgs("owned", chatroomWatcherCommand("win32"), "win32");
  expect(argv.slice(argv.indexOf("-s") + 2)).toEqual(["--", ...chatroomWatcherCommand("win32"), "chatroom", "watch", "--", "owned"]);
});

it.runIf(process.platform === "win32")("reproduces the cmd-only watcher failure and preserves native watcher argv through an owned child", () => {
  root = mkdtempSync(path.join(tmpdir(), "openrig-chatroom 用户 O'Brien-"));
  const entry = path.join(root, "owned watcher.cjs");
  const marker = path.join(root, "must-not-exist");
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  writeFileSync(path.join(root, "rig.cmd"), `@echo off\r\necho wrong>${marker}\r\n`);
  const env = { SystemRoot: process.env.SystemRoot, PATH: root, PATHEXT: ".CMD", TEMP: tmpdir(), TMP: tmpdir() };
  const before = spawnSync("rig", ["chatroom", "watch", "--", "owned"], { env, encoding: "utf8" });
  expect(before.error).toBeDefined(); expect(existsSync(marker)).toBe(false);
  for (const rig of ["owned 用户 O'Brien & %PATH%", "-owned", "$(echo owned)"]) {
    // Substitute only this CLI's entry with a recorder. No real daemon, psmux
    // session or SSE watch is opened; the actual native child receives argv.
    const argv = chatroomWatchTmuxArgs(rig, [chatroomWatcherCommand("win32")[0]!, entry]);
    const program = argv.indexOf("-s") + 3;
    const result = spawnSync(argv[program]!, argv.slice(program + 1), { env, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["chatroom", "watch", "--", rig]);
  }
  expect(existsSync(marker)).toBe(false);
});
