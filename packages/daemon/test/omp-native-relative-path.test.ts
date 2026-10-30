import { afterEach, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveRuntimeExecutable } from "../src/adapters/pi-runner.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32").each([".EXE;.COM", ".COM;.EXE"])("resolves native relative OMP with selected extension order %s before applying the isolated child home", extensions => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-relative-native-")));
  const bin = join(root, "tools"), home = join(root, "isolated-home");
  mkdirSync(bin); mkdirSync(home);
  const executable = join(bin, extensions.startsWith(".COM") ? "omp.com" : "omp.exe");
  for (const name of ["omp.exe", "omp.com"]) copyFileSync(process.execPath, join(bin, name)); // Owned native witnesses, not installed OMP.
  const resolved = resolveRuntimeExecutable("omp", { PATH: "tools", pAtHeXt: extensions, HOME: "synthetic-operator" }, undefined, "win32", root);
  expect(resolved).toEqual({ ok: true, path: realpathSync(executable) });
  if (!resolved.ok) throw new Error(resolved.error);
  const child = spawnSync(resolved.path, ["-e", "console.log(JSON.stringify({cwd:process.cwd(),home:require('node:os').homedir()}))"], {
    cwd: root, env: { HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root },
    windowsHide: true, timeout: 5000, encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ cwd: root, home });
  expect(resolveRuntimeExecutable("omp", { PATH: "tools", PATHEXT: "", pAtHeXt: extensions }, undefined, "win32", root).ok).toBe(false);
});
