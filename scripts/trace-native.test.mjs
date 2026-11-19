import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const scripts = resolve("packages/daemon/assets/plugins/openrig-core/skills/openrig-operating-model/scripts");
const run = (name, args, env = {}) => spawnSync(process.execPath, [join(scripts, name + ".mjs"), ...args], {
  encoding: "utf8", windowsHide: true, env: { ...process.env, TRACE_MIN_HOURS: "6", TRACE_FORCE_HOURS: "72", ...env },
});
const age = async (file, hours) => { const then = new Date(Date.now() - hours * 3600000); await utimes(file, then, then); };

test("native trace gating preserves silent no-op, activity, minimum interval and force threshold", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig trace-"));
  const seat = join(root, "seat 中文 space"), work = join(root, "work");
  try {
    await mkdir(seat); await mkdir(work);
    const check = (expected, pattern, extra = []) => {
      const result = run("trace-due", [seat, ...extra]);
      assert.equal(result.status, expected, result.stderr);
      if (pattern) assert.match(result.stdout, pattern); else assert.equal(result.stdout, "");
    };
    check(1);
    const activity = join(seat, "record.md"); await writeFile(activity, "authored record\n");
    await age(activity, 8 * 24); check(1);
    await age(activity, 1); check(0, /no trace on record/);
    const stamp = join(seat, ".last-trace"); await writeFile(stamp, "preserve stamp contents\n");
    const stamped = run("trace-stamp", [seat]); assert.equal(stamped.status, 0, stamped.stderr); assert.match(stamped.stdout, /^stamped:/);
    assert.equal(await readFile(stamp, "utf8"), "preserve stamp contents\n"); check(1);
    await age(stamp, 2); check(1);
    assert.equal(run("trace-due", [seat], { TRACE_MIN_HOURS: "1" }).status, 0);
    await age(stamp, 7); check(0, /new activity/);
    await age(activity, 8 * 24); check(1);
    const workFile = join(work, "new work.md"); await writeFile(workFile, "new work\n");
    check(0, /new activity/, [work]);
    await age(workFile, 8 * 24); await age(stamp, 73); check(0, /force threshold 72h/);
    assert.equal(await readFile(activity, "utf8"), "authored record\n");
  } finally {
    assert.equal(root.startsWith(join(tmpdir(), "openrig trace-")), true);
    await rm(root, { recursive: true });
  }
});

test("native trace activity does not follow a directory symlink or Windows junction", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig trace-link-"));
  try {
    const seat = join(root, "seat"), target = join(root, "separate-work");
    await mkdir(seat); await mkdir(target); await writeFile(join(target, "recent.md"), "recent");
    await symlink(target, join(seat, "shortcut"), process.platform === "win32" ? "junction" : "dir");
    const throughLink = run("trace-due", [seat]); assert.equal(throughLink.status, 1); assert.equal(throughLink.stdout, "");
    assert.equal(run("trace-due", [seat, target]).status, 0);
  } finally { await rm(root, { recursive: true }); }
});

test("native trace commands reject missing/invalid input without creating seat directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig trace-invalid-"));
  try {
    const absent = join(root, "absent");
    for (const name of ["trace-due", "trace-stamp"]) assert.equal(run(name, []).status, 2);
    assert.notEqual(run("trace-stamp", [absent]).status, 0);
    assert.notEqual(run("trace-due", [absent], { TRACE_MIN_HOURS: "bad" }).status, 0);
    await assert.rejects(stat(absent), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true }); }
});
