import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it.runIf(process.platform === "win32")("reads an owned log through a junction entry without starting on import", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "log-entry-native-"));
  const alias = path.join(root, "source");
  try {
    fs.symlinkSync(path.resolve(import.meta.dirname, "../src"), alias, "junction");
    const log = path.join(root, "owned.log");
    fs.writeFileSync(log, "owned-log-only\n");
    const entry = path.join(alias, "log-tail.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, log], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, OPENRIG_HOME: root },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("owned-log-only\n");
    const imported = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `await import(${JSON.stringify(new URL("../src/log-tail.ts", import.meta.url).href)});console.log('import-only');`, log],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout.trim()).toBe("import-only");
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
