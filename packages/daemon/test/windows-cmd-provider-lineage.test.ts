import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { defaultTmuxFileOps } from "../src/adapters/tmux.js";
import { powershellQuote, renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { windowsCmdBridgeInvocation } from "../src/domain/windows-cmd-bridge.js";
import { killWindowsChildTree } from "../src/domain/windows-child-tree.js";
import { listNativeProcesses, verifyCodexPaneProcess, verifyClaudePaneProcess } from "../src/domain/native-process-lineage.js";

it.runIf(process.platform === "win32")("joins owned native Codex/Claude witnesses through cmd staging without weakening conversation identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-provider-"));
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const witness = path.join(root, "witness.exe");
  const source = 'using System;using System.Threading;public class Witness{public static void Main(string[] args){Console.WriteLine("OWNED_PROVIDER_READY");Thread.Sleep(30000);}}';
  const compile = `Add-Type -TypeDefinition ${powershellQuote(source)} -OutputAssembly ${powershellQuote(witness)} -OutputType ConsoleApplication`;
  try {
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(compile, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000, stdio: "pipe" });
    for (const [runtime, extension] of [["codex", "exe"], ["claude", "exe"], ["codex", "com"], ["claude", "com"]] as const) {
      const executable = path.join(root, runtime + "." + extension); fs.copyFileSync(witness, executable);
      const ops = defaultTmuxFileOps(), script = ops.tmpName();
      const token = "owned-exact-conversation";
      const words = [executable, ...(runtime === "codex" ? ["resume", token] : ["--session-id", token])];
      await ops.writeFile(script, `Remove-Item -LiteralPath ${powershellQuote(script)}\n${renderWindowsLaunch(words.map(shellQuote).join(" "))}\n`);
      const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/q"], {
        cwd: root, env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(powershell), HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
      try {
        child.stdin.write(windowsCmdBridgeInvocation(script) + "\r\n");
        await expect.poll(() => output.includes("OWNED_PROVIDER_READY"), { timeout: 8000 }).toBe(true);
        let rows = await listNativeProcesses();
        await expect.poll(async () => { rows = await listNativeProcesses(); return rows.some(row => row.executablePath === executable); }, { timeout: 6000 }).toBe(true);
        const tmux = { getPanePid: async () => child.pid!, getPaneCommand: async () => runtime + "." + extension };
        const input = { target: "owned", tmux, listProcesses: async () => rows, expectedToken: token, requireResume: true, selectedExecutable: executable };
        const verify = runtime === "codex" ? verifyCodexPaneProcess : verifyClaudePaneProcess;
        const found = await verify(input);
        expect(found?.process.executablePath).toBe(executable);
        expect(await verify({ ...input, expectedToken: "different-conversation" })).toBeNull();
        expect(await verify({ ...input, selectedExecutable: witness })).toBeNull();
        expect(await verify({ ...input, listProcesses: async () => [...rows, { ...found!.process, pid: found!.process.pid + 1000000 }] })).toBeNull();
        expect(fs.existsSync(script)).toBe(false);
      } finally {
        await killWindowsChildTree(child); await closed;
        if (fs.existsSync(script)) fs.unlinkSync(script);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 40000);
