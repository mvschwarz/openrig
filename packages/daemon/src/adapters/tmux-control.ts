import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { spawnTmuxClient, TMUX_MAX_BUFFER } from "./tmux-exec.js";
import type { ArgvExecFn } from "./tmux.js";

/**
 * tmux commands over one long-lived control-mode client (`tmux -C`) instead of a new tmux client per command. Opt-in:
 * the daemon drives tmux this way only with OPENRIG_TMUX_CONTROL=1 (startup.ts); without it, every command spawns a
 * client, as before.
 *
 * Each spawned client costs the daemon a fork of its whole process: some 28 ms of CPU a command at its size, against
 * 0.3 ms for a line written to a client already connected. The client makes a session of its own as it attaches
 * (`new-session`: an existing session is never taken over, whatever its name), named after this daemon's owner id and
 * marked with it (`@openrig-control`), and `destroy-unattached`: tmux destroys it when the client leaves, so the daemon
 * never kills a session itself. Listings leave out this daemon's own session and client, and nothing else: a session
 * another daemon or a person made, whatever its name or mark, is listed as any other.
 *
 * What it runs and what it gives back are the spawned client's: the same commands, their output, the same error text
 * in `execStderr`, a chain stopped at its first failing command, and output past TMUX_MAX_BUFFER failed with execFile's
 * `maxBuffer length exceeded`. The differences: a chain's commands are sent one after the other's reply, so another
 * client's command may run between them, which it cannot in a spawned client's chain; a client that ends partway
 * through a chain fails the rest at once, the outcome of the commands it sent unknown, and none is run again; and the
 * blocks tmux's hooks print on their own (an `after-list-panes` in a user's tmux.conf) are not taken for a command's
 * reply, where a spawned client prints a hook's output after its command's. Anything else (a launch,
 * which takes the spawning process's environment; `load-buffer`, see ROUTED; a command line that cannot be written on
 * one line; a global flag other than this client's server selection; no server yet, or one before 3.2) goes to the
 * spawned client, as before.
 */

/** The session option that marks a control session: its value is the owner id of the daemon whose client made it. */
export const CONTROL_OPTION = "@openrig-control";

/** The name a daemon's control session is made with: one of its own on any server. */
export function controlSessionName(owner: string): string {
  return `openrig-control-${owner}`;
}

/** What the control session's pane runs, exec'd as argv (no `default-shell -c`, so no shell of the user's and none of
 *  its rc files): a non-interactive sh that waits forever. */
const KEEP_ALIVE = ["sh", "-c", "while :; do sleep 86400; done"];

// Commands that only read the server or write into a pane, whose outcome does not depend on the client that sends
// them as long as they name their target. A launch or an environment change stays spawned. So does `load-buffer`: it
// would have the server open the file itself, in its own loop (a FIFO with no writer stops the whole server) and in its
// own view of the filesystem, where a spawned client reads the file and hands the server its bytes.
const ROUTED = new Set([
  "capture-pane", "display-message", "has-session", "list-sessions", "list-windows", "list-panes", "list-clients",
  "show-environment", "paste-buffer", "delete-buffer", "send-keys",
]);

const LISTINGS = new Set(["list-sessions", "list-windows", "list-panes", "list-clients"]);

/** The routed commands that change nothing, which may be run again after their client is lost. Any other one
 *  (`send-keys`, `paste-buffer`, `delete-buffer`) is a write: once written, it may have taken effect. */
const READS = new Set([...LISTINGS, "capture-pane", "display-message", "has-session", "show-environment"]);

/** Whether a command acts on the same target from any client: a control client's own session would otherwise be the
 *  "current" one that a target-less command reads. */
function namesItsTarget(args: string[]): boolean {
  const [command] = args;
  if (args.includes("-t")) return true;
  if (command === "list-sessions" || command === "list-clients" || command === "delete-buffer") return true;
  if (command === "list-windows" || command === "list-panes") return args.includes("-a");
  if (command === "show-environment") return args.includes("-g");
  return false;
}

/** The argv's commands, as a spawned tmux reads its arguments (cmd-parse.c): an argument ending in `;` ends its
 *  command and keeps the rest (`abc;` is `abc`, then a new command); one ending in `\;` is kept with a literal `;`
 *  instead (`abc\;` is `abc;`). An empty command is skipped. Each argument is then sent quoted, as it reads. */
