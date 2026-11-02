import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { psmuxPrivateEnvironmentLine, writeWindowsPrivateConfig } from "../src/adapters/windows-private-config.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("delivers private initial configuration only to the selected first direct child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-direct-private-"));
  const registry = path.join(root, "registry"); await mkdir(registry);
  const key = "OPENRIG_SYNTHETIC_DIRECT_PRIVATE", value = 'SYNTHETIC direct " \\ $ #{session_name} %n\n日本語🙂\r\nlast';
  const config = await writeWindowsPrivateConfig(psmuxPrivateEnvironmentLine(key, value));
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL" };
  const execute = promisify(execFile), calls: string[][] = [];
  const invoke = async (argv: string[]) => { calls.push(argv); return (await execute(process.env.OPENRIG_TEST_PSMUX!, argv, { env, cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 })).stdout; };
  const receiver = path.join(root, "receiver.cjs");
  await writeFile(receiver, "require('fs').writeFileSync(process.argv[2],JSON.stringify({value:process.env[process.argv[3]]}));setInterval(()=>{},1000);");
  const names = ["owned-private-first", "owned-private-sibling"], outputs = names.map(name => path.join(root, name + ".json"));
  try {
    for (let i = 0; i < names.length; i++) {
      await invoke([...(i === 0 ? ["-f", config.path] : []), "new-session", "-d", "-s", names[i]!, "--", process.execPath, receiver, outputs[i]!, key]);
      await expect.poll(async () => { try { return JSON.parse(await readFile(outputs[i]!, "utf8")); } catch { return null; } }, { timeout: 5000 }).not.toBeNull();
    }
    expect(JSON.parse(await readFile(outputs[0]!, "utf8"))).toEqual({ value });
    const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell transport"); }, undefined, argv => invoke(argv.slice(1)), [], "psmux");
    expect(await adapter.getSessionEnv(names[0]!, key)).toBe(value);
    for (const updated of ["", "synthetic trailing CR\r", "synthetic trailing LF\n", "synthetic trailing CRLF\r\n", "synthetic first\n" + key + "=literal value line\n"]) {
      await adapter.setSessionEnv(names[0]!, key, updated);
      expect(await adapter.getSessionEnv(names[0]!, key)).toBe(updated);
    }
    expect(JSON.parse(await readFile(outputs[1]!, "utf8"))).toEqual({});
    expect(calls.flat().some(arg => arg.includes("SYNTHETIC direct"))).toBe(false);
  } finally {
    for (const name of names) await invoke(["kill-session", "-t", "=" + name]).catch(() => {});
    await config.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 40000);
