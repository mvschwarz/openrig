import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("removes a selected server's parent identity before its next direct child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-parent-isolation-"));
  const registry = path.join(root, "registry"); await mkdir(registry);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL" };
  const execute = promisify(execFile), calls: string[][] = [];
  const invoke = async (argv: string[]) => { calls.push(argv); return (await execute(process.env.OPENRIG_TEST_PSMUX!, argv, { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10000 })).stdout; };
  const receiver = path.join(root, "receiver.cjs"), output = path.join(root, "after.json");
  await writeFile(receiver, "require('fs').writeFileSync(process.argv[2],JSON.stringify({value:process.env.CLAUDECODE}));setInterval(()=>{},1000);");
  const names = ["owned-parent-first", "owned-parent-selected"];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell transport"); }, undefined, argv => invoke(argv.slice(1)), [], "psmux");
  try {
    for (const name of names) await invoke(["new-session", "-d", "-s", name, "--", process.execPath, "-e", "setInterval(()=>{},1000)"]);
    await invoke(["set-environment", "-g", "-t", "=" + names[1], "CLAUDECODE", "synthetic-selected-global"]);
    expect(await invoke(["show-environment", "-g", "-t", "=" + names[1], "CLAUDECODE"])).toBe("CLAUDECODE=synthetic-selected-global\n");
    await adapter.setSessionEnv(names[0]!, "CLAUDECODE", "synthetic-sibling-override");
    await adapter.setSessionEnv(names[1]!, "CLAUDECODE", "synthetic-session-override");
    await adapter.unsetSessionEnv(names[1]!, "claudecode");
    await invoke(["respawn-pane", "-k", "-t", "=" + names[1] + ":", "--", process.execPath, receiver, output]);
    await expect.poll(async () => { try { return JSON.parse(await readFile(output, "utf8")); } catch { return null; } }, { timeout: 5000 }).toEqual({});
    expect(calls.some(argv => argv.includes("set-environment") && argv.includes("-r") && argv.some(value => value.toUpperCase() === "CLAUDECODE"))).toBe(true);
    expect(await adapter.getSessionEnv(names[0]!, "CLAUDECODE")).toBe("synthetic-sibling-override");
    expect(await invoke(["show-environment", "-g", "-t", "=" + names[1], "CLAUDECODE"])).toBe("CLAUDECODE=synthetic-selected-global\n");
    expect(await adapter.probeSession(names[0]!)).toMatchObject({ state: "present" });
  } finally {
    for (const name of names) await invoke(["kill-session", "-t", "=" + name]).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 40000);