export function commandsOf(args: string[]): string[][] {
  const commands: string[][] = [];
  let command: string[] = [];
  for (const arg of args) {
    if (!arg.endsWith(";")) {
      command.push(arg);
      continue;
    }
    const rest = arg.slice(0, -1);
    if (rest.endsWith("\\")) {
      command.push(`${rest.slice(0, -1)};`);
      continue;
    }
    if (rest !== "") command.push(rest);
    if (command.length > 0) commands.push(command);
    command = [];
  }
  if (command.length > 0) commands.push(command);
  return commands;
}

/** What starts each row a listing prints for the owner's own session, its windows, panes and client: drawn for each
 *  call, so that no other row (whatever its format prints) and no other command's output starts with it. */
export function ownRowTag(): string {
  return `${randomBytes(8).toString("hex")}:`;
}

/** The argv with each listing's `-F` format starting its own rows (the owner's session's, and its client's) with `tag`,
 *  which `withoutOwnRows` then drops. No `-f` filter: one needs tmux 3.2 (3.4 for list-clients) of the server, which a
 *  client's own version does not tell. A format is all a row shows, so a listing without `-F` is left as is. */
export function markOwnRows(args: string[], owner: string, tag: string): string[] {
  let first = true;
  let listing = false;
  return args.map((arg, i) => {
    let out = arg;
    if (first) {
      listing = LISTINGS.has(arg);
      first = false;
    } else if (listing && args[i - 1] === "-F" && !arg.endsWith(";")) {
      out = `#{?#{==:#{${CONTROL_OPTION}},${owner}},${tag},}${arg}`;
    }
    if (arg.endsWith(";") && !arg.endsWith("\\;")) first = true;
    return out;
  });
}

/** A listing's output without the rows `markOwnRows` marked with `tag`. */
export function withoutOwnRows(stdout: string, tag: string): string {
  if (!stdout.includes(tag)) return stdout;
  return stdout.split("\n").filter((line) => !line.startsWith(tag)).join("\n");
}

/** One argument on a control-mode command line: in single quotes, where tmux expands nothing; a ' closes them, is
 *  escaped, and opens them again. */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Whether tmux's version (`tmux -V`, or a server's `#{version}`) names 3.2 or later: the client flags of
 *  `new-session -f`. */
export function supportsControlMode(versionLine: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionLine);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 3 || (major === 3 && Number(match[2]) >= 2);
}

/** A command's reply: its output lines, none once they went past the bound (`overflow`). */
interface Reply {
  ok: boolean;
  lines: string[];
  overflow: boolean;
}

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

/** The replies of one control client, read off its stdout: each command's `%begin` … `%end` (or `%error`) block, in
 *  the order the commands were written. A block ends only on the line that repeats its own `%begin` header, so a pane
 *  line reading `%end …` never ends it. Only a block whose flags (the header's third field) say the client sent the
 *  command answers one: a hook (`after-list-panes` in a user's tmux.conf) prints its own blocks, flagged 0, between
 *  them, and those are no command's reply. A reply keeps at most `maxBytes` of output, as a spawned client's stdout is
 *  bounded (TMUX_MAX_BUFFER): past it, its lines are dropped as they come, up to its end, so every later reply is still
 *  its own command's, and it is answered as overflowed. A line with no end yet is bounded the same way. */
export class ControlReplies {
  private partial = "";
  /** Set while the rest of a line past the bound is dropped, up to its newline. */
  private skipping = false;
  private header: string | null = null;
  private lines: string[] = [];
  /** The bytes of the block being read, and whether they went past the bound. */
  private bytes = 0;
  private overflow = false;
  private readonly pending: Pending[] = [];
  /** The first block answers the client's own `new-session`, before any command was written. */
  private attached = false;
  /** Set once the client is gone: nothing will be answered any more. */
  private failure: Error | null = null;
  /** Called with the outcome of the client's `new-session`: false when it made no session (a name taken). */
  onAttached?: (ok: boolean) => void;
  /** Called after each command's reply. */
  onReply?: () => void;
  /** Called on tmux's `%sessions-changed`: a session was made or destroyed on the server. */
  onSessionsChanged?: () => void;

