import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeWindowsInstall } from "../src/domain/windows-install-exec.js";

it.runIf(process.platform === "win32")("installer timeout ends its owned tree and preserves an unrelated child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-job-"));
  const receipt = path.join(root, "pids.json");
  const unrelated = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const closed = once(unrelated, "close");
  let pids: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)";
    await expect(executeWindowsInstall(process.execPath, ["-e", script, receipt], 3000)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    pids = JSON.parse(fs.readFileSync(receipt, "utf8"));
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await expect.poll(() => pids.some(alive), { timeout: 3000 }).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  } finally {
    unrelated.stdin.end(); await closed;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
