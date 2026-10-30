import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { boundedProbeExec, ProbeTimeoutError } from "../src/adapters/bounded-probe-exec.js";

describe.skipIf(process.platform !== "win32")("Windows bounded shell probe containment", () => {
  it("preserves cmd builtins and ends a pipe-holding orphan when the probe exits", async () => {
    expect((await boundedProbeExec(5000)("echo native-probe-builtin")).trim()).toBe("native-probe-builtin");
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-probe-shell-"));
    try {
      const script = path.join(root, "probe script.cjs"), receipt = path.join(root, "pid.json");
      await writeFile(script, "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('fs').writeFileSync(process.argv[2],JSON.stringify({pid:c.pid}));console.log('probe-ready');process.exit(0)");
      const output = await boundedProbeExec(5000)(`"${process.execPath}" "${script}" "${receipt}"`);
      expect(output.trim()).toBe("probe-ready");
      const { pid } = JSON.parse(await readFile(receipt, "utf8"));
      await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 2000 }).toBe(false);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 15000);
  it("bounds an unfinished command with its child tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-probe-deadline-"));
    try {
      const script = path.join(root, "hang.cjs"), receipt = path.join(root, "pids.json");
      await writeFile(script, "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[2],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)");
      await expect(boundedProbeExec(1500, 200)(`"${process.execPath}" "${script}" "${receipt}"`)).rejects.toBeInstanceOf(ProbeTimeoutError);
      const pids: number[] = JSON.parse(await readFile(receipt, "utf8"));
      await expect.poll(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), { timeout: 2000 }).toBe(true);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 15000);
});
