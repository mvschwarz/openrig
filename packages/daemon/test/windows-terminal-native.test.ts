import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { renderWindowsLaunch } from "../src/adapters/windows-launch.js";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX;

describe.skipIf(!enabled)("native psmux PowerShell staging", () => {
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
      const args = ["space word", "a'b", "中文;$HOME", "", "trailing\\"];
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
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      await invoke(["tmux", "kill-session", "-t", `=${decoy}`]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
