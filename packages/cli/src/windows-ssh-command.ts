import { renderWindowsLaunchArgv } from "@openrig/daemon/windows-launch";
import type { SshHostEntry } from "./host-registry.js";

/** The selected remote shell is a registry fact, never the caller's OS. */
export function windowsSshCommand(host: SshHostEntry, argv: readonly string[], originTriple?: string): string {
  if (!argv.length || argv.some(value => value.includes("\0")) || originTriple?.includes("\0")) throw new Error("Invalid native SSH arguments");
  let words = [...argv];
  if (words[0] === "rig") {
    if (!host.rigPath || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(host.rigPath)
      || /[\x00-\x1f]/.test(host.rigPath) || !/\.(?:cjs|mjs|js)$/i.test(host.rigPath)) throw new Error("Native SSH requires the absolute remote rig JavaScript entry in rigPath");
    // Starting the paired entry directly avoids cmd/PowerShell 5 shim argv loss.
    words = ["node.exe", host.rigPath, ...words.slice(1)];
  }
  const script = "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)\n"
    + renderWindowsLaunchArgv(words, originTriple ? { OPENRIG_SESSION_NAME: originTriple } : {}, {
      beforeStart: "$openrigResolved=Get-Command $openrigStart.FileName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n"
        + "if (!$openrigResolved) { [Console]::Error.WriteLine('remote command not found: '+$openrigStart.FileName); exit 127 }\n"
        + "$openrigStart.FileName=$openrigResolved.Source\n",
    })
    + "\nexit $global:LASTEXITCODE\n";
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
