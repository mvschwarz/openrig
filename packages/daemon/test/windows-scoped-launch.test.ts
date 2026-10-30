import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { windowsScopedLaunch } from "../src/adapters/windows-scoped-launch.js";
import { powershellQuote } from "../src/adapters/windows-launch.js";

describe.skipIf(process.platform !== "win32")("native scoped shell bootstrap", () => {
  it("clears unrelated inheritance, preserves pane identity and keeps values off bootstrap argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-scoped-"));
    try {
      const file = join(dir, "private launch.sh"), output = join(dir, "result.json");
      const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const value = "synthetic ' quote\nUnicode 中文";
      const command = `[IO.File]::WriteAllText(${powershellQuote(output)}, (ConvertTo-Json @{ selected=$env:SELECTED; unrelated=$env:UNRELATED; pane=$env:TMUX_PANE; cwd=(Get-Location).Path }))`;
      const launch = windowsScopedLaunch(`"${shell}" -NoProfile`, command, { SystemRoot: process.env.SystemRoot, SELECTED: "old", selected: value, TMUX_PANE: "stale" }, file);
      expect(launch.argv.join(" ")).not.toContain(value);
      writeFileSync(file, launch.content);
      execFileSync(launch.argv[0]!, launch.argv.slice(1), { cwd: dir, env: { SystemRoot: process.env.SystemRoot, UNRELATED: "server-only", TMUX_PANE: "%fresh" }, timeout: 15000, windowsHide: true });
      const result = JSON.parse(readFileSync(output, "utf8"));
      expect(result).toEqual({ selected: value, unrelated: null, pane: "%fresh", cwd: result.cwd });
      expect(realpathSync.native(result.cwd)).toBe(realpathSync.native(dir));
      expect(existsSync(file)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("retains the diagnostic fallback for unsupported shell semantics", () => {
    expect(() => windowsScopedLaunch("bash.exe", "", {}, "unused")).toThrow("Unsupported native scoped shell");
  });
});
