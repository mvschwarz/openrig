import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX;

describe.skipIf(!enabled)("native psmux PowerShell staging", () => {
  it("delivers a multiline block as one runner submission", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-input-"));
    const session = `openrig-input-${process.pid}-${Date.now()}`;
    const output = path.join(dir, "result.json"), ready = path.join(dir, "ready");
    const script = path.join(dir, "receiver.mjs");
    const runner = pathToFileURL(path.resolve(import.meta.dirname, "../dist/adapters/pi-runner.js")).href;
    writeFileSync(script, `import fs from 'node:fs'; import {createRunnerInput} from ${JSON.stringify(runner)};
      createRunnerInput(process.stdin, process.stdout, block => { fs.writeFileSync(${JSON.stringify(output + ".tmp")}, JSON.stringify(block)); fs.renameSync(${JSON.stringify(output + ".tmp")}, ${JSON.stringify(output)}); process.exit(0); });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
    const invoke = async (argv: string[]) => (await execFileAsync(process.env.OPENRIG_TEST_PSMUX!, argv.slice(1), { windowsHide: true })).stdout;
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, os.tmpdir())).toEqual({ ok: true });
      const q = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
      expect(await adapter.sendShellCommand(session, renderWindowsLaunch([process.execPath, script].map(q).join(" "), {}))).toEqual({ ok: true });
      const waitForFile = async (file: string) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) { try { return readFileSync(file, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
        const screen = await adapter.capturePaneScreen(session);
        throw new Error(`receiver did not produce ${path.basename(file)}; fixture screen: ${screen?.slice(-1200) ?? "unavailable"}`);
      };
      await waitForFile(ready);
      const pane = (await adapter.listPanes(session))[0]!;
      const message = "first line\nsecond line; 中文";
      expect(await adapter.sendText(pane.id, message)).toEqual({ ok: true });
      expect(await adapter.sendKeys(pane.id, ["Enter"])).toEqual({ ok: true });
      expect(JSON.parse(await waitForFile(output))).toBe(message);
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
  it("delivers exact native argv and environment through a real pane", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-"));
    const session = `openrig-test-${process.pid}-${Date.now()}`;
    const decoy = `${session}-other`;
    const output = path.join(dir, "result.json");
    const script = path.join(dir, "echo args.js");
    writeFileSync(script, `require('fs').writeFileSync(process.argv[2], JSON.stringify({args: process.argv.slice(3), marker: process.env.OPENRIG_TEST_MARKER}));`);
    const invoke = async (argv: string[]) => (await execFileAsync(process.env.OPENRIG_TEST_PSMUX!, argv.slice(1), { windowsHide: true })).stdout;
    const adapter = new TmuxAdapter(async () => { throw new Error("POSIX shell execution is forbidden in this probe"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, dir)).toEqual({ ok: true });
      expect(await adapter.createSession(decoy, dir)).toEqual({ ok: true });
      const q = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
      const args = ["space word", "a'b", "中文;$HOME", "", 'embedded"quote', "space trailing\\", "trailing\\"];
      const command = [process.execPath, script, output, ...args].map(q).join(" ");
      const panes = await adapter.listPanes(session);
      expect(panes).toHaveLength(1);
      expect(panes[0]!.id).toMatch(/^psmux:.*:%\d+$/);
      const other = (await adapter.listPanes(decoy))[0]!;
      expect(other.id).not.toBe(panes[0]!.id);
      expect(await adapter.sendShellCommand(panes[0]!.id, renderWindowsLaunch(command, { OPENRIG_TEST_MARKER: "native-ok" }))).toEqual({ ok: true });
      let result: unknown;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        try { result = JSON.parse(readFileSync(output, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      expect(result).toEqual({ args, marker: "native-ok" });
      expect(await adapter.killSession(session)).toEqual({ ok: true });
      expect((await adapter.probeSession(session)).state).toBe("absent");
      expect((await adapter.probeSession(decoy)).state).toBe("present");
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      await invoke(["tmux", "kill-session", "-t", `=${decoy}`]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
});
