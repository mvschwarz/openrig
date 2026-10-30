import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeWindowsPrivateConfig } from "../src/adapters/windows-private-config.js";

describe.skipIf(process.platform !== "win32")("private native config DACL", () => {
  it("protects its parent before writing and removes its own file/directory", async () => {
    const content = "synthetic-only\n", file = await writeWindowsPrivateConfig(content);
    const directory = path.dirname(file.path);
    try {
      expect(await readFile(file.path, "utf8")).toBe(content);
      const script = "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=[IO.File]::GetAccessControl($env:OPENRIG_DACL_TEST_FILE);$r=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);[Console]::Write(($r.Count -eq 1 -and $r[0].IdentityReference.Value -eq $sid.Value -and $r[0].IsInherited).ToString())";
      const result = await promisify(execFile)(path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, OPENRIG_DACL_TEST_FILE: file.path }, windowsHide: true });
      expect(result.stdout.trim()).toBe("True");
    } finally { await file.dispose(); }
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
