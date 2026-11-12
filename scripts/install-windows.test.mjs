import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const installer = fileURLToPath(new URL("./install-windows.mjs", import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-native-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix 中文 & %literal%"), log = path.join(root, "commands.jsonl"), npm = path.join(root, "npm-cli.js");
  const record = `const fs=require('node:fs');fs.appendFileSync(process.env.OWNED_INSTALL_LOG,JSON.stringify({kind:KIND,args:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')})+'\\n');`;
  const entry = `const KIND='rig';${record}const plan=process.argv.includes('--dry-run');if(process.env.OWNED_FAIL===(plan?'plan':'setup')){console.error('Some steps need attention: owned fixture');process.exit(Number(process.env.OWNED_STATUS));}`;
  const checker = `const KIND='abi';${record}if(process.env.OWNED_FAIL==='abi')process.exit(Number(process.env.OWNED_STATUS));`;
  fs.writeFileSync(npm, `const KIND='npm';${record}
const path=require('node:path'),a=process.argv.slice(2),prefix=process.env.OWNED_INSTALL_PREFIX;
if(a[0]==='--version')console.log('owned npm');
else if(a[0]==='prefix')console.log(prefix);
else if(a[0]==='root')console.log(process.env.OWNED_OUTSIDE_ROOT||path.join(prefix,'node_modules'));
else if(a[0]==='install'){
 if(process.env.OWNED_FAIL==='install')process.exit(Number(process.env.OWNED_STATUS));
 const pkg=path.join(prefix,'node_modules/@openrig/cli');fs.mkdirSync(path.join(pkg,'dist'),{recursive:true});fs.mkdirSync(path.join(pkg,'scripts'));
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@openrig/cli',bin:{rig:'dist/entry.cjs'}}));
 fs.writeFileSync(path.join(pkg,'dist/entry.cjs'),${JSON.stringify(entry)});
 if(!process.env.OWNED_SKIP_ABI)fs.writeFileSync(path.join(pkg,'scripts/check-abi.mjs'),${JSON.stringify(checker.replace("const fs=require('node:fs');", "import fs from 'node:fs';"))});
 fs.writeFileSync(path.join(prefix,'rig.cmd'),'@echo off\\r\\nexit /b 98\\r\\n');
}else process.exit(99);`);
  const env = { ...process.env, HOME: root, USERPROFILE: root, npm_execpath: npm, PATH: "",
    OWNED_INSTALL_PREFIX: prefix, OWNED_INSTALL_LOG: log };
  return { root, prefix, log,
    run(args = [], extra = {}, entryPath = installer) { return spawnSync(process.execPath, [entryPath, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 15000, windowsHide: true }); },
    rows() { return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : []; },
  };
}
test("Windows installer preview executes nothing and retains literal package text", t => {
  const f = fixture(t), spec = "owned release & %tag%.tgz", result = f.run(["--dry-run", "--package", spec]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /no commands executed/);
  assert.ok(result.stdout.includes(spec)); assert.deepEqual(f.rows(), []); assert.equal(fs.existsSync(f.prefix), false);
});
test("invalid arguments execute nothing", t => {
  const f = fixture(t);
  for (const args of [["--unknown"], ["--package"], ["--package", "--prefix"], ["--dry-run", "--dry-run"]]) assert.equal(f.run(args).status, 2);
  assert.deepEqual(f.rows(), []);
});
test("directory alias executes the preview and importing stays inert", t => {
  const f = fixture(t), home = path.join(f.root, "home"), alias = path.join(f.root, "alias");
  fs.mkdirSync(home); fs.copyFileSync(installer, path.join(home, "install.mjs")); fs.symlinkSync(home, alias, "junction");
  const result = f.run(["--dry-run"], {}, path.join(alias, "install.mjs"));
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Experimental native Windows install plan/);
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(installer).href)})`], { cwd: f.root, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, ""); assert.deepEqual(f.rows(), []);
});
const native = { skip: process.platform !== "win32" };
test("installs through npm's Node entry and uses the installed CLI without executing rig.cmd", native, t => {
  const f = fixture(t), spec = path.join(f.root, "release & %literal%.tgz"), result = f.run(["--package", spec]);
  assert.equal(result.status, 0, result.stderr);
  const rows = f.rows();
  assert.deepEqual(rows.map(row => row.kind), ["npm", "npm", "npm", "npm", "abi", "rig", "rig"]);
  assert.deepEqual(rows[1].args, ["install", "-g", "--", spec]);
  assert.deepEqual(rows.slice(-2).map(row => row.args), [["setup", "--dry-run"], ["setup"]]);
  assert.ok(rows.every(row => row.stdin === "")); assert.match(result.stdout, /compatibility check passed/);
});
for (const [stage, status, label] of [["install", 73, "2/4"], ["abi", 74, "2/4"], ["plan", 75, "3/4"]]) {
  test(`preserves ${stage} failure and stops before later stages`, native, t => {
    const f = fixture(t), result = f.run([], { OWNED_FAIL: stage, OWNED_STATUS: String(status) });
    assert.equal(result.status, status, result.stderr); assert.ok(result.stderr.includes(`FAILED [${label}]`));
    assert.equal(f.rows().some(row => row.kind === "rig" && !row.args.includes("--dry-run")), false);
  });
}
test("reports installed but incomplete setup without inventing an authentication cause", native, t => {
  const f = fixture(t), result = f.run([], { OWNED_FAIL: "setup", OWNED_STATUS: "76" });
  assert.equal(result.status, 76); assert.match(result.stderr, /INSTALLED, SETUP NOT COMPLETE/);
  assert.match(result.stderr, /compatibility check: passed/); assert.match(result.stderr, /reinstalling is not required/);
});
test("missing ABI checker stays explicitly skipped in the incomplete summary", native, t => {
  const f = fixture(t), result = f.run([], { OWNED_SKIP_ABI: "1", OWNED_FAIL: "setup", OWNED_STATUS: "77" });
  assert.equal(result.status, 77); assert.match(result.stderr, /SKIPPED \(not checked/);
  assert.equal(f.rows().some(row => row.kind === "abi"), false);
});
test("refuses a global root outside the selected prefix before executing an installed entry", native, t => {
  const f = fixture(t), outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  const result = f.run([], { OWNED_OUTSIDE_ROOT: outside });
  assert.equal(result.status, 1); assert.match(result.stderr, /outside the selected installation prefix/);
  assert.equal(f.rows().some(row => row.kind !== "npm"), false);
});
