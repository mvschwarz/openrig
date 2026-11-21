import { spawnSync } from "node:child_process";
import path from "node:path";

/** These inspection callers supply fixed CLI words, never shell programs. */
export function runRig(rig, args) {
  if (process.platform !== "win32") return spawnSync(rig, args, { encoding: "utf8" });
  if (args.some(arg => !/^[A-Za-z0-9_-]+$/.test(arg))) {
    return { status: 1, stdout: "", stderr: "Upgrade probe arguments must be literal CLI words" };
  }
  const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const located = spawnSync(path.join(system, "WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $bin=$env:OPENRIG_SKILL_RIG_COMMAND; if(Test-Path -LiteralPath $bin -PathType Leaf){$command=(Get-Item -LiteralPath $bin).FullName}else{$command=(Get-Command -Name $bin -CommandType Application -ErrorAction Stop).Source}; ConvertTo-Json -Compress -InputObject $command",
  ], { encoding: "utf8", windowsHide: true, env: { ...process.env, OPENRIG_SKILL_RIG_COMMAND: rig } });
  if (located.status !== 0) return located;
  let command;
  try { command = JSON.parse(located.stdout.trim()); } catch {
    return { status: 1, stdout: "", stderr: "Could not resolve the installed rig command" };
  }
  if (typeof command !== "string" || !path.isAbsolute(command) || /["\r\n]/.test(command)) {
    return { status: 1, stdout: "", stderr: "The installed rig command is not an absolute executable path" };
  }
  if (/\.(?:cmd|bat)$/i.test(command)) {
    // cmd expands this variable once. Percent sequences in its VALUE stay literal;
    // embedding the path in PowerShell's native .cmd invocation expands them again.
    // No CALL, delayed expansion, shell-derived args, or working-directory change.
    return spawnSync(path.join(system, "cmd.exe"), ["/d", "/v:off", "/s", "/c",
      `""%OPENRIG_SKILL_RIG_COMMAND%" ${args.join(" ")}"`], {
      encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, OPENRIG_SKILL_RIG_COMMAND: command },
    });
  }
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}
