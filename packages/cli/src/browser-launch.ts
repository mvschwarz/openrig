import path from "node:path";
import { readPlatformEnv } from "@openrig/daemon/windows-launch";

/** Launch URLs as arguments; never interpolate them into a command shell. */
export function browserLaunch(url: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (platform === "win32") {
    const literal = "'" + url.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literal}`;
    return {
      command: path.win32.join(readPlatformEnv(env, "SystemRoot", "win32") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    };
  }
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}
