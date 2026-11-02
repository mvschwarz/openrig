import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { powershellQuote as q } from "../src/adapters/windows-launch.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("keeps stock initial and respawn values private while retaining inherited and session environments", async () => {
  const root = mkdtempSync(join(tmpdir(), "openrig-private-launch-")), registry = join(root, "registry"); mkdirSync(registry);
  const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { SHELL: shell, SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, HOME: root, USERPROFILE: root,
    APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, PATH: dirname(shell),
    PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL", INHERITED_OWNED: "server value" };
  const calls: string[][] = [], run = promisify(execFile);
  const invoke = async (argv: string[]) => { calls.push(argv); return (await run(process.env.OPENRIG_TEST_PSMUX!, argv.slice(1), { env, cwd: root, windowsHide: true, timeout: 10000 })).stdout; };
  const adapter = new TmuxAdapter(async () => { throw Error("No shell transport"); }, undefined, invoke, "psmux");
  const first = join(root, "first.json"), second = join(root, "second.json");
  const record = (file: string) => `[IO.File]::WriteAllText(${q(file)},(ConvertTo-Json @{ value=$env:SELECTED; inherited=$env:INHERITED_OWNED; lower=$env:lowerCase }))`;
  const values = ["synthetic private first ' 中文\nline", "synthetic private successor $ #{pid}\r\n"];
  try {
    expect(await adapter.startServer()).toEqual({ ok: true });
    await invoke(["tmux", "set-option", "-g", "remain-on-exit", "on"]);
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile -EncodedCommand ${Buffer.from(record(first), "utf16le").toString("base64")}`]);
    expect(await adapter.createSession("owned", root, { SELECTED: values[0]!, lowerCase: "mixed case" })).toEqual({ ok: true });
    await expect.poll(() => existsSync(first), { timeout: 5000 }).toBe(true);
    expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({ value: values[0], inherited: "server value", lower: "mixed case" });
    const pane = (await adapter.listPanes("owned"))[0]!;
    await expect.poll(() => adapter.isPaneDead(pane.id), { timeout: 5000 }).toBe(true);
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile`]);
    expect(await adapter.respawnPane(pane.id, record(second), { cwd: root, env: { SELECTED: values[1]! } })).toEqual({ ok: true });
    await expect.poll(() => existsSync(second), { timeout: 5000 }).toBe(true);
    expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({ value: values[1], inherited: "server value", lower: "mixed case" });
    await expect.poll(() => adapter.isPaneDead(pane.id), { timeout: 5000 }).toBe(true);
    unlinkSync(second);
    await adapter.setSessionEnv("owned", "SELECTED", "updated before external respawn");
    await invoke(["tmux", "respawn-pane", "-t", "=owned:0.0"]);
    await expect.poll(() => existsSync(second), { timeout: 5000 }).toBe(true);
    expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({ value: "updated before external respawn", inherited: "server value", lower: "mixed case" });
    await adapter.setSessionEnv("owned", "SELECTED", values[1]!);
    expect(await invoke(["tmux", "show-environment", "-t", "=owned", "SELECTED"])).toBe(`SELECTED=${values[1]}\n`);
    expect(calls.flat().some(arg => values.some(value => arg.includes(value)))).toBe(false);
    expect(calls.filter(argv => argv.includes("new-session") || argv.includes("respawn-pane")).every(argv => !argv.includes("-e"))).toBe(true);
  } finally {
    await invoke(["tmux", "kill-server"]).catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);
