import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeRuntimeStubs } from "../../../test/stub-runtimes.js";
import { resolveWindowsProviderCommand } from "../src/domain/windows-provider-command.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "win32")("native test runtime isolation", () => {
  it("resolves and executes owned native stubs without a host provider fallback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-stub-native-"));
    roots.push(root);
    const bin = writeRuntimeStubs(root);
    for (const name of ["codex", "claude"] as const) {
      const file = path.join(bin, `${name}.exe`);
      expect(fs.existsSync(file)).toBe(true);
      const resolved = resolveWindowsProviderCommand(name, { ...process.env, PATH: bin }, root);
      expect(resolved.command).toBe(fs.realpathSync(file));
      expect(resolved.prefix).toEqual([]);
      const version = spawnSync(resolved.command, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(name === "codex" ? "codex-cli 0.139.0" : "2.1.0 (Claude Code)");
      const inert = spawnSync(resolved.command, ["SYNTHETIC_NO_PROVIDER_CALL"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      expect(inert.status).toBe(0);
      expect(inert.stdout + inert.stderr).toBe("");
      const before = fs.statSync(file).mtimeMs;
      writeRuntimeStubs(root);
      expect(fs.statSync(file).mtimeMs).toBe(before);
    }
  }, 20_000);
});
