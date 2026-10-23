/** Launch URLs as arguments; never interpolate them into a command shell. */
export function browserLaunch(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "win32") {
    const literal = "'" + url.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literal}`;
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    };
  }
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}
