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
import { findWindowsRunProcesses } from "../src/domain/windows-process-facts.js";
import { randomUUID } from "node:crypto";

describe.skipIf(process.platform !== "win32")("native Windows restart process facts", () => {
  it("resolves an owned process's profile when its HOME is explicitly empty", async () => {
    const profile = path.join(os.tmpdir(), "synthetic-observed-profile");
    const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, HOME: "", USERPROFILE: profile },
    });
    try {
      await once(child.stdout!, "data");
      expect(await defaultResolveHomeDirByPid(child.pid!)).toBe(profile);
      expect((await defaultInPlaceRestartIo().readProcess(child.pid!))?.env.HOME).toBe(profile);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    }
  }, 20_000);
  it("matches run-marker keys with Windows casing while retaining exact marker values", async () => {
    const run = `Owned-Case-${randomUUID()}`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === "OPENRIG_ACP_RUN") delete env[key];
    const children = [run, run.toLowerCase()].map(value => spawn(process.execPath,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...env, openrig_acp_run: value } }));
    try {
      await Promise.all(children.map(child => once(child.stdout!, "data")));
      const found = await findWindowsRunProcesses(`OPENRIG_ACP_RUN=${run}`);
      expect(found).toContainEqual({ pid: children[0]!.pid });
      expect(found).not.toContainEqual({ pid: children[1]!.pid });
      const lower = await findWindowsRunProcesses(`OPENRIG_ACP_RUN=${run.toLowerCase()}`);
      expect(lower).toContainEqual({ pid: children[1]!.pid });
      expect(lower).not.toContainEqual({ pid: children[0]!.pid });
    } finally {
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "close"); child.kill(); await closed;
      }));
    }
  }, 20_000);
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
