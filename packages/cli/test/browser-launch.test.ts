import { describe, expect, it } from "vitest";
import { browserLaunch } from "../src/browser-launch.js";
describe("browser launch", () => {
  it.each([["darwin", "open"], ["linux", "xdg-open"]] as const)("opens URLs on %s", (platform, command) => {
    expect(browserLaunch("http://localhost:7433", platform)).toEqual({ command, args: ["http://localhost:7433"] });
  });
  it("passes Windows URLs literally without cmd expansion or PowerShell evaluation", () => {
    const url = "http://localhost:7433/?q=';%PATH%&$(throw 'bad')中文";
    const launch = browserLaunch(url, "win32");
    expect(launch.command).toBe("powershell.exe");
    expect(launch.args).toContain("-NoProfile");
    const script = Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toBe("$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'http://localhost:7433/?q='';%PATH%&$(throw ''bad'')中文'");
  });
});
