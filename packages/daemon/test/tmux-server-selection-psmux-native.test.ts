import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { inspectTmuxServer, selectTmuxServer } from "../src/domain/tmux-server-selection.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("mixed-case inherited environment routes new clients to the real stock server", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "openrig-inherited-case-")));
  const registry = path.join(root, "registry"); fs.mkdirSync(registry);
  const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    PATH: path.dirname(process.execPath), HOME: root, UserProfile: root, APPDATA: root, LOCALAPPDATA: root,
    TEMP: root, TMP: root, Psmux_Data_Dir: registry, PSMUX_CONFIG_FILE: "NUL" };
  const execute = promisify(execFile);
  const invoke = async (args: string[]) => (await execute(process.env.OPENRIG_TEST_PSMUX!, args,
    { cwd: root, env, windowsHide: true, timeout: 10000, encoding: "utf8" })).stdout;
  const selected = await selectTmuxServer({ home: path.join(root, "home"), mode: "inherit", registeredSessions: [], env, persist: false });
  const name = "owned-case", receiver = path.join(root, "receiver.cjs");
  fs.writeFileSync(receiver, "console.log('owned-case-receiver');setInterval(()=>{},1000);");
  try {
    expect(selected.serverArgs).toEqual(["-S", path.join(registry, "default")]);
    await invoke(["new-session", "-d", "-s", name, "--", process.execPath, receiver]);
    expect(await invoke([...selected.serverArgs, "list-sessions", "-F", "#{session_name}"])).toContain(name);
    await expect.poll(() => invoke([...selected.serverArgs, "capture-pane", "-p", "-t", `=${name}`]), { timeout: 5000 }).toContain("owned-case-receiver");
  } finally {
    await invoke([...selected.serverArgs, "kill-session", "-t", `=${name}`]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("isolates equal session names across selected homes and preserves the surviving sibling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-server-owned-"));
  const registry = path.join(root, "registry"); fs.mkdirSync(registry);
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root,
    APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
    PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL",
  };
  const run = promisify(execFile);
  const invoke = async (args: string[]) => (await run(process.env.OPENRIG_TEST_PSMUX!, args,
    { cwd: root, env, windowsHide: true, timeout: 10000, encoding: "utf8" })).stdout;
  const homes = [path.join(root, "home a"), path.join(root, "home b")];
  const selected = await Promise.all(homes.map(home => selectTmuxServer({ home, mode: "isolated", registeredSessions: [], env })));
  const adapters = selected.map(selection => new TmuxAdapter(async () => { throw new Error("No shell transport"); }, undefined,
    argv => invoke(argv.slice(1)), selection.executionArgs, "psmux"));
  const receiver = path.join(root, "receiver.cjs");
  fs.writeFileSync(receiver, "console.log(process.argv[2]);setInterval(()=>{},1000);");
  const name = "same@owned";
  try {
    for (let i = 0; i < selected.length; i++) {
      await invoke([...selected[i]!.executionArgs, "new-session", "-d", "-s", name, "--", process.execPath, receiver, `marker-${i}`]);
    }
    for (let i = 0; i < adapters.length; i++) {
      await expect.poll(() => adapters[i]!.capturePaneContent(name, 20), { timeout: 5000 }).toContain(`marker-${i}`);
      expect(await adapters[i]!.capturePaneContent(name, 20)).not.toContain(`marker-${1 - i}`);
      const routingShapedValue = `psmux:${Buffer.from("unrelated-server").toString("base64url")}:%7`;
      expect(await adapters[i]!.setSessionOption(name, "@owned-routing-data", routingShapedValue)).toEqual({ ok: true });
      expect(await adapters[i]!.getSessionOption(name, "@owned-routing-data")).toBe(routingShapedValue);
      expect(await invoke([...selected[i]!.serverArgs, "list-sessions", "-F", "#{session_name}"])).toContain(name);
      const restored = await selectTmuxServer({ home: homes[i]!, mode: "isolated", registeredSessions: [name], env });
      expect(restored.executionArgs).toEqual(selected[i]!.executionArgs);
    }
    // A new default client has no accidental access to either selected namespace.
    await expect(invoke(["list-sessions"])).rejects.toThrow();
    const pending = await selectTmuxServer({ home: homes[0]!, mode: "inherit", registeredSessions: [name], env,
      inspect: socket => inspectTmuxServer(socket, argv => invoke(argv.slice(1))) });
    expect(pending).toMatchObject({ mode: "isolated", migrationPending: true, blockingSessions: [name], executionArgs: selected[0]!.executionArgs });
    await invoke([...selected[0]!.executionArgs, "kill-session", "-t", `=${name}`]);
    expect(await adapters[1]!.capturePaneContent(name, 20)).toContain("marker-1");
  } finally {
    for (const selection of selected) await invoke([...selection.executionArgs, "kill-session", "-t", `=${name}`]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);
