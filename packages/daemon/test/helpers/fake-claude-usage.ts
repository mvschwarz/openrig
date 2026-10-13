// Slice 01 — a fake `claude` executable for the usage-screen reader. `auth status --json` answers from
// `$CLAUDE_CONFIG_DIR/fake-plan.json` (one answer per call, the last repeating); any other start is the
// interactive screen: it logs its argv, the environment variables the reader must strip, and every byte it
// receives, renders the planned screen, and exits on the second Ctrl-C. A `stubborn` plan makes every start
// ignore HUP and TERM and leave a child in its process group that ignores them too, logging both pids and
// the group to `procs.log`, so tests can check that nothing a read started survives it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FakeClaudePlan {
  /** One `auth status` answer per call (the last repeats); `null` means exit 1 with no output; "hang" never answers. */
  auth: Array<Record<string, unknown> | null | "hang">;
  /** The exit code after each `auth status` answer is printed (default 0; the last repeats). */
  authExit?: number[];
  stubborn?: boolean;
  /** The screen to render; or "exit" (exit before rendering), "hang" (render nothing). */
  screen: string | "exit" | "hang";
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
  fs.appendFileSync(path.join(dir, "procs.log"), JSON.stringify({ what: args[0] === "auth" ? "auth" : "screen", pids: [process.pid, child.pid], pgid }) + "\\n");
}
if (args[0] === "auth" && args[1] === "status") {
  const countFile = path.join(dir, "auth-calls");
  const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(n + 1));
  const answer = plan.auth[Math.min(n, plan.auth.length - 1)];
  if (answer === null) process.exit(1);
  if (answer === "hang") setInterval(() => {}, 1000);
  else process.stdout.write(JSON.stringify(answer), () => {
    const exits = plan.authExit ?? [0];
    process.exit(exits[Math.min(n, exits.length - 1)]);
  });
} else {
  fs.appendFileSync(path.join(dir, "screen-starts.log"), JSON.stringify({
    argv: args,
    env: { TMUX: process.env.TMUX ?? null, TMUX_PANE: process.env.TMUX_PANE ?? null, OPENRIG_SESSION_NAME: process.env.OPENRIG_SESSION_NAME ?? null,
      CLAUDECODE: process.env.CLAUDECODE ?? null, TZ: process.env.TZ ?? null, cwd: process.cwd() },
  }) + "\\n");
  if (plan.screen === "exit") process.exit(2);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let ctrlC = 0;
  process.stdin.on("data", (chunk) => {
    fs.appendFileSync(path.join(dir, "keys.log"), Buffer.from(chunk).toString("hex"));
    for (const byte of chunk) if (byte === 3 && ++ctrlC >= 2) process.exit(0);
  });
  if (plan.screen !== "hang") process.stdout.write(plan.screen.replace(/\\n/g, "\\r\\n"));
  setInterval(() => {}, 1000);
}
`;

export interface FakeClaude {
  binDir: string;
  configDir: string;
  setPlan(plan: FakeClaudePlan): void;
  screenStarts(): Array<{ argv: string[]; env: Record<string, string | null> }>;
  /** Every byte the screen received, hex-encoded. */
  keys(): string;
  authCalls(): number;
  /** The processes stubborn starts left: pids and their process group. */
  procs(): Array<{ what: "auth" | "screen"; pids: number[]; pgid: number }>;
}

export function makeFakeClaude(): FakeClaude {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-usage-"));
  const binDir = path.join(root, "bin");
  const configDir = path.join(root, "claude-config");
  fs.mkdirSync(binDir);
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(binDir, "claude"), SCRIPT(process.execPath), { mode: 0o755 });
  const read = (name: string) => { try { return fs.readFileSync(path.join(configDir, name), "utf8"); } catch { return ""; } };
  return {
    binDir,
    configDir,
    setPlan: (plan) => {
      fs.writeFileSync(path.join(configDir, "fake-plan.json"), JSON.stringify(plan));
      fs.rmSync(path.join(configDir, "auth-calls"), { force: true });
      fs.rmSync(path.join(configDir, "procs.log"), { force: true });
    },
    screenStarts: () => read("screen-starts.log").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    keys: () => read("keys.log"),
    authCalls: () => Number(read("auth-calls") || 0),
    procs: () => read("procs.log").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

export const CLAUDE_AUTH = {
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "d***@example.test", orgId: "org-1", orgName: "Example Org", subscriptionType: "team",
};

/** A `/usage` screen as Claude Code 2.1.x renders it (shape per Ops' reader; email-free). */
export function usageScreen(opts: { session?: number; week?: number; sessionReset?: string; weekReset?: string; extra?: string } = {}): string {
  return [
    " Settings:  Status   Config   Usage",
    "",
    " Current session",
    ` ██████████                                         ${opts.session ?? 23}% used`,
    ` Resets ${opts.sessionReset ?? "3pm (UTC)"}`,
    "",
    " Current week (all models)",
    ` ███                                                ${opts.week ?? 41}% used`,
    ` Resets ${opts.weekReset ?? "Oct 14, 9am (UTC)"}`,
    ...(opts.extra ? ["", opts.extra] : []),
    "",
    " Esc to cancel",
  ].join("\n");
}
