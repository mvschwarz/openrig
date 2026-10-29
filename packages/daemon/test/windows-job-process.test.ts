import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawnWindowsJobProcess } from "../src/domain/windows-job-process.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
describe.skipIf(process.platform !== "win32")("native background Job containment", () => {
  it("rejects NUL arguments before creating a helper", () => {
    expect(() => spawnWindowsJobProcess(process.execPath, ["bad\0argument"], {})).toThrow("NUL");
  });
  it("ends its helper and descendants if the owning Node process exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-job-owner-exit-"));
    try {
      const receipt = path.join(root, "pids.json"), helperReceipt = path.join(root, "helper.json");
      const module = fileURLToPath(new URL("../src/domain/windows-job-process.ts", import.meta.url));
      const script = `
        const {spawnWindowsJobProcess}=await import(require('url').pathToFileURL(process.argv[1]).href);
        const fs=require('fs');
        const code="const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)";
        const helper=spawnWindowsJobProcess(process.execPath,['-e',code,process.argv[2]],{stdio:'ignore'});
        const until=Date.now()+10000;
        while(!fs.existsSync(process.argv[2])) { if(Date.now()>until)process.exit(9); await new Promise(r=>setTimeout(r,20)); }
        fs.writeFileSync(process.argv[3],JSON.stringify(helper.pid));process.exit(0);
      `;
      const parent = spawn(process.execPath, ["--import", "tsx", "-e", `(async()=>{${script}})()`, module, receipt, helperReceipt], { stdio: ["ignore", "pipe", "pipe"] });
      let err = ""; parent.stderr!.on("data", chunk => { err += chunk; });
      expect(await new Promise(resolve => parent.once("close", resolve)), err).toBe(0);
      const pids = [...JSON.parse(await readFile(receipt, "utf8")), JSON.parse(await readFile(helperReceipt, "utf8"))];
      await expect.poll(() => pids.every(pid => !alive(pid)), { timeout: 2000 }).toBe(true);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 20000);
  it("preserves an explicit minimal environment without leaking helper variables", async () => {
    const env = { PATH: path.dirname(process.execPath), HOME: os.tmpdir(), USERPROFILE: os.tmpdir(), KEEP: "Unicode 日本語\nline", PSModulePath: "fixture-module-path" };
    const child = spawnWindowsJobProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    child.stdout!.on("data", chunk => { out += chunk; }); child.stderr!.on("data", chunk => { err += chunk; });
    const exit = await new Promise(resolve => child.once("close", resolve));
    expect(exit, err).toBe(0);
    const direct = await promisify(execFile)(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { env });
    expect(JSON.parse(out)).toEqual(JSON.parse(direct.stdout));
  }, 15000);
  it("keeps literal argv/stdio/exit status and ends a closed-stdio orphan after root exit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-job-test-"));
    try {
      const receipt = path.join(root, "child.json");
      const args = ['space value', '"quotes"', 'C:\\tail\\', '& echo unsafe', '%PATH%', '日本語🙂', 'line\nbreak'];
      const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],JSON.stringify({pid:c.pid}));console.log(JSON.stringify(process.argv.slice(2)));console.error('fixture-stderr');process.exit(7)";
      const child = spawnWindowsJobProcess(process.execPath, ["-e", code, receipt, ...args], { stdio: "pipe", cwd: root, detached: true });
      let out = "", err = "";
      child.stdout!.setEncoding("utf8").on("data", chunk => { out += chunk; });
      child.stderr!.setEncoding("utf8").on("data", chunk => { err += chunk; });
      const exit = await new Promise(resolve => child.once("close", resolve));
      expect(exit, err).toBe(7);
      expect(JSON.parse(out)).toEqual(args);
      expect(err.trim()).toBe("fixture-stderr");
      const { pid } = JSON.parse(await readFile(receipt, "utf8"));
      await expect.poll(() => alive(pid), { timeout: 2000 }).toBe(false);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 15000);
  it("closes the whole job if the helper is killed, without touching an unrelated process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-job-kill-"));
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const receipt = path.join(root, "pids.json");
      const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],JSON.stringify({root:process.pid,child:c.pid}));setInterval(()=>{},1000)";
      child = spawnWindowsJobProcess(process.execPath, ["-e", script, receipt], { stdio: "pipe", cwd: root });
      let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
      await expect.poll(async () => { try { return JSON.parse(await readFile(receipt, "utf8")); } catch { return null; } }, { timeout: 10000 }).not.toBeNull();
      const pids = JSON.parse(await readFile(receipt, "utf8"));
      const closed = new Promise(resolve => child!.once("close", resolve));
      child.kill("SIGKILL"); await closed;
      await expect.poll(() => [alive(pids.root), alive(pids.child)], { timeout: 2000 }).toEqual([false, false]);
      expect(alive(unrelated.pid!), stderr).toBe(true);
    } finally {
      child?.kill("SIGKILL"); unrelated.kill("SIGKILL");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15000);
});
