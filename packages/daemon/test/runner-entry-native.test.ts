import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

it.runIf(process.platform === "win32").each(["pi-runner", "stub-runner"])("executes the compiled %s entry through Windows case and junction aliases", name => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-entry-native-"));
  const alias = path.join(root, "adapter-alias");
  try {
    const entry = path.resolve(import.meta.dirname, "../dist/adapters", `${name.toUpperCase()}.js`);
    const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, OPENRIG_HOME: root };
    // No required arguments: a direct entry must report its argument error
    // before any runner state, provider lookup or hook can be started.
    fs.symlinkSync(path.dirname(entry), alias, "junction");
    for (const selected of [entry, path.join(alias, `${name}.js`)]) {
    const direct = spawnSync(process.execPath, [selected], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10000 });
    expect(direct.error).toBeUndefined();
    expect(direct.status).not.toBe(0);
    expect(direct.stderr).toContain("--session-name is required");
    expect(fs.readdirSync(root)).toEqual(["adapter-alias"]);
    }
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL(`../dist/adapters/${name}.js`, import.meta.url).href)});console.log('import-only');`],
      { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10000 });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout.trim()).toBe("import-only");
    expect(fs.readdirSync(root)).toEqual(["adapter-alias"]);
  } finally { if (fs.existsSync(alias)) fs.unlinkSync(alias); fs.rmSync(root, { recursive: true, force: true }); }
});
