import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { windowsScopedLaunch } from "../src/adapters/windows-scoped-launch.js";
import { powershellQuote } from "../src/adapters/windows-launch.js";
import { readWindowsProcessesStrict } from "../src/domain/windows-process-table.js";
import { isWindowsScopedBootstrap } from "../src/domain/windows-cmd-bridge.js";

const nativeShells = [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ...(process.env.OPENRIG_TEST_PWSH ? [process.env.OPENRIG_TEST_PWSH] : [])];

describe.skipIf(process.platform !== "win32")("native scoped shell bootstrap", () => {
  it("enforces a seat Job commit limit before the selected shell runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-seat-job-"));
    try {
      const file = join(dir, "launch.ps1"), marker = join(dir, "marker"), output = join(dir, "result.txt"), target = join(dir, "target.ps1");
      writeFileSync(marker, "pending");
      const targetScript = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class SeatCommitTest { [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr VirtualAlloc(IntPtr p,UIntPtr size,uint type,uint protect); [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess(); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool result); }'; ` +
        `$p=[SeatCommitTest]::VirtualAlloc([IntPtr]::Zero,[UIntPtr]::new(536870912),0x3000,4); ` +
        `$inside=$false; [void][SeatCommitTest]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle,[IntPtr]::Zero,[ref]$inside); ` +
        `[IO.File]::WriteAllText(${powershellQuote(output)},([string]($p -eq [IntPtr]::Zero)+'|'+$inside+'|'+$PID))`;
      writeFileSync(target, targetScript);
      const command = `& ${powershellQuote(target)}`;
      const launch = windowsScopedLaunch(`"${nativeShells[0]}" -NoProfile`, command, { SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir }, file, false, undefined,
        { memoryMax: 268435456, marker });
      writeFileSync(file, launch.content);
      const result = spawnSync(launch.argv[0]!, launch.argv.slice(1), { cwd: dir, env: process.env, encoding: "utf8", windowsHide: true, timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      const marked = readFileSync(marker, "utf8");
      expect(marked).toMatch(/^started\|\d+$/);
      expect(readFileSync(output, "utf8")).toBe("True|True|" + marked.split("|")[1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
  it("recovers without its consumed file using current allowed session values and hides recovery metadata", () => {
    const dir=mkdtempSync(join(tmpdir(),"openrig-recover-"));
    try {
      const file=join(dir,"initial.ps1"), output=join(dir,"result.json"), key="OPENRIG_LAUNCH_RECOVERY_0123456789abcdef0123456789abcdef";
      const command=`[IO.File]::WriteAllText(${powershellQuote(output)},(ConvertTo-Json @{selected=$env:SELECTED; unrelated=$env:UNRELATED; recovery=@(Get-ChildItem Env: | Where-Object Name -like 'OPENRIG_LAUNCH_RECOVERY_*').Count}))`;
      const first="private initial ' 中文", latest="current session value";
      const launch=windowsScopedLaunch(`"${nativeShells[0]}" -NoProfile`,command,{SystemRoot:process.env.SystemRoot,SELECTED:first},file,false,key);
      expect(launch.recovery).toBeDefined();expect(Buffer.from(launch.recovery!.value,"base64").toString()).not.toContain(first);
      expect(Buffer.from(launch.argv.at(-1)!,"base64").toString("utf16le")).not.toContain(first);
      writeFileSync(file,launch.content);
      const env={SystemRoot:process.env.SystemRoot,UNRELATED:"server-only",SELECTED:latest,[key]:launch.recovery!.value};
      for(const expected of [first,latest]){
        const result=spawnSync(launch.argv[0]!,launch.argv.slice(1),{cwd:dir,env,encoding:"utf8",windowsHide:true,timeout:15000});
        expect(result.status,result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(output,"utf8"))).toEqual({selected:expected,unrelated:null,recovery:0});
        expect(existsSync(file)).toBe(false);
      }
      const missing=spawnSync(launch.argv[0]!,launch.argv.slice(1),{cwd:dir,env:{SystemRoot:process.env.SystemRoot},encoding:"utf8",windowsHide:true,timeout:15000});
      expect(missing.status).not.toBe(0);expect(missing.stderr).toContain("Native launch recovery is unavailable");
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
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
    expect(() => windowsScopedLaunch("unknown-shell.exe", "", {}, "unused")).toThrow("Unsupported native scoped shell");
  });
  it.skipIf(!existsSync("C:/Program Files/Git/bin/bash.exe"))("preserves a configured Git Bash shell and inherited environment without value argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-private-bash-"));
    try {
      const file = join(dir, "launch.ps1"), value = "synthetic ' 中文\nline";
      const launch = windowsScopedLaunch('"C:/Program Files/Git/bin/bash.exe" --noprofile --norc', 'printf "%s\\n%s" "$SELECTED" "$INHERITED_OWNED"', { SELECTED: value }, file, true);
      writeFileSync(file, launch.content);
      expect(launch.argv.join(" ")).not.toContain(value);
      const output = execFileSync(launch.argv[0]!, launch.argv.slice(1), { cwd: dir, env: { SystemRoot: process.env.SystemRoot, HOME: dir, INHERITED_OWNED: "server value" }, encoding: "utf8", timeout: 15000, windowsHide: true });
      expect(output.replaceAll("\r\n", "\n")).toBe(value + "\nserver value");
      expect(existsSync(file)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reports an unavailable selected shell and consumes only its owned bootstrap", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-scoped-missing-"));
    try {
      const file = join(dir, "private launch.sh");
      const shell = join(dir, "missing", "powershell.exe");
      const launch = windowsScopedLaunch(`"${shell}" -NoProfile`, "", { SystemRoot: process.env.SystemRoot }, file);
      writeFileSync(file, launch.content);
      const result = spawnSync(launch.argv[0]!, launch.argv.slice(1),
        { cwd: dir, env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8", timeout: 15_000, windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).not.toBe("");
      expect(existsSync(file)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
    const command = `[IO.File]::WriteAllText(${powershellQuote(output)},(ConvertTo-Json @{ selected=$env:SELECTED; unrelated=$env:UNRELATED; pane=$env:TMUX_PANE; registry=$env:PSMUX_DATA_DIR; programFilesX86=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)') }))`;
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`]);
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { SystemRoot: process.env.SystemRoot, SELECTED: "synthetic-selected" } });
    expect(await adapter.createSession("seat", dir, { OPENRIG_NODE_ID: "synthetic-seat", "ProgramFiles(x86)": "owned x86 & path" })).toEqual({ ok: true });
    const deadline = Date.now() + 7000;
    while (!existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const observed = JSON.parse(readFileSync(output, "utf8"));
    expect(observed.selected).toBe("synthetic-selected");
    expect(observed.unrelated).toBeNull();
    expect(observed.pane).toBeTruthy();
    expect(observed.registry).toBe(registry);
    expect(observed.programFilesX86).toBe("owned x86 & path");
    const pane = (await adapter.listPanes("seat"))[0]!;
    const deadDeadline = Date.now() + 5000;
    while (!await adapter.isPaneDead(pane.id) && Date.now() < deadDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(await adapter.isPaneDead(pane.id)).toBe(true);
    await adapter.setSessionEnv("seat","SELECTED","updated scoped session");
    await adapter.setSessionEnv("seat","ProgramFiles(x86)","updated x86 path");
    unlinkSync(output);
    await invoke(["tmux","respawn-pane","-t","=seat:0.0"]);
    await expect.poll(()=>existsSync(output),{timeout:7000}).toBe(true);
    expect(JSON.parse(readFileSync(output,"utf8"))).toMatchObject({selected:"updated scoped session",unrelated:null,programFilesX86:"updated x86 path"});
    await expect.poll(()=>adapter.isPaneDead(pane.id),{timeout:5000}).toBe(true);
    await adapter.unsetSessionEnv("seat","ProgramFiles(x86)");
    unlinkSync(output);
    await invoke(["tmux","respawn-pane","-t","=seat:0.0"]);
    await expect.poll(()=>existsSync(output),{timeout:7000}).toBe(true);
    expect(JSON.parse(readFileSync(output,"utf8"))).toMatchObject({selected:"updated scoped session",unrelated:null,programFilesX86:null});
    await expect.poll(()=>adapter.isPaneDead(pane.id),{timeout:5000}).toBe(true);
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
    await expect.poll(()=>adapter.isPaneDead(pane.id),{timeout:5000}).toBe(true);
    await adapter.setSessionEnv("seat","SELECTED","updated successor session");
    unlinkSync(nextOutput);
    await invoke(["tmux","respawn-pane","-t","=seat:0.0"]);
    await expect.poll(()=>existsSync(nextOutput),{timeout:7000}).toBe(true);
    expect(JSON.parse(readFileSync(nextOutput,"utf8"))).toMatchObject({selected:"updated successor session",unrelated:null});
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

it.skipIf(process.platform !== "win32" || !process.env.OPENRIG_TEST_PSMUX)("enforces and reads a Job through an isolated psmux seat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openrig-seat-job-psmux-")), registry = join(dir, "registry"); mkdirSync(registry);
  const namespace = `seat-job-${randomUUID()}`, output = join(dir, "target.txt"), target = join(dir, "target.ps1"), release = join(dir, "release");
  const shell = nativeShells[0]!;
  const env = { SHELL: shell, SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: dirname(shell) + ";" + process.env.SystemRoot + "\\System32", HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir, TEMP: dir, TMP: dir, PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL" };
  writeFileSync(target, `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PsmuxCommitTest {[DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr VirtualAlloc(IntPtr p,UIntPtr n,uint t,uint f);}'; ` +
    `$p=[PsmuxCommitTest]::VirtualAlloc([IntPtr]::Zero,[UIntPtr]::new(536870912),0x3000,4); [IO.File]::WriteAllText(${powershellQuote(output)},[string]($p -eq [IntPtr]::Zero)); ` +
    `$until=[DateTime]::UtcNow.AddSeconds(45); while(-not [IO.File]::Exists(${powershellQuote(release)}) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 100 }`);
  const invoke = async (argv: string[]) => (await promisify(execFile)(process.env.OPENRIG_TEST_PSMUX!, ["-L", namespace, ...argv.slice(1)], { env, cwd: dir, timeout: 10000, windowsHide: true })).stdout;
  const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
  adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { ...env } });
  adapter.seatProcessLimits = id => id === "synthetic-seat" ? { memoryMax: 268435456 } : undefined;
  try {
    expect(await adapter.startServer()).toEqual({ ok: true });
    await invoke(["tmux", "set-option", "-g", "remain-on-exit", "on"]);
    const command = `& ${powershellQuote(target)}`;
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`]);
    const created = await adapter.createSession("seat", dir, { OPENRIG_NODE_ID: "synthetic-seat" });
    expect(created).toMatchObject({ ok: true });
    await expect.poll(() => existsSync(output), { timeout: 12000 }).toBe(true);
    expect(readFileSync(output, "utf8")).toBe("True");
    const pane = (await adapter.listPanes("seat"))[0]!;
    expect(await adapter.readSeatProcessLimits(pane.id, { memoryMax: 268435456 }, "synthetic-seat"))
      .toMatchObject({ state: "applied", memoryAccounting: "job_commit", memoryMax: "268435456" });
    const observer = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    observer.launchEnvironment = adapter.launchEnvironment;
    expect(await observer.readSeatProcessLimits(pane.id, { memoryMax: 268435456 }, "synthetic-seat"))
      .toMatchObject({ state: "applied", memoryAccounting: "job_commit", memoryMax: "268435456" });
    // The owned fixture alone is terminated; birth identity is rechecked before
    // signalling, and the target exits separately through its release file.
    const panePid = await adapter.getPanePid(pane.id), rows = await readWindowsProcessesStrict();
    const underPane = (pid: number) => {
      const seen = new Set<number>(); let current = rows.find(row => row.pid === pid);
      while (current && !seen.has(current.pid)) { if (current.pid === panePid) return true; seen.add(current.pid); current = rows.find(row => row.pid === current!.ppid); }
      return false;
    };
    const guardians = rows.filter(row => underPane(row.pid) && isWindowsScopedBootstrap(row));
    expect(guardians).toHaveLength(1);
    const guardian = guardians[0]!;
    const targets = rows.filter(row => row.ppid === guardian.pid && row.executableName.toLowerCase() === "powershell.exe");
    expect(targets).toHaveLength(1);
    const targetPid = targets[0]!.pid;
    const current = (await readWindowsProcessesStrict()).find(row => row.pid === guardian.pid);
    expect(current?.startedAt).toBe(guardian.startedAt); expect(current?.command).toBe(guardian.command);
    process.kill(guardian.pid);
    await expect.poll(() => { try { process.kill(guardian.pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    expect(await observer.readSeatProcessLimits(pane.id, { memoryMax: 268435456 }, "synthetic-seat")).toMatchObject({ state: "unknown" });
    writeFileSync(release, "done");
    await expect.poll(() => { try { process.kill(targetPid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    await expect.poll(() => adapter.isPaneDead(pane.id), { timeout: 10000 }).toBe(true);
    expect(await observer.readSeatProcessLimits(pane.id, { memoryMax: 268435456 }, "synthetic-seat"))
      .toMatchObject({ state: "unknown" });
    unlinkSync(release); unlinkSync(output);
    await invoke(["tmux", "set-option", "-g", "default-shell", `"${shell}" -NoProfile`]);
    const recovered = await adapter.respawnPane(pane.id, `& ${powershellQuote(target)}`,
      { cwd: dir, env: { ...env, OPENRIG_NODE_ID: "synthetic-seat" }, processLimitsMode: "recovery" });
    expect(recovered).toMatchObject({ ok: true });
    await expect.poll(() => existsSync(output), { timeout: 12000 }).toBe(true);
    expect(readFileSync(output, "utf8")).toBe("True");
    expect(await observer.readSeatProcessLimits(pane.id, { memoryMax: 268435456 }, "synthetic-seat"))
      .toMatchObject({ state: "applied", memoryAccounting: "job_commit", memoryMax: "268435456" });
  } finally {
    writeFileSync(release, "done");
    const panes = await adapter.listPanes("seat").catch(() => []);
    if (panes[0]) await expect.poll(() => adapter.isPaneDead(panes[0]!.id), { timeout: 10000 }).toBe(true).catch(() => {});
    await invoke(["tmux", "kill-server"]).catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120000);
