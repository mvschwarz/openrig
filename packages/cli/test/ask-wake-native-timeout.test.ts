import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultWakeRunner } from "../src/ask-wake.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
it.runIf(process.platform === "win32")("bounds a wake whose root exits while its descendant holds stdout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-native-holder-"));
  const log = path.join(root, "pid.json"), script = path.join(root, "probe.cjs");
  fs.writeFileSync(script, `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
require('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(child.pid));
process.stdout.write('owned answer',()=>process.exit(0));`);
  let pid: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const running = defaultWakeRunner(process.execPath, [script], { timeoutMs: 1000 });
  try {
    const result = await Promise.race([running, new Promise<undefined>(resolve => { timer = setTimeout(resolve, 4000); })]);
    pid = JSON.parse(fs.readFileSync(log, "utf8"));
    expect(result, "wake must not wait indefinitely on an owned descendant's pipe").toBeDefined();
    const until = Date.now() + 2000;
    while (alive(pid!) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    expect(alive(pid!)).toBe(false);
  } finally {
    clearTimeout(timer);
    if (pid === undefined && fs.existsSync(log)) pid = JSON.parse(fs.readFileSync(log, "utf8"));
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    await running;
    const until = Date.now() + 2000;
    while (pid !== undefined && alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    if (pid === undefined || !alive(pid)) fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it.runIf(process.platform === "win32")("ends an owned wake descendant when the wake times out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-native-timeout-"));
  const log = path.join(root, "pids.json"), script = path.join(root, "probe.cjs");
  fs.writeFileSync(script, `const cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
require('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`);
  let pids: number[] = [];
  try {
    const result = await defaultWakeRunner(process.execPath, [script], { timeoutMs: 1500 });
    pids = JSON.parse(fs.readFileSync(log, "utf8"));
    expect(result.timedOut).toBe(true);
    const until = Date.now() + 2000;
    while (pids.some(alive) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    expect(pids.filter(alive)).toEqual([]);
  } finally {
    if (!pids.length && fs.existsSync(log)) pids = JSON.parse(fs.readFileSync(log, "utf8"));
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    const until = Date.now() + 2000;
    while (pids.some(alive) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    if (pids.every(pid => !alive(pid))) fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
