import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWindowsProcessFacts, readWindowsProcessFactsBatch } from "../src/domain/windows-process-facts.js";
import { readNativeExecutablePaths } from "../src/domain/native-process-executable.js";
import { readNativeProcessArguments } from "../src/domain/native-process-arguments.js";
import { defaultInPlaceRestartIo } from "../src/domain/seat-restart-in-place.js";
import { defaultResolveHomeDirByPid } from "../src/domain/codex-thread-id.js";

describe.skipIf(process.platform !== "win32")("native Windows restart process facts", () => {
  it("reads target cwd, exact argv and whitelisted homes without leaking unrelated environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-process-facts-"));
    const cwd = path.join(root, "中文 cwd"), home = path.join(root, "own home"), codexHome = path.join(root, "own codex");
    await mkdir(cwd);
    const source = "console.log('ready');setInterval(()=>{},1000)";
    const args = ["-e", source, "--", "", "space value", 'quote"value', "trailing\\"];
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome, OPENRIG_PRIVATE_SENTINEL: "must-not-leave-helper" } });
    try {
      await once(child.stdout!, "data");
      const facts = await readWindowsProcessFacts(child.pid!);
      expect(facts).toMatchObject({ cwd, exe: process.execPath, argv: [process.execPath, ...args], env: { HOME: home, CODEX_HOME: codexHome } });
      expect(Object.keys(facts!.env).every(name => ["HOME", "USERPROFILE", "CODEX_HOME"].includes(name))).toBe(true);
      expect(JSON.stringify(facts)).not.toContain("must-not-leave-helper");
      const batch = await readWindowsProcessFactsBatch([child.pid!, process.pid, child.pid!, 0, NaN]);
      expect(batch.size).toBe(2);
      expect(batch.get(child.pid!)).toEqual(facts);
      expect(JSON.stringify([...batch])).not.toContain("must-not-leave-helper");
      expect((await readNativeExecutablePaths([child.pid!, 0])).get(child.pid!)).toBe(process.execPath);
      expect((await readNativeProcessArguments([child.pid!, NaN])).get(child.pid!)).toEqual([process.execPath, ...args]);
      expect(await defaultInPlaceRestartIo().readProcess(child.pid!)).toEqual({ cwd, exe: process.execPath, argv: [process.execPath, ...args], env: { HOME: home, CODEX_HOME: codexHome } });
      expect(await defaultResolveHomeDirByPid(child.pid!)).toBe(home);
      const exited = once(child, "exit"); child.kill(); await exited;
      expect(await readWindowsProcessFacts(child.pid!)).toBeNull();
      expect((await readNativeExecutablePaths([child.pid!])).size).toBe(0);
      expect((await readNativeProcessArguments([child.pid!])).size).toBe(0);
      expect(await defaultInPlaceRestartIo().readProcess(child.pid!)).toBeNull();
    } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
  }, 40_000);

  it("does not query invalid PIDs", async () => {
    for (const pid of [0, -1, NaN, 1.5, 2147483648]) expect(await readWindowsProcessFacts(pid)).toBeNull();
    expect((await readWindowsProcessFactsBatch([0, -1, NaN, 1.5, 2147483648])).size).toBe(0);
  });
});
