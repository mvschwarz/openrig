import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { npmCommand } from "./npm-command.mjs";

test("native npm invocation retains literal arguments and child status without a command shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig npm % & # 中文 "));
  try {
    const cli = join(root, "npm receiver.cjs");
    await writeFile(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write('fixture stderr');process.exitCode=7;");
    const args = ["pack", "space value", 'a"b', "&echo injected", "%PATH%", "$HOME", "", "尾部\\"];
    const command = npmCommand(args, { platform: "win32", env: { npm_execpath: cli } });
    const result = spawnSync(...command, { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 7); assert.equal(result.stderr, "fixture stderr"); assert.deepEqual(JSON.parse(result.stdout), args);
    assert.deepEqual(npmCommand(args, { platform: "win32", env: {} }), [process.execPath, [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args]]);
    assert.deepEqual(npmCommand(args, { platform: "linux", env: {} }), ["npm", args]);
  } finally { await rm(root, { recursive: true }); }
});
