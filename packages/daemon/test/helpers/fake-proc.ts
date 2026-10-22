// A scenario's processes served through the process table's Linux read (/proc), on any host platform.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setProcRootForTest } from "../../src/domain/process-table.js";

/** A process as ps would list it. */
export interface FakeProcess {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  /** The task name (ucomm), 15 bytes at most. */
  name: string;
  /** lstart, in local time: `Fri Oct  2 20:00:00 2026`. */
  startedAt: string;
  /** The command line, its arguments joined by spaces; empty for a kernel thread. */
  command: string;
}

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];

/** Writes `processes` as a /proc of their own (boot time 0, so a start time is its lstart in ticks) and returns it. */
export function writeFakeProc(processes: FakeProcess[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "stat"), "cpu  1 2 3\nbtime 0\n");
  for (const { pid, ppid, pgid, tpgid, name, startedAt, command } of processes) {
    const ticks = Date.parse(startedAt) / 10;
    if (!Number.isInteger(ticks)) throw new Error(`not an lstart: ${startedAt}`);
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), "stat"),
      `${pid} (${name}) S ${ppid} ${pgid} ${pgid} 34816 ${tpgid} 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1000 200\n`);
    fs.writeFileSync(path.join(root, String(pid), "cmdline"), command ? `${command}\0` : "");
  }
  return root;
}

/** Makes the process table read `processes` from /proc, as on Linux, until restoreProc(). */
export function serveFakeProc(processes: FakeProcess[]): void {
  Object.defineProperty(process, "platform", { value: "linux" });
  setProcRootForTest(writeFakeProc(processes));
}

/** Makes the process table read `root` as /proc, as on Linux, until restoreProc(). */
export function serveProcRoot(root: string): void {
  Object.defineProperty(process, "platform", { value: "linux" });
  setProcRootForTest(root);
}

/** The host's platform and /proc back, and the fake ones removed. */
export function restoreProc(): void {
  setProcRootForTest();
  Object.defineProperty(process, "platform", platform);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
