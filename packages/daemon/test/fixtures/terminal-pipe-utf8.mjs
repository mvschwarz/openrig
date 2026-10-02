import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const [home, sourceRoot] = process.argv.slice(2);
const moduleRoot = sourceRoot ? join(sourceRoot, "packages/daemon/src") : fileURLToPath(new URL("../../dist/", import.meta.url));
const load = name => import(pathToFileURL(join(moduleRoot, name + (sourceRoot ? ".ts" : ".js"))));
const { TmuxAdapter } = await load("adapters/tmux");
const { TerminalSessionBroker } = await load("terminal/TerminalSessionBroker");
const execute = promisify(execFile);
const socket = join(home, "tmux.sock");
const native = async args => (await execute("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout;
const wait = async check => { const deadline = Date.now() + 5000; while (!check()) {
  assert.ok(Date.now() < deadline, "native output timed out"); await new Promise(resolve => setTimeout(resolve, 10));
} };
const writer = join(home, "writer.cjs"), first = join(home, "first"), second = join(home, "second");
writeFileSync(writer, `const fs=require('node:fs'); const bytes=Buffer.from('🚀'); let stage=0;
setInterval(()=>{ if(stage===0 && fs.existsSync(${JSON.stringify(first)})) {
process.stdout.write(Buffer.concat([Buffer.from('UTF8_START:'),bytes.subarray(0,2)])); stage=1;
} else if(stage===1 && fs.existsSync(${JSON.stringify(second)})) {
process.stdout.write(Buffer.concat([bytes.subarray(2),Buffer.from(' café 中文 :UTF8_END')])); stage=2;
} },10);`);
let broker;
try {
  await native(["new-session", "-d", "-s", "unicode@fixture", `${JSON.stringify(process.execPath)} ${JSON.stringify(writer)}`]);
  const tmux = new TmuxAdapter(async () => { throw Error("unused shell"); }, undefined, args => native(args.slice(1)));
  broker = new TerminalSessionBroker("unicode@fixture", tmux, { pollMs: 5, livenessMs: 10000 });
  const chunks = [], closes = [];
  await broker.attach({ send: data => chunks.push(data), close: (...args) => closes.push(args) });
  chunks.length = 0;
  writeFileSync(first, "ready");
  await wait(() => chunks.join("").includes("UTF8_START:"));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(existsSync(broker.pipeOutputPath));
  writeFileSync(second, "ready");
  await wait(() => chunks.join("").includes("UTF8_END"));
  const expected = "UTF8_START:🚀 café 中文 :UTF8_END";
  assert.equal(readFileSync(broker.pipeOutputPath).toString("utf8"), expected, "native pipe contains intact UTF-8");
  assert.equal(chunks.join(""), expected, "subscriber sees the same native UTF-8 bytes across separate polls");
  assert.deepEqual(closes, []);
  const late = [];
  await broker.attach({ send: data => late.push(data), close: () => {} });
  assert.equal(late[0], expected, "late subscriber history is also intact");
  console.log(JSON.stringify({ nativeTmux: true, splitFourByteCharacter: true, liveAndLateSubscribers: true }));
} finally { broker?.dispose(); await native(["kill-server"]).catch(() => {}); }
