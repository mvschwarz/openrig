import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);

/** One OS process, as `ps -Ao pid,ppid,pgid,tpgid,ucomm,lstart,command` prints it in the C locale. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  executableName: string;
  /** lstart, in local time: the identity half of pid + start time. */
  startedAt: string;
  command: string;
}

let inFlight: Promise<ProcessTableRow[]> | null = null;
let procRoot = "/proc";

/**
 * The OS process table, every observer's one source: read from /proc on Linux, where a `ps` would cost the daemon a
 * fork of its whole process, and from one `ps` elsewhere. Callers asking while a read is in flight share it; a later
 * call reads again, so two samples taken one after the other stay two observations. Rejects when the table cannot be
 * read.
 */
export function readProcessTable(): Promise<ProcessTableRow[]> {
  inFlight ??= (process.platform === "linux" ? readProcTable(procRoot) : readPsTable()).finally(() => { inFlight = null; });
  return inFlight;
}

/** Points the Linux read at a /proc of a test's own, so a scenario's processes reach the observers through it; no
 *  argument puts the real /proc back. */
export function setProcRootForTest(root = "/proc"): void {
  procRoot = root;
}

const PS_ROW = /^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

async function readPsTable(): Promise<ProcessTableRow[]> {
  // lstart is locale-formatted; the child-only C locale keeps the English date the parser expects.
  const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid,pgid,tpgid,ucomm,lstart,command"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  return stdout.split("\n").slice(1).flatMap((line) => {
    // ucomm may contain spaces on every platform: macOS app helpers (`Slack Helper`), and on
    // Linux task names set by prctl(PR_SET_NAME) or process.title (`tmux: server`,
    // `node (vitest 1)`). lstart always begins with a weekday word and runs to the year, and
    // ucomm (16 bytes at most) is too short to contain such a date, so matching ucomm lazily
    // up to the first date is exact.
    const match = line.trim().match(PS_ROW);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), executableName: match[5]!, startedAt: match[6]!, command: match[7]! }] : [];
  });
}

