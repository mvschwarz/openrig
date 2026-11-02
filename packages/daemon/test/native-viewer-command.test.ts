import { test, expect } from "vitest";
import { nativeViewerCommand, nativeViewerShellCommand } from "../src/domain/terminal/native-viewer-command.js";
import { windowsTileAttachArgv, readWindowsTileAttachArgv } from "../src/domain/terminal/windows-tile-attach.js";
import { sameViewerCwd } from "../src/domain/terminal/herdr-viewer.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test.skipIf(process.platform !== "win32")("native cwd attribution accepts a live alias but rejects siblings and missing paths", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"viewer-cwd-"));
  try {
    const owned=path.join(root,"Owned"), sibling=path.join(root,"Sibling");fs.mkdirSync(owned);fs.mkdirSync(sibling);
    expect(sameViewerCwd(owned.toUpperCase()+"\\",owned,"win32")).toBe(true);
    expect(sameViewerCwd(sibling,owned,"win32")).toBe(false);
    expect(sameViewerCwd(path.join(root,"missing"),path.join(root,"missing"),"win32")).toBe(false);
    expect(sameViewerCwd(root,owned,"win32")).toBe(false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  expect(sameViewerCwd("C:/owned/viewer-other", "C:/owned/viewer", "win32")).toBe(false);
  expect(sameViewerCwd("viewer", "viewer", "win32")).toBe(false);
  expect(sameViewerCwd("/owned/viewer/", "/owned/viewer", "linux")).toBe(false);
});

test("native viewer decodes only the exact installed tile wrapper", () => {
  const argv = windowsTileAttachArgv("C:\\owned path\\psmux.exe", ["-S", "C:\\private\\server"], "seat ' 中文", true, 4);
  expect(readWindowsTileAttachArgv(argv)).toEqual({tmux:"C:\\owned path\\psmux.exe",server:["-S","C:\\private\\server"],session:"seat ' 中文",readOnly:true,retrySeconds:4});
  const changed = [...argv]; changed[0] = "untrusted.exe";
  expect(readWindowsTileAttachArgv(changed)).toBeNull();
  const injected = [...argv]; injected[5] = Buffer.from(Buffer.from(argv[5]!, "base64").toString("utf16le") + "; exit 0", "utf16le").toString("base64");
  expect(readWindowsTileAttachArgv(injected)).toBeNull();
});

test("viewer command quotes shell data and refuses an unqualified foreground", () => {
  expect(nativeViewerCommand(["C:\\owned path\\tool.exe", "a'b;$x"], "C:\\Windows\\powershell.exe")).toMatch(/^& \(\[ScriptBlock\]::Create/);
  expect(nativeViewerCommand(["C:\\owned path\\tool.exe", "$x"], "bash.exe")).toBe("'C:/owned path/tool.exe' '$x'");
  for (const shell of ["node.exe", "unknown"]) expect(() => nativeViewerCommand(["tool", "%PATH%"], shell)).toThrow(/unqualified/);
  expect(() => nativeViewerCommand(["bad\0arg"], "pwsh.exe")).toThrow(/Invalid/);
});

test("native viewer dispatch requires the sole foreground process to be its shell", () => {
  expect(nativeViewerShellCommand(["tool"], {shell_pid:42,foreground_processes:[{pid:42,argv:["pwsh.exe"]}]})).toBe(nativeViewerCommand(["tool"], "pwsh.exe"));
  for (const info of [{}, {shell_pid:42,foreground_processes:[{pid:43,argv:["pwsh.exe"]}]},
    {shell_pid:42,foreground_processes:[{pid:42,argv:["node.exe"]}]},
    {shell_pid:42,foreground_processes:[{pid:42,argv:["pwsh.exe"]},{pid:43,argv:["editor.exe"]}]}])
    expect(() => nativeViewerShellCommand(["tool"], info)).toThrow();
});

test("cmd keeps the canonical tile wrapper compact and rejects oversized input", () => {
  const argv = windowsTileAttachArgv("C:\\owned path\\psmux.exe", [], "seat %PATH% !x! 中文", true);
  const command = nativeViewerCommand(argv, "cmd.exe");
  expect(command).toContain(argv[5]);
  expect(command).not.toContain("%PATH%");
  expect(command.length).toBeLessThan(8191);
  expect(nativeViewerCommand(argv, "powershell.exe")).toBe("& " + argv.map(v => "'" + v.replaceAll("'", "''") + "'").join(" "));
  expect(() => nativeViewerCommand(["tool", "x".repeat(10000)], "cmd.exe")).toThrow(/input limit/);
});
