import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import type { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";

// The daemon runs every `run(argv, legacy)` call as argv on POSIX. A legacy string that a shell would split
// differently from its argv means the shell path and the argv path hand tmux different arguments. A real
// /bin/sh is the oracle: it unquotes each legacy string exactly as `exec` did.

const runFile = promisify(execFile);
const SOURCE = fileURLToPath(new URL("../src/adapters/tmux.ts", import.meta.url));

/** One /bin/sh run unquotes every command: each prints its words NUL-terminated, then a lone SOH record. */
async function shellWords(cmds: string[]): Promise<string[][]> {
  const script = cmds.map((cmd) => `printf '%s\\0' ${cmd}; printf '\\001\\0'`).join("\n");
  const { stdout } = await runFile("/bin/sh", ["-c", script], { maxBuffer: 16 * 1024 * 1024 });
  const out: string[][] = [[]];
  for (const word of stdout.split("\0").slice(0, -1)) {
    if (word === "\u0001") out.push([]);
    else out.at(-1)!.push(word);
  }
  out.pop();
  return out;
}

function runSites(): number[] {
  return readFileSync(SOURCE, "utf8").split("\n")
    .flatMap((line, i) => /this\.run\(/.test(line) ? [i + 1] : []);
}

interface RunCall { site: number; argv: string[]; legacy: string }

const SESSION = "seat'q a";
const TARGET = { nodeId: "node-1", session: SESSION, occupant: "occupant-1", pane: "%1" };

function respond(cmd: string, failing: string[], composer = false): string {
  const sub = cmd.split(" ")[1] ?? "";
  if (failing.includes(sub)) throw new Error(`Command failed: ${cmd}\ncan't find session: missing`);
  // #1072's composer snapshot reads a cursor and a screen before its mode check; other calls keep their replies.
  if (composer && sub === "display-message" && cmd.includes("cursor_x")) return "2|0|80|24\n";
  if (composer && sub === "capture-pane") return "❯ \n";
  switch (sub) {
    case "list-sessions": return `${SESSION}\nalpha\n`;
    case "list-panes": return "%1|0|/w|80|24|1\n";
    case "display-message":
      return cmd.includes("session_id") ? "$7\n" : cmd.includes("pane_pid") ? "4242\n" : "1\n";
    case "show-environment": return "OPENRIG_NODE_ID=n1\nCLAUDECODE=1\nHERDR_PANE_ID=p1\n";
    case "new-session": return "%1\n";
    default: return "";
  }
}

/** A shell-path adapter whose every run() call records its caller line, its argv and the string exec received. */
function recordingAdapter(calls: RunCall[], opts: { failing?: string[]; guard?: boolean; composer?: boolean } = {}): TmuxAdapter {
  const execs: string[] = [];
  const fileOps: TmuxFileOps = {
    writeFile: async () => {},
    unlink: async () => {},
    tmpName: () => "/tmp/a b/it's.txt",
    bufferName: () => "openrig_1_buf",
  };
  const adapter = new TmuxAdapter(async (cmd) => {
    execs.push(cmd);
    return respond(cmd, opts.failing ?? [], opts.composer);
  }, fileOps);
  if (opts.guard) {
    adapter.deliveryGuard = {
      maybeTarget: () => TARGET,
      target: () => TARGET,
      ownsLifecycle: () => false,
      checkInput: () => {},
      input: (_name: string, fn: () => Promise<unknown>) => fn(),
      operation: (_name: string, fn: () => Promise<unknown>) => fn(),
      humanInput: (_name: string, fn: () => Promise<unknown>) => fn(),
      // The draft-aware hooks (#1072); off here, so input takes the same path as without them.
      attachInputInspection: () => {},
      needsInputCheck: () => false,
      beforeInput: async () => {},
      notePasted: async () => {},
    } as unknown as SeatDeliveryGuard;
  }
  const self = adapter as unknown as { run: (argv: string[], legacy?: string) => Promise<string> };
  const original = self.run.bind(adapter);
  self.run = async (argv, legacy) => {
    const frame = /src\/adapters\/tmux\.ts:(\d+):\d+/.exec(new Error().stack ?? "");
    const before = execs.length;
    try {
      return await original(argv, legacy);
    } finally {
      calls.push({ site: Number(frame?.[1]), argv, legacy: execs[before]! });
    }
  };
  return adapter;
}

async function driveEveryMethod(): Promise<RunCall[]> {
  const calls: RunCall[] = [];
  const a = recordingAdapter(calls);
  await a.startServer();
  await a.listSessions();
  await a.listWindows(SESSION);
  await a.listPanes(SESSION);
  await a.listPanes("=seat:1");
  await a.probeSession(SESSION);
  await a.hasSession(SESSION);
  await a.createSession(SESSION, "/w x", { PATH: "/a b:$HOME", Q: "it's" });
  await a.sendText(SESSION, "hello");
  await a.sendText(SESSION, "1", undefined, { bracketed: false });
  await a.sendShellCommand(SESSION, "echo 'hi there'", undefined, { sourceInPane: true });
  await a.sendKeys(SESSION, ["Enter; rm -rf /", "C-c"]);
  await a.setWindowOption(SESSION, "@openrig x", "a b'c");
  await a.resizeWindow(SESSION, 120, 40);
  await a.killSession(SESSION);
  await a.respawnPane("%1", "codex resume 'tok en'", { cwd: "/w x", env: { A: "b c", Q: "it's" } });
  await a.respawnPane("%1");
  await a.getPaneLocalOption("%1", "remain-on-exit");
  await a.restorePaneOption("%1", "remain-on-exit", "on");
  await a.restorePaneOption("%1", "remain-on-exit", null);
  await a.capturePaneHistory("%1");
  await a.setRemainOnExit("%1", true);
  await a.isPaneDead("%1");
  await a.isPaneInMode("%1");
  await a.signalPaneProcess("%1", "TERM");
  await a.getPanePid(SESSION);
  await a.getDefaultShell();
  await a.getPaneCommand(SESSION);
  await a.getSessionEnv(SESSION, "OPENRIG_NODE_ID");
  await a.setSessionEnv(SESSION, "SEAT_FLAG", "it's a value");
  await a.unsetSessionEnv(SESSION, "SEAT_FLAG");
  await a.hasSessionEnv(SESSION, "OPENRIG_NODE_ID");
  await a.startPipePane(SESSION, "/tmp/out dir/it's.log");
  await a.stopPipePane(SESSION);
  await a.capturePanesContent([SESSION, "alpha", "missing"], 50);
  await a.capturePaneContent(SESSION, 30);
  await a.capturePaneContent(SESSION, 30, { escapeSequences: true });
  await a.capturePaneScreen(SESSION);
  await a.getPaneCursorPosition(SESSION);
  await a.setSessionOption(SESSION, "@openrig-x", "a b'c");
  await a.setServerOption("copy-command", "pbcopy -x 'y'");
  await a.showServerOption("copy-command");
  await a.getSessionOption(SESSION, "@openrig-x");
  await a.readAllSessionWindowActivity();
  await a.readAllSessionWindows();
  await a.readAllPaneProcesses();
  await a.readPaneLastActivity(SESSION);
  await a.listClients();
  await a.switchClient("/dev/ttys001", SESSION);
  // A failed paste deletes the loaded buffer; the guarded kill reads the session id first.
  await recordingAdapter(calls, { failing: ["paste-buffer"] }).sendText(SESSION, "hello");
  await recordingAdapter(calls, { guard: true }).killSession(SESSION);
  await recordingAdapter(calls, { composer: true }).captureComposerSnapshot("%1");
  return calls;
}

// One /bin/sh spawn can take seconds on a loaded host with endpoint scanning.
describe.skipIf(process.platform === "win32")("tmux argv and legacy shell strings", { timeout: 120000 }, () => {
  it("the oracle unquotes the way tmux receives arguments", async () => {
    expect(await shellWords([`tmux 'a b' "#{x}|#{y}" 'it'"'"'s' \\; -S -5`, "tmux -V"]))
      .toEqual([["tmux", "a b", "#{x}|#{y}", "it's", ";", "-S", "-5"], ["tmux", "-V"]]);
  });

  it("every run() call site hands tmux the same arguments on both paths", async () => {
    const calls = await driveEveryMethod();
    expect([...new Set(calls.map((c) => c.site))].sort((x, y) => x - y)).toEqual(runSites());
    const words = await shellWords(calls.map((c) => c.legacy));
    expect(words).toHaveLength(calls.length);
    calls.forEach((c, i) => {
      expect(words[i], `tmux.ts:${c.site} ${c.legacy}`).toEqual(c.argv);
    });
  });
});
