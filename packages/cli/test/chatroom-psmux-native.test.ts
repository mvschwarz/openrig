import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { chatroomWatchTmuxArgs } from "../src/commands/chatroom.js";
import { tmuxServerArgs } from "../../daemon/src/adapters/tmux-server.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("routes a stock psmux chatroom watcher and whoami only inside an owned namespace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatroom-psmux-owned-"));
  const namespace = `owned-${randomUUID()}`, rig = `fixture-${randomUUID()}`, session = `chatroom@${rig}`;
  const bin = path.join(root, "bin"), data = path.join(root, "registry");
  fs.mkdirSync(bin); fs.mkdirSync(data);
  const mux = path.join(bin, "tmux.exe"); fs.copyFileSync(process.env.OPENRIG_TEST_PSMUX!, mux);
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const env: NodeJS.ProcessEnv = {
    SystemRoot: windows, WINDIR: windows, ComSpec: path.join(windows, "System32/cmd.exe"),
    PATH: [bin, path.dirname(process.execPath), path.join(windows, "System32"), path.join(windows, "System32/WindowsPowerShell/v1.0")].join(path.delimiter),
    PATHEXT: ".EXE;.CMD", HOME: root, USERPROFILE: root, HOMEDRIVE: path.parse(root).root.slice(0, 2), HOMEPATH: root.slice(2), TEMP: root, TMP: root,
    APPDATA: root, LOCALAPPDATA: root, OPENRIG_HOME: path.join(root, "instance"),
    PSMUX_DATA_DIR: data, PSMUX_CONFIG_FILE: "NUL",
  };
  const invoke = (args: string[]) => execFileSync(mux, ["-L", namespace, ...args], { env, cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000, stdio: "pipe" });
  const output = path.join(root, "received.json"), receiver = path.join(root, "owned receiver.cjs");
  fs.writeFileSync(receiver, `const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),env:Object.fromEntries(['TMUX','TMUX_PANE','PSMUX_SESSION','PSMUX_TARGET_SESSION','PSMUX_SOCKET_NAME'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]]]))}));setTimeout(()=>process.exit(0),20000);`);
  try {
    const created = invoke(chatroomWatchTmuxArgs(rig, [process.execPath, receiver, output])).trim();
    expect(created).toBe(session);
    const until = Date.now() + 5000;
    while (!fs.existsSync(output) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.existsSync(output), "owned watcher did not produce its receipt").toBe(true);
    const received = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(received.args).toEqual(["chatroom", "watch", "--", rig]);
    // A new terminal has no inherited pane routing. The daemon's advertised
    // socket flags must independently reach this same owned -L namespace.
    const server = tmuxServerArgs(received.env);
    expect(server[0]).toBe("-S");
    const routed = execFileSync(mux, [...server, "display-message", "-p", "-t", `=${session}`, "#{session_name}"],
      { env, cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000, stdio: "pipe" });
    expect(routed.trim()).toBe(session);
    invoke(["set-option", "-t", `=${session}`, "@rigged_node_id", "owned-node"]);
    const module = pathToFileURL(path.resolve(import.meta.dirname, "../src/commands/whoami.ts")).href;
    const identity = execFileSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, "--input-type=module", "-e",
      `const {resolveIdentitySource}=await import(${JSON.stringify(module)});console.log(JSON.stringify(resolveIdentitySource({})));`],
      { cwd: root, env: { ...env, ...received.env }, encoding: "utf8", windowsHide: true, timeout: 10000, stdio: "pipe" });
    expect(JSON.parse(identity)).toEqual({ nodeId: "owned-node" });
  } finally {
    try { invoke(["kill-session", "-t", `=${session}`]); } catch { /* Only this exact owned target is eligible. */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch { throw new Error(`Owned psmux fixture retained after cleanup refusal: ${root}`); }
  }
}, 40000);
