import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { piSeatPaths, parsePiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";

const execAsync = promisify(execFile);
const available = process.platform !== "win32" && (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
})();

// Real compiled runner, RPC child, process observations and private tmux. The daemon acknowledgement is an HTTP fixture.
describe.skipIf(!available)("runner recovery through tmux and live RPC", () => {
  it.each([["pi", false], ["pi", true], ["omp", false], ["omp", true]] as const)("proves %s (managed run: %s), then rejects a child whose RPC stops answering", async (runtime, managedRun) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-recovery-")));
    const socket = path.join(root, "tmux.sock");
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    const sessionFile = path.join(root, "history.jsonl"); fs.writeFileSync(sessionFile, "fixture\n");
    const silent = path.join(root, "silent"), commands = path.join(root, "commands.jsonl");
    fs.writeFileSync(path.join(bin, runtime), `#!${process.execPath}
const fs = require('node:fs');
${runtime === "omp" ? "console.log(JSON.stringify({type:'ready',protocolVersion:1}));" : ""}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(commands)}, line + '\\n');
  if (command.type === 'get_state' && !fs.existsSync(${JSON.stringify(silent)})) console.log(JSON.stringify({
    type:'response', command:'get_state', id:command.id, success:true,
    data:{sessionFile:${JSON.stringify(sessionFile)},sessionId:'offline-session'}
  }));
});
`, { mode: 0o700 });
    const identities: Record<string, unknown>[] = [];
    const runId = managedRun ? "fixture-run" : undefined;
    const daemon = http.createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      const event = JSON.parse(body); identities.push(event);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, tokenPersisted: event.sessionFile === sessionFile && event.runId === runId }));
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
    const db = createFullTestDb();
    const registry = new SessionRegistry(db), rigs = new RigRepository(db);
    const rig = rigs.createRig("recovery-fixture"), node = rigs.addNode(rig.id, "worker", { role: "worker", runtime });
    const name = "worker@recovery-fixture";
    registry.registerSession(node.id, name);
    const entry = fileURLToPath(new URL("../dist/adapters/pi-runner.js", import.meta.url));
    const stateRoot = path.join(root, "state");
    const native = async (args: string[]) => (await execAsync("tmux", ["-S", socket, ...args], { timeout: 10_000 })).stdout.trim();
    const tmux = new TmuxAdapter(async () => { throw new Error("argv expected"); }, undefined,
      async ([file, ...args]) => (await execAsync(file!, args, { timeout: 10_000 })).stdout, ["-S", socket]);
    try {
      expect(fs.existsSync(entry), "Run npm run build before the native runner test").toBe(true);
      const command = [process.execPath, entry, "--session-name", name, "--state-root", stateRoot, "--cwd", root,
        "--launch-id", "native-recovery", ...(runtime === "omp" ? ["--runtime", "omp", "--approval-mode", "always-ask"] : ["--no-approve"])];
      const runnerLog = path.join(root, "runner.log");
      const runnerEnv = [
        `PATH=${bin}${path.delimiter}${process.env.PATH}`, `HOME=${root}`,
        `OPENRIG_HOME=${path.join(root, "home")}`, `OPENRIG_URL=${url}`,
        `OPENRIG_ACTIVITY_HOOK_TOKEN=${managedRun ? "oag_fixture-token" : "fixture-token"}`,
        ...(managedRun ? [`OPENRIG_RUN_ID=${runId}`] : []),
        `OPENRIG_NODE_ID=${node.id}`, "OPENRIG_OCCUPANT_GENERATION=fixture-generation",
      ];
      await native(["-f", "/dev/null", "new-session", "-d", "-s", name, "-e", `HOME=${root}`,
        `exec /usr/bin/env ${[...runnerEnv, ...command].map(shellQuote).join(" ")} > ${shellQuote(runnerLog)} 2>&1`]);
      const file = piSeatPaths(stateRoot, name).runnerStatePath;
      await vi.waitFor(() => expect(parsePiRunnerState(fs.readFileSync(file, "utf8"))).toMatchObject({ ready: true, recovery: { port: expect.any(Number) } }), { timeout: 10_000, interval: 50 })
        .catch(async (error) => { throw new Error(`${error}\n${fs.readFileSync(runnerLog, "utf8")}\n${fs.readFileSync(file, "utf8")}`); });
      registry.updateBinding(node.id, { tmuxSession: name });
      const Adapter = runtime === "pi" ? PiRuntimeAdapter : OmpRuntimeAdapter;
      const adapter = new Adapter({ tmux, stateRoot, runnerEntryPath: entry, fsOps: {
        exists: fs.existsSync, readFile: (file) => fs.readFileSync(file, "utf8"), writeFile: (file, text) => fs.writeFileSync(file, text), mkdirp: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
      } });
      const input = { db, sessionRegistry: registry, tmux, nodeId: node.id, sessionName: name, expectedResumeToken: sessionFile,
        resumeType: `${runtime}_session_file`, rotation: null, assertCurrent: () => true };
      const before = identities.length;
      expect(await adapter.verifyRecovery(input)).toMatchObject({ ok: true, evidence: { fgProcess: runtime, runner: { rpcConfirmed: true, identityConfirmed: true } } });
      expect(identities.slice(before)).toContainEqual(expect.objectContaining({ eventFamily: "session_identity", runtime, sessionFile }));
      if (managedRun) expect(identities.slice(before)).toContainEqual(expect.objectContaining({ eventFamily: "session_identity", runId }));
      fs.writeFileSync(silent, "stop replying");
      expect(await adapter.verifyRecovery(input)).toMatchObject({ ok: false, code: "runner_rpc_unavailable" });
      expect(fs.readFileSync(commands, "utf8").trim().split("\n").map((line) => JSON.parse(line).type)).toEqual(["get_state", "get_state", "get_state"]);
    } finally {
      try { await native(["kill-server"]); } catch { /* private server already exited */ }
      daemon.closeAllConnections(); await new Promise<void>((resolve) => daemon.close(() => resolve()));
      db.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
