import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { windowsScopedLaunch } from "../src/adapters/windows-scoped-launch.js";
import { powershellQuote } from "../src/adapters/windows-launch.js";

const nativeShells = [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ...(process.env.OPENRIG_TEST_PWSH ? [process.env.OPENRIG_TEST_PWSH] : [])];

describe.skipIf(process.platform !== "win32")("native scoped shell bootstrap", () => {
  it.each(nativeShells)("clears unrelated inheritance, preserves pane identity and keeps values off bootstrap argv: %s", shell => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-scoped-"));
    try {
      const file = join(dir, "private launch.sh"), output = join(dir, "result.json");
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
  it("preserves configured cmd startup arguments and explicit command semantics", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-scoped-cmd-"));
    try {
      const file = join(dir, "launch.sh"), output = join(dir, "cmd result.txt");
      const shell = join(process.env.SystemRoot!, "System32", "cmd.exe");
      const launch = windowsScopedLaunch(`"${shell}" /d`, `set SELECTED > "${output}"`, { SystemRoot: process.env.SystemRoot, SELECTED: "synthetic-cmd" }, file);
      writeFileSync(file, launch.content);
      execFileSync(launch.argv[0]!, launch.argv.slice(1), { cwd: dir, env: { SystemRoot: process.env.SystemRoot }, timeout: 15000, windowsHide: true, stdio: "pipe" });
      expect(readFileSync(output, "utf8").trim()).toBe("SELECTED=synthetic-cmd");
      expect(existsSync(file)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it.skipIf(process.platform !== "win32" || !process.env.OPENRIG_TEST_PSMUX).each(nativeShells)("runs scoped initial shells on an owned stock psmux server: %s", async shell => {
  const dir = mkdtempSync(join(tmpdir(), "openrig-scoped-psmux-"));
  const registry = join(dir, "registry"); mkdirSync(registry);
  const namespace = `scoped-${randomUUID()}`;
  const env = { SHELL: shell, SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: dirname(shell) + ";" + process.env.SystemRoot + "\\System32", HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir, TEMP: dir, TMP: dir, PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL", UNRELATED: "server-only" };
  const run = promisify(execFile);
  const invoke = async (argv: string[]) => (await run(process.env.OPENRIG_TEST_PSMUX!, ["-L", namespace, ...argv.slice(1)], { env, cwd: dir, timeout: 10000, windowsHide: true })).stdout;
  const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
  const output = join(dir, "result.json");
  try {
    expect(await adapter.startServer()).toEqual({ ok: true });
    expect(await adapter.getDefaultShell()).toBeTruthy();
    // Configure the held empty server before its first actual session.
    await invoke(["tmux", "set-option", "-g", "remain-on-exit", "on"]);
    const command = `[IO.File]::WriteAllText(${powershellQuote(output)},(ConvertTo-Json @{ selected=$env:SELECTED; unrelated=$env:UNRELATED; pane=$env:TMUX_PANE; registry=$env:PSMUX_DATA_DIR }))`;
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`]);
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { SystemRoot: process.env.SystemRoot, SELECTED: "synthetic-selected" } });
    expect(await adapter.createSession("seat", dir, { OPENRIG_NODE_ID: "synthetic-seat" })).toEqual({ ok: true });
    const deadline = Date.now() + 7000;
    while (!existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const observed = JSON.parse(readFileSync(output, "utf8"));
    expect(observed.selected).toBe("synthetic-selected");
    expect(observed.unrelated).toBeNull();
    expect(observed.pane).toBeTruthy();
    expect(observed.registry).toBe(registry);
    const pane = (await adapter.listPanes("seat"))[0]!;
    const deadDeadline = Date.now() + 5000;
    while (!await adapter.isPaneDead(pane.id) && Date.now() < deadDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(await adapter.isPaneDead(pane.id)).toBe(true);
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile`]);
    const nextOutput = join(dir, "respawn.json");
    const routeOutput = join(dir, "route.txt");
    const routeScript = join(dir, "route.cjs");
    writeFileSync(routeScript, `const r=require('child_process').spawnSync(${JSON.stringify(process.env.OPENRIG_TEST_PSMUX)},${JSON.stringify(["-L", namespace, "list-panes", "-t", "=seat:", "-F", "#{pane_id}"])},{encoding:'utf8',timeout:5000});require('fs').writeFileSync(${JSON.stringify(routeOutput)},JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));`);
    const routeCommand = `if ($env:PSMUX_DATA_DIR -ne ${powershellQuote(registry)}) { throw 'Owned registry missing' }; & ${powershellQuote(process.execPath)} ${powershellQuote(routeScript)}; `;
    expect(await adapter.respawnPane(pane.id, routeCommand + command.replace(output, nextOutput), { cwd: dir, env: { OPENRIG_NODE_ID: "synthetic-seat", SELECTED: "successor" } })).toEqual({ ok: true });
    const nextDeadline = Date.now() + 7000;
    while (!existsSync(nextOutput) && Date.now() < nextDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(JSON.parse(readFileSync(nextOutput, "utf8"))).toMatchObject({ selected: "successor", unrelated: null });
    if (!existsSync(routeOutput)) console.log("owned route diagnostics", (await adapter.capturePaneScreen("seat"))?.slice(-2500));
    expect(JSON.parse(readFileSync(routeOutput, "utf8"))).toMatchObject({ status: 0, stdout: observed.pane + "\n", stderr: "" });
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile -NoExit`]);
    expect(await adapter.createSession("interactive", dir, { OPENRIG_NODE_ID: "synthetic-interactive", SELECTED: "interactive-selected" })).toEqual({ ok: true });
    const interactiveOutput = join(dir, "interactive.json");
    expect(await adapter.sendShellCommand("interactive", `[IO.File]::WriteAllText(${powershellQuote(interactiveOutput)}, (ConvertTo-Json @{ selected=$env:SELECTED; unrelated=$env:UNRELATED }))`)).toEqual({ ok: true });
    const inputDeadline = Date.now() + 7000;
    while (!existsSync(interactiveOutput) && Date.now() < inputDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(JSON.parse(readFileSync(interactiveOutput, "utf8"))).toEqual({ selected: "interactive-selected", unrelated: null });
  } finally {
    await invoke(["tmux", "kill-server"]).catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);
