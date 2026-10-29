import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("upgrade inspection executes an installed Windows cmd shim with literal probe arguments", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig upgrade [native]-"));
  const receiver = join(root, "receiver.cjs"), shim = join(root, "rig.cmd");
  try {
    await writeFile(receiver, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),label:'原生🙂'}));if(process.argv[2]==='plugin'){process.stderr.write('synthetic plugin failure');process.exitCode=7;}");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${receiver}" %*\r\n`);
    for (const bin of [shim, "rig"]) {
      const env = { ...process.env, OPENRIG_RIG_BIN: bin };
      const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") || "PATH";
      env[pathKey] = root + delimiter + (env[pathKey] || "");
      const result = spawnSync(process.execPath, [resolve("packages/daemon/specs/agents/shared/skills/core/openrig-upgrade/scripts/inspect-upgrade.mjs")], {
        encoding: "utf8", windowsHide: true, env,
      });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ready, false);
    assert.deepEqual(report.rigVersion.value.args, ["--version"]);
    assert.equal(report.rigVersion.value.label, "原生🙂");
    assert.deepEqual(report.daemonStatus.value.args, ["daemon", "status"]);
    assert.deepEqual(report.nodes.value.args, ["ps", "--nodes", "-A", "--json"]);
    assert.equal(report.plugins.ok, false);
    assert.equal(report.plugins.exitCode, 7);
    assert.match(report.plugins.error, /synthetic plugin failure/);
    }
  } finally {
    // Only the freshly allocated fixture; all synchronous probe children exited.
    assert.equal(root.startsWith(join(tmpdir(), "openrig upgrade [native]-")), true);
    await rm(root, { recursive: true });
  }
});
