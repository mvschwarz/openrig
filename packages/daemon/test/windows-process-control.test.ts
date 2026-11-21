import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe.skipIf(process.platform !== "win32")("Windows process termination", () => {
  it("terminates only the addressed owned child and leaves its sibling alive", async () => {
    const children = [0, 1].map(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore", windowsHide: true,
    }));
    try {
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve); child.once("error", reject);
      })));
      const target = children[0]!;
      const exited = new Promise<void>(resolve => target.once("exit", () => resolve()));
      const adapter = new TmuxAdapter(async command => (await promisify(exec)(command, { windowsHide: true })).stdout,
        undefined, undefined, "psmux");
      expect(await adapter.signalPid(target.pid!, "KILL")).toEqual({ ok: true });
      await exited;
      expect(children[1]!.exitCode).toBeNull();
      expect(process.kill(children[1]!.pid!, 0)).toBe(true);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }, 15000);
});

describe.skipIf(process.platform !== 'win32')('native launcher subtree termination', () => {
  it('terminates the addressed launcher and native child while preserving an independent sibling', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openrig-stop-tree-'));
    const ready = path.join(root, 'ready.json');
    const stop = path.join(root, 'stop');
    const childCode = 'const fs=require("node:fs");setInterval(()=>{if(fs.existsSync(' + JSON.stringify(stop) + '))process.exit(0)},50)';
    const parentCode = 'const fs=require("node:fs");const child=require("node:child_process").spawn(process.execPath,["-e",' + JSON.stringify(childCode) + '],{stdio:"ignore",windowsHide:true});child.once("spawn",()=>fs.writeFileSync(' + JSON.stringify(ready) + ',JSON.stringify({pid:process.pid,child:child.pid})));setInterval(()=>{if(fs.existsSync(' + JSON.stringify(stop) + ')){child.kill();process.exit(0)}},50)';
    const target = spawn(process.execPath, ['-e', parentCode], { stdio: 'ignore', windowsHide: true });
    const sibling = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore', windowsHide: true });
    let nativePid: number | undefined;
    const pause = () => new Promise(resolve => setTimeout(resolve, 25));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await Promise.all([target, sibling].map(child => new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve); child.once('error', reject);
      })));
      let receipt: { pid: number; child: number } | undefined;
      for (let i = 0; i < 120; i++) {
        try { receipt = JSON.parse(fs.readFileSync(ready, 'utf8')); break; } catch { await pause(); }
      }
      expect(receipt?.pid).toBe(target.pid);
      nativePid = receipt?.child;
      expect(nativePid).toBeGreaterThan(1);
      expect(alive(nativePid!)).toBe(true);
      const exited = new Promise<void>(resolve => target.once('exit', () => resolve()));
      const adapter = new TmuxAdapter(async command => (await promisify(exec)(command, { windowsHide: true })).stdout,
        undefined, undefined, 'psmux');
      expect(await adapter.signalPid(target.pid!, 'KILL')).toEqual({ ok: true });
      await exited;
      for (let i = 0; i < 120 && alive(nativePid!); i++) await pause();
      expect(alive(nativePid!)).toBe(false);
      expect(sibling.exitCode).toBeNull();
      expect(alive(sibling.pid!)).toBe(true);
    } finally {
      // All fixture processes observe this owned marker; no stale PID is killed.
      fs.writeFileSync(stop, 'stop');
      for (let i = 0; i < 160 && (target.exitCode === null || sibling.exitCode === null || (nativePid && alive(nativePid))); i++) await pause();
      if (target.exitCode === null || sibling.exitCode === null || (nativePid && alive(nativePid))) {
        throw new Error('Owned process did not stop; retained fixture at ' + root);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