  constructor(private readonly maxBytes: number = TMUX_MAX_BUFFER) {}

  get closed(): boolean {
    return this.failure !== null;
  }

  /** The commands written and not answered yet. */
  get waiting(): number {
    return this.pending.length;
  }

  expect(pending: Pending): void {
    if (this.failure) pending.reject(this.failure);
    else this.pending.push(pending);
  }

  push(chunk: string): void {
    this.partial += chunk;
    let newline: number;
    while ((newline = this.partial.indexOf("\n")) >= 0) {
      const line = this.partial.slice(0, newline).replace(/\r$/, "");
      this.partial = this.partial.slice(newline + 1);
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    // In bytes, as the bound is: a UTF-16 unit is 1 to 3 bytes, so the count is taken only when the length cannot tell.
    const units = this.partial.length;
    if (units > this.maxBytes || (units * 3 > this.maxBytes && Buffer.byteLength(this.partial) > this.maxBytes)) {
      this.partial = "";
      this.skipping = true;
      this.overflowed();
    }
  }

  /** Drops the block's output once past the bound: only that it overflowed is kept. */
  private overflowed(): void {
    if (this.header === null) return;
    this.overflow = true;
    this.lines = [];
  }

  private line(line: string): void {
    if (this.header === null) {
      if (line.startsWith("%begin ")) {
        this.header = line.slice("%begin ".length);
        this.lines = [];
        this.bytes = 0;
        this.overflow = false;
      } else if (line === "%sessions-changed") {
        this.onSessionsChanged?.();
      }
      return;
    }
    if (line === `%end ${this.header}` || line === `%error ${this.header}`) {
      const ok = line.startsWith("%end ");
      const flags = Number(this.header.split(" ")[2]);
      this.header = null;
      if (!this.attached) {
        this.attached = true;
        this.onAttached?.(ok);
        return;
      }
      if ((flags & 1) === 0) return;
      this.pending.shift()?.resolve({ ok, lines: this.lines, overflow: this.overflow });
      this.onReply?.();
      return;
    }
    if (this.overflow) return;
    this.bytes += Buffer.byteLength(line) + 1;
    if (this.bytes > this.maxBytes) this.overflowed();
    else this.lines.push(line);
  }

  /** Fails every command still waiting, and any expected later: the client is gone, so none will be answered. */
  failAll(error: Error): void {
    this.failure ??= error;
    for (const p of this.pending.splice(0)) p.reject(error);
  }
}

/** The error a spawned tmux would have thrown for this failure: tmux's text on stderr, the earlier commands' output on
 *  stdout. Its message is execFile's (the command, then stderr as is), with the output `execArgvCommand` appends to it. */
function commandFailed(argv: string[], stdout: string, stderr: string): Error {
  const message = `Command failed: ${argv.join(" ")}\n${stderr}`;
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return Object.assign(new Error(output && !message.includes(output) ? `${message}\n${output}` : message), {
    code: 1, stdout, stderr, execStderr: stderr,
  });
}

/** The error a spawned client's call fails with once its stdout is past its bound (execFile's maxBuffer): the same
 *  first line, which callers match (`capturePanesContent` splits its chain on it), and tmux's stderr empty. */
function outputTooLarge(stdout: string): Error {
  return Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout, stderr: "", execStderr: "",
  });
}

/** Starts the control client with these tmux arguments (`spawnTmuxClient`); tests give their own. */
export type SpawnControlClient = (args: string[]) => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>;

export interface TmuxControlOptions {
  spawnClient?: SpawnControlClient;
  /** The adapter's fixed server selection (`-S <socket>` or `-L <name>`). Empty keeps tmux's inherited server.
   *  Only commands carrying this exact selection may use this client's connection. */
  serverArgs?: readonly string[];
  /** Once the command at the head of the line has had no reply for this long, the client is ended: the reads it owed
   *  are asked again of a spawned client, the writes it owed fail, and the next command starts a new client. Also the
   *  time a client has to attach. */
  replyTimeoutMs?: number;
  now?: () => number;
  /** This daemon's id on a tmux server: its control session's name and mark. A random one by default. */
  owner?: string;
  /** The most output a call may give, as a spawned client's stdout is bounded: TMUX_MAX_BUFFER by default. */
  maxBuffer?: number;
}

