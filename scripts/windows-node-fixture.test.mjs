import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeWindowsNodeFixture } from "./windows-node-fixture.mjs";

test("native fixture executable preserves argv, stdio and exit status", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "native fixture 中文 space "));
  try {
    const exe = writeWindowsNodeFixture(root, "receiver", "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input}));process.stderr.write('fixture error');process.exitCode=7;});");
    const args = ["", "space word", 'a"b', "backslash\\", "slash before quote\\\"", "%PATH% & echo", "中文🙂"];
    const input = "fixture input\n中文🙂\n";
    const result = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, input });
    assert.equal(result.status, 7, result.stderr); assert.equal(result.stderr, "fixture error"); assert.deepEqual(JSON.parse(result.stdout), { args, input });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