// USER_HZ (`getconf CLK_TCK`), the unit of /proc's start times. The kernel fixes it at 100 for user space on every
// architecture Node supports (x64, arm, arm64, ppc64, s390x, riscv64, loong64), whatever its own tick rate; only
// Alpha and IA-64 used another. A constant spares a sysconf call Node does not expose.
const TICKS_PER_SECOND = 100;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ps's lstart (ctime's layout, local time): `Fri Oct  6 09:05:01 2026`. */
function lstart(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

/** What ps prints in the C locale of a name or command line read one character a byte (latin1): a control character
 *  is a `.`, each byte of a non-ASCII character a `?`. Identity reads the command line as ps prints it: a character
 *  such as a no-break space inside an argument is no separator there. */
function printable(bytes: string): string {
  return bytes.replace(/[\u0000-\u001f\u007f]/g, ".").replace(/[\u0080-\u00ff]/g, "?");
}

/** A file read under /proc: its bytes one character a byte (so names are cut and printed on bytes as ps does), or the
 *  code of the error that kept it from being read. */
type ProcFile = string | { code: string };

/** Part of a /proc's table, as the reader sends it: the boot time, then pids with their stat and cmdline (null once
 *  the stat could not be read, its process gone or hidden). The last part is `done`; a read that failed whole sends
 *  its error instead. */
type ProcPart =
  | { id: number; bootTime: number; files: Array<[pid: string, stat: ProcFile, cmdline: ProcFile | null]>; done: boolean }
  | { id: number; error: string };

// The reader's thread. It reads every file synchronously, the cheapest way: as many asynchronous reads cost ten times
// that in the thread pool, as much CPU as the `ps` they replace. A file is read as UTF-8, Node's one native call, and
// read again one character a byte only when it holds a byte that is no UTF-8 (rare). The table is sent in parts of
// PIDS_PER_PART pids, so the event loop parses it a part at a time. A pid whose stat cannot be read is left out only
// when ps leaves it out too: its process is gone (ENOENT, ESRCH), or hidden from this user by /proc's hidepid (EPERM,
// EACCES). Any other failure (out of file descriptors, say) fails the read whole, as a `ps` that cannot run does,
// rather than giving a shorter table that looks complete.
const READER_SOURCE = String.raw`
  const fs = require("node:fs");
  const { parentPort } = require("node:worker_threads");
  const PIDS_PER_PART = 100;
  const STAT_LEFT_OUT = new Set(["ENOENT", "ESRCH", "EPERM", "EACCES"]);

  function read(file) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (!/[^\x00-\x7f]/.test(text)) return text;
      return text.includes("�") ? fs.readFileSync(file, "latin1") : Buffer.from(text, "utf8").toString("latin1");
    } catch (error) {
      return { code: String(error.code) };
    }
  }

  parentPort.on("message", ({ id, root }) => {
    try {
      const bootTime = Number(/^btime (\d+)$/m.exec(fs.readFileSync(root + "/stat", "utf8"))?.[1]);
      if (!Number.isFinite(bootTime)) throw new Error(root + "/stat has no btime");
      const pids = fs.readdirSync(root).filter((entry) => /^\d+$/.test(entry));
      for (let start = 0; start === 0 || start < pids.length; start += PIDS_PER_PART) {
        const files = pids.slice(start, start + PIDS_PER_PART).map((pid) => {
          const stat = read(root + "/" + pid + "/stat");
          if (typeof stat === "string") return [pid, stat, read(root + "/" + pid + "/cmdline")];
          if (!STAT_LEFT_OUT.has(stat.code)) throw new Error("cannot read " + root + "/" + pid + "/stat: " + stat.code);
          return [pid, stat, null];
        });
        parentPort.postMessage({ id, bootTime, files, done: start + PIDS_PER_PART >= pids.length });
      }
    } catch (error) {
      parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
`;

let reader: Worker | null = null;
let lastAsk = 0;
const asked = new Map<number, { worker: Worker; rows: ProcessTableRow[]; resolve: (rows: ProcessTableRow[]) => void; reject: (error: Error) => void }>();

/** The process table read from /proc (`root` for tests): the rows ps would print, without a process of its own. The
 *  files are read on the reader's thread: a read that waits (a cmdline waits on its process's memory lock) holds that
 *  thread, never the daemon's event loop, which only parses what it is sent. */
export function readProcTable(root = "/proc"): Promise<ProcessTableRow[]> {
  const worker = reader ??= startReader();
  const id = ++lastAsk;
  // Idle, the reader keeps no process up; while an answer is owed it does.
  worker.ref();
  return new Promise((resolve, reject) => {
    asked.set(id, { worker, rows: [], resolve, reject });
    worker.postMessage({ id, root });
  });
}

function startReader(): Worker {
  const worker = new Worker(READER_SOURCE, { eval: true, execArgv: [] });
  worker.unref();
  worker.on("message", (part: ProcPart) => {
    const ask = asked.get(part.id);
    if (!ask) return;
    if ("files" in part) {
      for (const [pid, stat, cmdline] of part.files) {
        const row = procRow(pid, stat, cmdline, part.bootTime);
        if (row) ask.rows.push(row);
      }
      if (!part.done) return;
    }
    asked.delete(part.id);
    if (asked.size === 0) worker.unref();
    if ("files" in part) ask.resolve(ask.rows);
    else ask.reject(new Error(part.error));
  });
  // A reader lost fails what it owed, and only that: its `error` then its `exit` may come after the next read has
  // started another, whose reads are its own.
  const lost = (error: Error) => {
    if (reader === worker) reader = null;
    for (const [id, ask] of asked) {
      if (ask.worker !== worker) continue;
      asked.delete(id);
      ask.reject(error);
    }
  };
  worker.on("error", lost);
  worker.on("exit", (code) => lost(new Error(`the /proc reader exited with code ${code}`)));
  return worker;
}

/** The errors of a read under /proc/<pid> once the process has exited. */
const PROCESS_GONE = new Set(["ENOENT", "ESRCH"]);

function procRow(pid: string, stat: ProcFile, cmdlineFile: ProcFile | null, bootTime: number): ProcessTableRow | null {
  // Exited between the listing and the read, or hidden; without its stat ps lists nothing of it either.
  if (typeof stat !== "string" || cmdlineFile === null) return null;
  // Only a process that is gone is dropped. One whose command line cannot be read (denied, say) is still running, and
  // its foreground still counts: ps lists it by its name in brackets.
  if (typeof cmdlineFile !== "string" && PROCESS_GONE.has(cmdlineFile.code)) return null;
  const cmdline = typeof cmdlineFile === "string" ? cmdlineFile : "";
  // `pid (comm) state ppid pgrp session tty_nr tpgid …`: comm may hold spaces and parentheses, so fields count from
  // its last `)`; the start time is the 22nd field, in ticks since boot.
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  if (close < 0 || fields.length < 20) return null;
  const comm = stat.slice(stat.indexOf("(") + 1, close);
  const name = printable(comm);
  // A kernel thread or a zombie has no command line, and an unreadable one shows none: ps shows its name in brackets.
  const command = printable(cmdline.replace(/[\0\n]/g, " ")).trim()
    || `[${name}]${fields[0] === "Z" ? " <defunct>" : ""}`;
  return {
    pid: Number(pid),
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    tpgid: Number(fields[5]),
    // The kernel may give a worker thread a longer name; ucomm is the task name's 15 bytes.
    executableName: printable(comm.slice(0, 15)),
    startedAt: lstart(bootTime + Math.floor(Number(fields[19]) / TICKS_PER_SECOND)),
    command,
  };
}

