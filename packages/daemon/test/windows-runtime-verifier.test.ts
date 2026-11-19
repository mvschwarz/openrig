import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { boundedProbeExec } from "../src/adapters/bounded-probe-exec.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

describe.skipIf(process.platform !== "win32")("Windows RuntimeVerifier bounded CLI integration", () => {
  it.each([
    { version: "ok", help: "ok", status: "verified", parsed: "1.2.3", args: ["--version"] },
    { version: "fail", help: "ok", status: "verified", parsed: null, args: ["--version", "--help"] },
    { version: "hang", help: "ok", status: "error", parsed: null, args: ["--version"] },
    { version: "fail", help: "hang", status: "error", parsed: null, args: ["--version", "--help"] },
  ])("version=$version help=$help records $status", async (scenario) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig native verifier "));
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const log = path.join(root, "starts.jsonl");
      const script = path.join(root, "fixture.cjs");
      await writeFile(script, `const fs=require('node:fs');
const arg=process.argv[2];
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({arg,pid:process.pid})+'\\n');
const mode=arg==='--version'?${JSON.stringify(scenario.version)}:${JSON.stringify(scenario.help)};
if(mode==='hang')setInterval(()=>{},1000);
else if(mode==='fail'){console.error('owned probe failure');process.exitCode=3;}
else console.log(arg==='--version'?'codex-cli 1.2.3':'Usage: owned codex');
`);
      // This is an owned cmd fixture for the bounded shell probe, not an npm shim.
      await writeFile(path.join(root, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH" || key.toUpperCase() === "PATHEXT") delete env[key];
      env.PATH = root;
      env.PATHEXT = ".CMD";
      const probeExec = boundedProbeExec(2500, 250, { env, cwd: () => root });
      const exec = vi.fn(async () => { throw Error("ordinary exec must not run version/help probes"); });
      const started = performance.now();
      const result = await new RuntimeVerifier({ db, exec, probeExec }).verifyCodex();
      expect(result).toMatchObject({ runtime: "codex", status: scenario.status, version: scenario.parsed });
      expect(exec).not.toHaveBeenCalled();
      const starts: Array<{ arg: string; pid: number }> = (await readFile(log, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(starts.map(row => row.arg)).toEqual(scenario.args);
      expect(db.prepare("SELECT status, version FROM runtime_verifications WHERE runtime = 'codex'").get())
        .toEqual({ status: scenario.status, version: scenario.parsed });
      if (scenario.status === "error") {
        expect(result.error).toContain(`codex ${scenario.args.at(-1)} did not answer within`);
        expect(performance.now() - started).toBeLessThan(9000);
      } else expect(result.error).toBeNull();
      await expect.poll(() => starts.every(({ pid }) => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }), { timeout: 2000 }).toBe(true);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15000);

  it("closes native probe stdin and drains large output without truncating it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig native probe io "));
    try {
      const script = path.join(root, "stdin output.cjs");
      await writeFile(script, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('eof:'+'x'.repeat(300000)))");
      const result = await boundedProbeExec(5000)(`"${process.execPath}" "${script}"`);
      expect(result).toBe("eof:" + "x".repeat(300000));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15000);
});
