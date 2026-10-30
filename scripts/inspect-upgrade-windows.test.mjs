import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("telemetry migration plan reads Windows rig.cmd inventory without applying state", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig telemetry [native]-"));
  const home = join(root, "home"), log = join(root, "calls.json"), receiver = join(root, "receiver.cjs"), shim = join(root, "rig.cmd");
  try {
    await mkdir(home);
    await writeFile(receiver, "require('fs').writeFileSync(process.env.TEST_INVENTORY_LOG,JSON.stringify(process.argv.slice(2)));if(process.env.TEST_INVENTORY_FAIL){console.error('synthetic inventory failure');process.exit(7);}console.log(JSON.stringify({entries:[]}));");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${receiver}" %*\r\n`);
    for (const script of [resolve("packages/daemon/specs/agents/shared/skills/core/openrig-upgrade/scripts/migrate-telemetry-state-0.5.9.mjs"),
      resolve("skills/_canonical/core/openrig-upgrade/scripts/migrate-telemetry-state-0.5.9.mjs")]) for (const fail of [false, true]) {
      const run = spawnSync(process.execPath, [script, "--home", home], { encoding:"utf8", windowsHide:true,
        env:{...process.env,OPENRIG_RIG_BIN:shim,TEST_INVENTORY_LOG:log,TEST_INVENTORY_FAIL:fail?'1':''} });
      assert.equal(run.status,0,run.stderr);
      const report=JSON.parse(run.stdout);
      assert.equal(report.phase,'plan'); assert.equal(report.applied,false);
      assert.equal(report.issues.some(issue=>issue.code==='inventory_unavailable'),fail,run.stdout);
      assert.deepEqual(JSON.parse(await readFile(log,'utf8')),["ps","--nodes","-A","--json","--full"]);
      if(fail)assert.match(JSON.stringify(report.issues),/synthetic inventory failure/);
      assert.deepEqual(await readdir(home),[]);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

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
