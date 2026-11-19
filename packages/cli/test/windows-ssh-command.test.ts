import { afterEach, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCrossHostCommand } from "../src/cross-host-executor.js";
import { windowsSshCommand } from "../src/windows-ssh-command.js";
import { addHostEntry, updateHostEntry, loadHostRegistry, validateHostRegistry } from "../src/host-registry.js";
import { validateHostRegistry as daemonValidate } from "../../daemon/src/domain/hosts/hosts-registry-reader.js";
import { addHostEntry as daemonAdd, updateHostEntry as daemonUpdate } from "../../daemon/src/domain/hosts/hosts-registry-writer.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const host = { id: "owned", transport: "ssh" as const, target: "owned", remoteShell: "powershell" as const, rigPath: "C:/owned/rig.cjs" };
it("validates and persists native execution fields identically in both registry readers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-ssh-registry-")); roots.push(root);
  const file = path.join(root, "hosts.yaml");
  const twin = path.join(root, "daemon-hosts.yaml");
  expect(addHostEntry(host, file).ok).toBe(true);
  expect(daemonAdd(host, twin).ok).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(fs.readFileSync(twin, "utf8"));
  expect(loadHostRegistry(file)).toMatchObject({ ok: true, registry: { hosts: [host] } });
  for (const entry of [host, { ...host, remoteShell: "cmd" }, { ...host, rigPath: "relative.js" }, { ...host, rigPath: undefined }]) {
    expect(validateHostRegistry({ hosts: [entry] }, file)).toEqual(daemonValidate({ hosts: [entry] }, file));
  }
  expect(updateHostEntry("owned", { rigPath: "" }, file).ok).toBe(false);
  expect(updateHostEntry("owned", { remoteShell: "", rigPath: "" }, file).ok).toBe(true);
  expect(daemonUpdate("owned", { remoteShell: "", rigPath: "" }, twin).ok).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(fs.readFileSync(twin, "utf8"));
  expect(loadHostRegistry(file)).toMatchObject({ ok: true, registry: { hosts: [{ id: "owned", transport: "ssh", target: "owned" }] } });
});
it("builds only a fixed encoded PowerShell entry, never a POSIX command or raw argument expansion", () => {
  const value = "literal ' 中文;$(whoami)\n";
  const command = windowsSshCommand(host, ["rig", "send", value]);
  expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
  expect(command).not.toContain(value);
  expect(command).not.toContain("sh -lc");
  expect(() => windowsSshCommand({ ...host, rigPath: "relative.js" }, ["rig"])).toThrow();
  expect(() => windowsSshCommand(host, ["rig", "bad\0value"])).toThrow();
});
it.runIf(process.platform === "win32")("returns command-not-found exit 127 before launching an unavailable native executable", () => {
  const command = windowsSshCommand(host, ["openrig-owned-missing-executable-20261102.exe"]);
  const result = spawnSync(path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command.split(" ").at(-1)!], {
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath) }, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
  expect(result.status, result.stderr).toBe(127);
  expect(result.stderr).toContain("remote command not found");
});
it.runIf(process.platform === "win32").each([0, 7])("runs native remote argv, stdin and origin through the production SSH selection (exit %s)", async code => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native SSH ' 中文-")); roots.push(root);
  const entry = path.join(root, "rig.cjs");
  fs.writeFileSync(entry, "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),origin:process.env.OPENRIG_SESSION_NAME,stdin:text}));process.exitCode=Number(process.argv[2]);});");
  const values = [String(code), "", "space word", "中文😀", "a'b", 'a"b', "trailing\\", "$() &; %PATH%\nnext"];
  const origin = "worker@owned@host-id", input = "synthetic stdin 中文\nnext\n";
  let invocation: readonly string[] = [];
  const result = await runCrossHostCommand({ ...host, rigPath: entry }, ["rig", ...values], { originTriple: origin, stdin: input,
    spawn: (command, args) => {
      expect(command).toBe("ssh"); invocation = args;
      const encoded = args.at(-1)!.split(" ").at(-1)!;
      return spawn(path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
          env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), TEMP: root, TMP: root }, stdio: "pipe", windowsHide: true,
        });
    } });
  expect(invocation).toContain("ConnectTimeout=10");
  expect(result.ok).toBe(code === 0);
  expect(result.failedStep).toBe(code === 0 ? "none" : "remote-command-failed");
  if (!("stdout" in result)) throw new Error(JSON.stringify(result));
  expect(JSON.parse(result.stdout)).toEqual({ args: values, origin, stdin: input });
  expect(result.remoteExitCode).toBe(code);
}, 15000);
