import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const python = process.env.OPENRIG_TEST_PYTHON;
const scripts = resolve("packages/daemon/assets/plugins/openrig-core/skills");
test("Python composers resolve a recognized npm rig entry and decode UTF-8 CLI responses", { skip: process.platform !== "win32" || !python }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "openrig rig shim & 中文 "));
  try {
    const log = join(fixture, "calls.jsonl"), expected = join(fixture, "真实 work tree");
    const pkg = join(fixture, "node_modules", "@openrig", "cli"), entry = join(pkg, "reply.cjs");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@openrig/cli", bin: { rig: "reply.cjs" } }));
    const shim = '@echo off\r\n"node" "%dp0%\\node_modules\\@openrig\\cli\\reply.cjs" %*\r\n';
    await writeFile(join(fixture, "rig.cmd"), shim);
    await writeFile(entry, `const fs=require('fs');fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(process.env.FIXTURE_ROOT+'\\n');`);
    const code = `import runpy,sys,json,os\nmodules=[runpy.run_path(p) for p in sys.argv[1:]]\nprint(json.dumps([modules[0]['rig_config']('workspace.root'),modules[1]['rig_output']('config','get','workspace.root'),modules[1]['rig_output']('whoami','--json')]))`;
    const files = [join(scripts, "openrig-operating-model/scripts/compose.py"), join(scripts, "refocusing/scripts/trace-to-root.py")];
    const env = { ...process.env, PATH: fixture, OPENRIG_NODE: process.execPath, PATHEXT: ".COM;.EXE;.BAT;.CMD", FIXTURE_LOG: log, FIXTURE_ROOT: expected, PYTHONIOENCODING: "utf-8" };
    const result = spawnSync(python, ["-c", code, ...files], { env, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [expected, expected, expected]);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [["config", "get", "workspace.root"], ["config", "get", "workspace.root"], ["whoami", "--json"]]);
    const missing = spawnSync(python, ["-c", code, ...files], { env: { ...env, PATH: "" }, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(missing.status, 0, missing.stderr); assert.deepEqual(JSON.parse(missing.stdout), [null, null, null]);
    await writeFile(join(fixture, "rig.cmd"), "@exit /b 7\r\n");
    const failed = spawnSync(python, ["-c", code, ...files], { env, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(failed.status, 0, failed.stderr); assert.deepEqual(JSON.parse(failed.stdout), [null, null, null]);
    await writeFile(join(fixture, "rig.cmd"), shim);
    await writeFile(entry, "process.stdout.write(Buffer.from([255]));");
    const malformed = spawnSync(python, ["-c", code, ...files], { env, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(malformed.status, 0, malformed.stderr); assert.deepEqual(JSON.parse(malformed.stdout), [null, null, null]);
  } finally { assert.equal(fixture.startsWith(join(tmpdir(), "openrig rig shim & 中文 ")), true); await rm(fixture, { recursive: true }); }
});
