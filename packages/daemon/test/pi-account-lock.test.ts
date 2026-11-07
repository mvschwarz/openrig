import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { preparePiAccount } from "../src/adapters/pi-runner.js";

const require = createRequire(import.meta.url);
const lockModule = require.resolve("proper-lockfile");
const lockfile = require("proper-lockfile");
const shim = path.resolve(import.meta.dirname, "../assets/pi-account-lock.cjs");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it.each([false, true])("Pi's realpath:false lock across account aliases (shim: %s)", async useShim => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-lock-"))); roots.push(root);
  const account = path.join(root, "account"), a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(account); const source = path.join(account, "auth.json");
  fs.writeFileSync(source, "{}"); preparePiAccount(a, account); preparePiAccount(b, account);
  const env = (agentDir: string) => ({ ...process.env, NODE_OPTIONS: useShim ? `--require=${JSON.stringify(shim)}` : "", PI_CODING_AGENT_DIR: agentDir });
  const child = spawn(process.execPath, ["-e", `
    const fs = require('node:fs'), lock = require(${JSON.stringify(lockModule)});
    const auth = ${JSON.stringify(path.join(a, "auth.json"))};
    const release = lock.lockSync(auth, {realpath:false});
    fs.writeFileSync(auth, JSON.stringify({first:'refreshed'}));
    process.send('locked');
    process.on('message', () => { release(); process.disconnect(); });
  `], { env: env(a), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("lock holder exited early"); })]);
    const probe = execFileSync(process.execPath, ["-e", `
      const lock = require(${JSON.stringify(lockModule)});
      (async () => {
        try { const release = await lock.lock(${JSON.stringify(path.join(b, "auth.json"))}, {realpath:false}); await release(); console.log('acquired'); }
        catch (e) { if(e.code !== 'ELOCKED') throw e; console.log('blocked'); }
      })().catch(e=>{console.error(e);process.exitCode=1});
    `], { env: env(b), encoding: "utf8" });
    expect(probe.trim()).toBe(useShim ? "blocked" : "acquired");
    // Native direct use of the chosen account contends with the same lock too.
    if (useShim) expect(() => lockfile.lockSync(source, { realpath: false })).toThrow(/already being held/);
    else lockfile.lockSync(source, { realpath: false })();
    const exited = once(child, "exit"); child.send("release"); await exited;
    execFileSync(process.execPath, ["-e", `
      const fs = require('node:fs'), lock = require(${JSON.stringify(lockModule)});
      const auth = ${JSON.stringify(path.join(b, "auth.json"))};
      const release = lock.lockSync(auth, {realpath:false});
      const state = JSON.parse(fs.readFileSync(auth)); state.second = 'refreshed';
      fs.writeFileSync(auth, JSON.stringify(state)); release();
    `], { env: env(b) });
    expect(JSON.parse(fs.readFileSync(source, "utf8"))).toEqual({ first: "refreshed", second: "refreshed" });
    expect(fs.existsSync(source + ".lock")).toBe(false);
    expect(fs.existsSync(path.join(a, "auth.json.lock"))).toBe(false);
    expect(fs.existsSync(path.join(b, "auth.json.lock"))).toBe(false);
  } finally { child.kill(); }
}, 10000);
