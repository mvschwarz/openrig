import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { piSeatPaths, PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";

// Real runner and offline children: no installed provider, account or model call.
describe.skipIf(process.platform === "win32")("Pi native PATH semantics", () => {
  it.each(["argv0", "fallback", "mise", "relative", "empty", "stubborn-version"])(
    "preserves Pi lookup (%s)", async kind => {
      const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-")));
      const first = path.join(temp, "first"), second = path.join(temp, "second");
      fs.mkdirSync(first); fs.mkdirSync(second);
      const session = path.join(temp, "session.jsonl");
      fs.writeFileSync(session, "fixture\n");
      const good = path.join(second, "pi");
      fs.writeFileSync(good, `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line); if(c.type==='get_state') console.log(JSON.stringify({type:'response',id:c.id,success:true,
data:{sessionFile:${JSON.stringify(session)},sessionId:'offline'}}));});
`, { mode: 0o700 });
      const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
      if (kind === "argv0" || kind === "mise") {
        const shim = path.join(temp, kind === "mise" ? "mise" : "multiplexer");
        fs.writeFileSync(shim, `#!/bin/sh
${kind === "mise" ? `if [ "$1" = which ]; then printf '%s\\n' ${quote(good)}; exit 0; fi` : ""}
if [ "\${0##*/}" != pi ]; then
  # Consume the first request so an EPIPE cannot mask the dispatch failure.
  IFS= read -r request || :
  printf '%s\\n' 'SHIM_DISPATCH_NAME_MISMATCH' >&2
  exit 7
fi
[ "$PWD" = ${quote(temp)} ] || exit 8
exec ${quote(process.execPath)} ${quote(good)}
`, { mode: 0o700 });
        fs.symlinkSync(shim, path.join(first, "pi"));
      } else if (kind === "fallback") {
        fs.writeFileSync(path.join(first, "pi"), "#!/no/such/interpreter\n", { mode: 0o700 });
      } else if (kind === "stubborn-version") {
        fs.writeFileSync(path.join(first, "pi"), `#!${process.execPath}
if(process.argv.includes('--version')) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else { process.stdin.resume(); console.error('Error: Unknown options: --name, --no-approve'); setTimeout(()=>process.exit(1),100); }
`, { mode: 0o700 });
      } else if (kind === "relative") fs.copyFileSync(good, path.join(first, "pi"));
      else fs.copyFileSync(good, path.join(temp, "pi"));
      const stateRoot = path.join(temp, "state");
      const searchPath = kind === "relative" ? "first" : kind === "empty" ? ":" : [first, second].join(path.delimiter);
      const started = Date.now();
      const child = spawn(process.execPath, ["--import", "tsx",
        fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
        "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
        "--launch-id", "path-attempt", "--no-approve"], {
        env: { PATH: searchPath, HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
        detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", ready = false, timedOut = false;
      const stop = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
      child.stdin.on("error", () => {});
      const take = (d: Buffer) => {
        output += d.toString();
        if (!ready && output.includes(PI_RUNNER_READY_MARKER)) { ready = true; stop(); }
      };
      child.stdout.on("data", take); child.stderr.on("data", take);
      const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
      const timer = setTimeout(() => { timedOut = true; stop(); }, 6500);
      try {
        await closed;
        const elapsedMs = Date.now() - started;
        const state = JSON.parse(fs.readFileSync(piSeatPaths(stateRoot, "fixture").runnerStatePath, "utf8"));
        console.log("PI_LOOKUP_PROBE " + JSON.stringify({ kind, elapsedMs, ready, timedOut, exit: child.exitCode, state }));
        expect(timedOut, output).toBe(false);
        if (kind === "stubborn-version") {
          expect(ready).toBe(false);
          expect(elapsedMs).toBeGreaterThanOrEqual(2900);
          expect(elapsedMs).toBeLessThan(6500);
          expect(child.exitCode, output).toBe(1);
          expect(state.exited.code).toBe(1);
          expect(output).toContain("unknown version");
        } else expect(ready, output).toBe(true);
      } finally {
        clearTimeout(timer); stop();
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }, 12000);
});