const RETRY_MS = [1_000, 5_000, 30_000];

const NOT_WRITTEN = new Error("tmux control client ended before the command was written");

interface ControlClient {
  child: ChildProcessWithoutNullStreams;
  replies: ControlReplies;
  /** Since when the command at the head of the line has waited: its write, or the reply before it. */
  headSince: number;
  /** Fires once that wait is past the reply timeout. */
  timer?: ReturnType<typeof setTimeout>;
  /** The calls running on it. */
  users: number;
  /** Set once it takes no new call: it ends as soon as the calls running on it are done. */
  retiring: boolean;
}

/** How long the end of a client (its input closed) may take before it is killed. */
const END_MS = 2_000;

export type TmuxControlExec = ArgvExecFn & { close: () => Promise<void>; owner: string };

/**
 * The ArgvExecFn the daemon's TmuxAdapter runs with when control mode is on: routed commands go to the control client,
 * every other one, or any while the client cannot run, to `fallback` (the spawned client).
 */
export function tmuxControlExec(fallback: ArgvExecFn, options: TmuxControlOptions = {}): TmuxControlExec {
  const owner = options.owner ?? randomBytes(4).toString("hex");
  const spawnClient = options.spawnClient ?? spawnTmuxClient;
  const replyTimeoutMs = options.replyTimeoutMs ?? 10_000;
  const maxBuffer = options.maxBuffer ?? TMUX_MAX_BUFFER;
  const now = options.now ?? (() => Date.now());
  const serverArgs = [...(options.serverArgs ?? [])];
  let client: ControlClient | null = null;
  let starting: Promise<ControlClient | null> | null = null;
  let failures = 0;
  let retryAt = 0;
  let closed = false;
  /** Every client of this daemon still running: the current one, one attaching, and those retiring. */
  const live = new Set<ControlClient>();
  /** Gives up the attach under way: the daemon is stopping. */
  let cancelAttach: (() => void) | null = null;

  const backOff = (): void => {
    retryAt = now() + RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!;
    failures++;
  };

  /** Ends a client at once and fails what it still owes. The current one, when it ended on its own, is started again
   *  after a while; when dropped for a reply overdue, at the next command. */
  const drop = (c: ControlClient, reason: string, overdue = false): void => {
    clearTimeout(c.timer);
    c.replies.failAll(new Error(`tmux control client ended: ${reason}`));
    if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill();
    if (client !== c) return;
    client = null;
    if (overdue) retryAt = 0;
    else backOff();
  };

  /** Ends a client as tmux ends one whose input closes: it detaches, after answering what it was sent, and tmux
   *  destroys its session (`destroy-unattached`). Killed if it has not gone within END_MS. */
  const end = (c: ControlClient): Promise<void> => new Promise((resolve) => {
    if (!live.has(c)) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      drop(c, "did not end");
      resolve();
    }, END_MS);
    c.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    c.child.stdin.end();
  });

  /** Takes no new call on the client, and ends it once the calls running on it are done. */
  const retire = (c: ControlClient): void => {
    c.retiring = true;
    if (client === c) {
      client = null;
      retryAt = 0;
    }
    if (c.users === 0) void end(c);
  };

  /** Drops the client once the command at the head of its line has waited past the reply timeout: every later command
   *  waits behind it, a write with no deadline of its own included. */
  const watch = (c: ControlClient): void => {
    clearTimeout(c.timer);
    if (c.replies.waiting === 0) return;
    c.timer = setTimeout(() => {
      if (now() - c.headSince >= replyTimeoutMs) drop(c, `no reply within ${replyTimeoutMs} ms`, true);
      else watch(c);
    }, Math.max(0, c.headSince + replyTimeoutMs - now()));
    c.timer.unref?.();
  };

  /** The control client's arguments: a session of its own, made as it attaches and never one that exists, marked with
   *  this daemon's id, destroyed by tmux once no client is in it, and never moving its client elsewhere when it goes. */
  const clientArgs = (): string[] => [
    ...serverArgs, "-C", "new-session", "-s", controlSessionName(owner), "-x", "80", "-y", "24", "-f", "no-output,ignore-size",
    "--", ...KEEP_ALIVE,
    ";", "set-option", CONTROL_OPTION, owner,
    ";", "set-option", "destroy-unattached", "on",
    ";", "set-option", "detach-on-destroy", "on",
  ];

  /** Whether a server runs that a control client may attach to: one of tmux 3.2 or later (its own version, not the
   *  tmux binary's) with a session that is no control session, read by a spawned client. With none, no client is
   *  started: it never starts a server, nor keeps one up that would exit without it (`checkAlone`). */
  const serverReady = async (): Promise<boolean> => {
    try {
      const rows = (await fallback(["tmux", ...serverArgs, "list-sessions", "-F", `#{version}|#{${CONTROL_OPTION}}`])).split("\n").filter(Boolean);
      return supportsControlMode(rows[0] ?? "") && rows.some((row) => row.endsWith("|"));
    } catch {
      return false;
    }
  };

  const start = async (): Promise<ControlClient | null> => {
    if (!await serverReady()) {
      backOff();
      return null;
    }
    if (closed) return null;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await spawnClient(clientArgs());
    } catch {
      backOff(); // tmux could not be started at all: asked again later, not at every command.
      return null;
    }
    const replies = new ControlReplies(maxBuffer);
    const started: ControlClient = { child, replies, headSince: 0, users: 0, retiring: false };
    live.add(started);
    replies.onReply = () => {
      started.headSince = now();
      watch(started);
    };
    replies.onSessionsChanged = () => checkAlone(started);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => replies.push(chunk));
    child.stderr.resume();
    child.on("error", (err) => {
      if (child.pid === undefined) live.delete(started); // never started: no exit will follow
      drop(started, err.message);
    });
    child.on("exit", (code, signal) => {
      live.delete(started);
      drop(started, `exited (${signal ?? code})`);
    });
    child.stdin.on("error", (err) => drop(started, err.message));
    // Its output closed, nothing will be answered: what it owes settles now, not at its reply timeout.
    child.stdout.on("close", () => drop(started, "its output closed"));
    // The daemon's exit is never held by its control client.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr] as unknown[]) (stream as { unref?: () => void }).unref?.();
    const attached = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), replyTimeoutMs);
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        cancelAttach = null;
        resolve(ok);
      };
      replies.onAttached = settle;
      cancelAttach = () => settle(false);
      child.once("exit", () => settle(false));
      // A spawn error may come without an exit: nothing runs, so nothing will attach.
      child.once("error", () => settle(false));
      if (closed) settle(false);
    });
    client = started;
    if (!attached || closed) {
      drop(started, closed ? "closed" : "did not attach");
      return null;
    }
    failures = 0;
    // The server may have lost its last other session while this one was made.
    checkAlone(started);
    return started;
  };

  const connected = async (): Promise<ControlClient | null> => {
    if (closed) return null;
    if (client) return client;
    if (now() < retryAt) return null;
    starting ??= start().finally(() => { starting = null; });
    return starting;
  };

  /** One command's reply, or the client's end: the whole line is failed when its head waits too long (`watch`), so no
   *  command waits behind a client that stopped answering, and every reply stays its own command's. */
  const send = (target: ControlClient, args: string[]): Promise<Reply> =>
    new Promise((resolve, reject) => {
      // A chain's client may have ended after an earlier command's reply, or be ending: nothing is written to it.
      if (target.replies.closed || target.child.stdin.writableEnded) {
        reject(NOT_WRITTEN);
        return;
      }
      if (target.replies.waiting === 0) target.headSince = now();
      target.replies.expect({ resolve, reject });
      target.child.stdin.write(`${args.map(quote).join(" ")}\n`);
      watch(target);
    });

  /** Retires the client once every session left on the server is a control session, this daemon's or another's:
   *  it would otherwise keep up a server that, as with spawned clients only, exits with its last session. Asked as the
   *  client attaches and at each `%sessions-changed`; a later command starts a client again while sessions remain. */
  const checkAlone = (c: ControlClient): void => {
    if (client !== c) return;
    send(c, ["list-sessions", "-F", `#{${CONTROL_OPTION}}`]).then((reply) => {
      if (reply.ok && !reply.overflow && reply.lines.every((line) => line !== "")) retire(c);
    }, () => { /* the client is gone already */ });
  };

  /** The error of a write whose client ended before its reply, with what a spawned client finds of its target now: a
   *  server or session gone reads as a spawned client's failure would (`no server running`, `can't find session`), so
   *  the adapter classifies it the same way. A client dropped for no reply is not asked about: the server is not
   *  answering, and a spawned client would wait on it as long. */
  const failedWrite = async (command: string[], err: Error): Promise<Error> => {
    const t = command.indexOf("-t");
    if (err.message.includes("no reply within") || t < 0 || t + 1 >= command.length) return err;
    try {
      await fallback(["tmux", ...serverArgs, "display-message", "-p", "-t", command[t + 1]!, ""]);
      return err;
    } catch (probe) {
      const stderr = (probe as { execStderr?: unknown }).execStderr;
      return Object.assign(new Error(`${err.message}; then ${(probe as Error).message}`),
        typeof stderr === "string" ? { execStderr: stderr } : {});
    }
  };

  const exec = async (argvIn: string[]): Promise<string> => {
    const [bin, ...argsIn] = argvIn;
    // Only the leading global server pair is a selection: capture-pane's own -S is a scrollback bound.
    // A different server (or any other global flags) belongs to a spawned client, unchanged.
    const prefix = argsIn.length >= 2 && (argsIn[0] === "-S" || argsIn[0] === "-L") ? argsIn.slice(0, 2) : [];
    const args = argsIn.slice(prefix.length);
    const sameServer = prefix.length === serverArgs.length && prefix.every((arg, i) => arg === serverArgs[i]);
    const commandsIn = sameServer && !args[0]?.startsWith("-") ? commandsOf(args) : [];
    const routable = bin === "tmux" && commandsIn.length > 0
      && commandsIn.every((c) => ROUTED.has(c[0]!) && namesItsTarget(c))
      && argsIn.every((a) => !/[\n\r\0]/.test(a));
    // Every listing leaves this daemon's own rows out, from the first one on: its session may be made by the very call
    // that lists, or by another one under way. A row is marked only on this daemon's own mark, so before its session
    // exists the output is unchanged.
    const marked = bin === "tmux" && commandsIn.some((c) => LISTINGS.has(c[0]!));
    const tag = marked ? ownRowTag() : "";
    const commandArgs = marked ? markOwnRows(args, owner, tag) : args;
    const argv = marked ? [bin, ...prefix, ...commandArgs] : argvIn;
    const own = (text: string): string => marked ? withoutOwnRows(text, tag) : text;
    const target = routable ? await connected() : null;
    if (!target) return own(await fallback(argv));
    target.users++;
    try {
      const commands = commandsOf(commandArgs);
      let stdout = "";
      let bytes = 0;
      for (const [index, command] of commands.entries()) {
        let reply: Reply;
        try {
          reply = await send(target, command);
        } catch (err) {
          // The call is run again by a spawned client only when no write of it was written: reads, and a write that
          // never reached the client. A write that was (this one, or one earlier in the chain) may have taken effect,
          // so the call fails, and the commands before this one are not run again.
          const written = commands.slice(0, err === NOT_WRITTEN ? index : index + 1);
          if (written.some((c) => !READS.has(c[0]!))) throw await failedWrite(command, err as Error);
          return own(await fallback(argv));
        }
        const output = reply.lines.length > 0 ? `${reply.lines.join("\n")}\n` : "";
        const text = LISTINGS.has(command[0]!) ? own(output) : output;
        // Past the bound, in this reply or in the chain's so far: the call fails as a spawned client's does, and the
        // rest of the chain is not sent.
        bytes += Buffer.byteLength(text);
        if (reply.overflow || bytes > maxBuffer) throw outputTooLarge(stdout);
        if (!reply.ok) throw commandFailed(argvIn, stdout, text);
        stdout += text;
      }
      return stdout;
    } finally {
      target.users--;
      if (target.retiring && target.users === 0) void end(target);
    }
  };

  /** Ends every client, one attaching included, each after what it was sent: the daemon is stopping. tmux destroys
   *  their sessions as they leave. */
  const close = async (): Promise<void> => {
    closed = true;
    cancelAttach?.();
    await starting;
    await Promise.all([...live].map(end));
  };

  return Object.assign(exec, { close, owner });
}
