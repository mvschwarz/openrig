import { test, expect } from "vitest";
import { nativeViewerCommand } from "../src/domain/terminal/native-viewer-command.js";
import { windowsTileAttachArgv, readWindowsTileAttachArgv } from "../src/domain/terminal/windows-tile-attach.js";
import { sameViewerCwd } from "../src/domain/terminal/herdr-viewer.js";

test("native cwd attribution accepts Herdr spelling but rejects a sibling", () => {
  expect(sameViewerCwd("c:\\Owned\\viewer\\", "C:/owned/viewer", "win32")).toBe(true);
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
  expect(nativeViewerCommand(["C:\\owned path\\tool.exe", "a'b;$x"], "C:\\Windows\\powershell.exe")).toBe("& 'C:\\owned path\\tool.exe' 'a''b;$x'");
  expect(nativeViewerCommand(["C:\\owned path\\tool.exe", "$x"], "bash.exe")).toBe("'C:/owned path/tool.exe' '$x'");
  for (const shell of ["node.exe", "cmd.exe", "unknown"]) expect(() => nativeViewerCommand(["tool", "%PATH%"], shell)).toThrow(/unqualified/);
  expect(() => nativeViewerCommand(["bad\0arg"], "pwsh.exe")).toThrow(/Invalid/);
});
