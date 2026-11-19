import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const script = resolve("packages/daemon/assets/plugins/openrig-core/skills/openrig-operating-model/scripts/scaffold.mjs");
const templates = resolve("packages/daemon/assets/plugins/openrig-core/skills/openrig-operating-model/templates");
test("portable scaffold creates complete chains and preserves authored files on repeated and concurrent runs", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "openrig scaffold-"));
  const root = join(fixture, "结构 with spaces");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
  try {
    await mkdir(root);
    await writeFile(join(root, "SPEC.md"), "authored intent\n");
    const args = ["work", root, "--node", "team/seat one", "--node", "另一节点"];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(join(root, "SPEC.md"), "utf8"), "authored intent\n");
      for (const directory of [root, join(root, "team/seat one"), join(root, "另一节点")]) {
        for (const file of ["SPEC.md", "NOTES.md"]) {
          if (directory === root && file === "SPEC.md") continue;
          assert.deepEqual(await readFile(join(directory, file)), await readFile(join(templates, file)));
        }
      }
    }
    assert.equal((await stat(join(root, ".compose-root"))).isFile(), true);
    const topology = run("topology", root, "--node", "team/seat one");
    assert.equal(topology.status, 0, topology.stderr);
    assert.deepEqual(await readFile(join(root, "team/seat one/LEARNED.md")), await readFile(join(templates, "LEARNED.md")));
    const concurrentRoot = join(fixture, "concurrent");
    const start = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, "work", concurrentRoot, "--node", "seat"], { stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Concurrent scaffold exited ${code}`)));
    });
    await Promise.all([start(), start()]);
    for (const file of ["SPEC.md", "NOTES.md"]) {
      assert.deepEqual(await readFile(join(concurrentRoot, "seat", file)), await readFile(join(templates, file)));
    }
    const absent = join(fixture, "must-not-exist");
    for (const invalid of [["other", absent], ["work", absent, "--node"], ["work", absent, "--other", "seat"]]) {
      assert.equal(run(...invalid).status, 2);
      await assert.rejects(stat(absent), { code: "ENOENT" });
    }
  } finally {
    assert.equal(fixture.startsWith(join(tmpdir(), "openrig scaffold-")), true);
    await rm(fixture, { recursive: true });
  }
});
