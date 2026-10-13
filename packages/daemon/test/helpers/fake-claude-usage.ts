// Slice 01 — a fake `claude` executable for the identity reader. `auth status --json` answers from
// `$CLAUDE_CONFIG_DIR/fake-plan.json` (one answer per call, the last repeating), following Claude's documented
// contract: exit 0 when logged in, 1 when not (still printing {"loggedIn": false, ...}). Any other start is logged
// to `other-starts.log` and exits 2: the reader must never start anything else. A `stubborn` plan makes each start
// ignore HUP and TERM and leave a child in its process group that ignores them too, logging both pids and the
// group to `procs.log`, so tests can check that nothing a read started survives it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FakeClaudePlan {
  /** One `auth status` answer per call (the last repeats); `null` means exit 1 with no output; "hang" never answers. */
  auth: Array<Record<string, unknown> | null | "hang">;
  /** The exit code after each answer is printed (the last repeats). Default: Claude's contract, 1 for a
   *  `loggedIn: false` answer and 0 otherwise. */
  authExit?: number[];
  stubborn?: boolean;
}

const SCRIPT = (node: string) => `#!${node}
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.CLAUDE_CONFIG_DIR;
const plan = JSON.parse(fs.readFileSync(path.join(dir, "fake-plan.json"), "utf8"));
const args = process.argv.slice(2);
if (plan.stubborn) {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  const { spawn, execFileSync } = require("node:child_process");
  const ready = path.join(dir, "child-ready-" + process.pid);
  const child = spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(process.argv[1],'');setInterval(()=>{},1000)", ready],
    { stdio: "ignore" });
  child.unref();
  // Only once the child ignores HUP and TERM, so a quick exit can't take it down first.
  const until = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim());
  fs.appendFileSync(path.join(dir, "procs.log"), JSON.stringify({ pids: [process.pid, child.pid], pgid }) + "\\n");
}
if (args[0] === "auth" && args[1] === "status") {
  const countFile = path.join(dir, "auth-calls");
  const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(n + 1));
  fs.appendFileSync(path.join(dir, "auth-env.log"), JSON.stringify({ argv: args,
    env: { TMUX: process.env.TMUX ?? null, TMUX_PANE: process.env.TMUX_PANE ?? null, OPENRIG_SESSION_NAME: process.env.OPENRIG_SESSION_NAME ?? null,
      CLAUDECODE: process.env.CLAUDECODE ?? null, cwd: process.cwd() } }) + "\\n");
  const answer = plan.auth[Math.min(n, plan.auth.length - 1)];
  if (answer === null) process.exit(1);
  if (answer === "hang") setInterval(() => {}, 1000);
  else process.stdout.write(JSON.stringify(answer), () => {
    const exits = plan.authExit ?? [answer.loggedIn === false ? 1 : 0];
    process.exit(exits[Math.min(n, exits.length - 1)]);
  });
} else {
  fs.appendFileSync(path.join(dir, "other-starts.log"), JSON.stringify(args) + "\\n");
  process.exit(2);
}
`;

export interface FakeClaude {
  binDir: string;
  configDir: string;
  setPlan(plan: FakeClaudePlan): void;
  authCalls(): number;
  /** The argv and environment each auth status start saw. */
  authStarts(): Array<{ argv: string[]; env: Record<string, string | null> }>;
  /** Any start other than `auth status` (there must be none). */
  otherStarts(): string[][];
  /** The processes stubborn starts left: pids and their process group. */
  procs(): Array<{ pids: number[]; pgid: number }>;
}

export function makeFakeClaude(): FakeClaude {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-usage-"));
  const binDir = path.join(root, "bin");
  const configDir = path.join(root, "claude-config");
  fs.mkdirSync(binDir);
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(binDir, "claude"), SCRIPT(process.execPath), { mode: 0o755 });
  const read = (name: string) => { try { return fs.readFileSync(path.join(configDir, name), "utf8"); } catch { return ""; } };
  const lines = (name: string) => read(name).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return {
    binDir,
    configDir,
    setPlan: (plan) => {
      fs.writeFileSync(path.join(configDir, "fake-plan.json"), JSON.stringify(plan));
      for (const f of ["auth-calls", "procs.log"]) fs.rmSync(path.join(configDir, f), { force: true });
    },
    authCalls: () => Number(read("auth-calls") || 0),
    authStarts: () => lines("auth-env.log"),
    otherStarts: () => lines("other-starts.log"),
    procs: () => lines("procs.log"),
  };
}

export const CLAUDE_AUTH = {
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "d***@example.test", orgId: "org-1", orgName: "Example Org", subscriptionType: "team",
};
/** Claude's logged-out answer (printed with exit 1). */
export const CLAUDE_LOGGED_OUT = { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
