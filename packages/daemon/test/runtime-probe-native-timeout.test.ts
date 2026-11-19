import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { execRuntimeProbe } from "../src/adapters/runtime-probe-exec.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
it.runIf(process.platform === "win32")("retains native probe cwd, environment and stdin EOF", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-native-options-"));
  const script = path.join(root, "probe.cjs");
  fs.writeFileSync(script, "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({cwd:process.cwd(),value:process.env.OPENRIG_OWNED_PROBE}))); ");
  try {
    const output = await execRuntimeProbe("test.native-options", `"${process.execPath}" "${script}"`,
      { cwd: root, env: { ...process.env, OPENRIG_OWNED_PROBE: "owned Ω & ' value" }, timeoutMs: 5000 });
    const result = JSON.parse(output);
    expect(fs.realpathSync.native(result.cwd)).toBe(fs.realpathSync.native(root));
    expect(result.value).toBe("owned Ω & ' value");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("retains a native probe's failure code and stderr", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-native-failure-"));
  const script = path.join(root, "probe.cjs");
  fs.writeFileSync(script, "process.stderr.write('owned profile failure',()=>process.exit(7));");
  try {
    const error = await execRuntimeProbe("test.native-failure", `"${process.execPath}" "${script}"`, { timeoutMs: 5000 }).catch(error => error);
    expect(error).toMatchObject({ code: 7, stderr: "owned profile failure" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("ends an owned native runtime probe and its descendant at the deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-native-timeout-"));
  const log = path.join(root, "pids.json"), script = path.join(root, "probe.cjs");
  fs.writeFileSync(script, `const cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
require('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`);
  let pids: number[] = [];
  try {
    const error = await execRuntimeProbe("test.native-timeout", `"${process.execPath}" "${script}"`, { timeoutMs: 1000 }).catch(error => error);
    pids = JSON.parse(fs.readFileSync(log, "utf8"));
    expect(error).toMatchObject({ code: "ETIMEDOUT" });
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
