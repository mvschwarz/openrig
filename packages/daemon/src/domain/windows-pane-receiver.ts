import { isWindowsShellHost } from "./shell-classifier.js";
import { listNativeProcesses, type NativeProcessLister, type NativeProcessRow } from "./native-process-lineage.js";
import { readWindowsConsoleProcesses } from "./windows-process-facts.js";
import { parseWindowsCommandLine } from "../adapters/windows-argv.js";

/** Process-only community readiness, not harness/conversation identity. Every
 * console receiver must be a known descendant; ambiguous or missing evidence fails. */
export async function verifyWindowsPaneReceiver(input: {
  target: string; getPanePid: (target: string) => Promise<number | null>;
  listProcesses?: NativeProcessLister; consoleProcesses?: typeof readWindowsConsoleProcesses;
}): Promise<boolean> {
  const sample = async () => {
    const pid = await input.getPanePid(input.target);
    if (!pid) return null;
    const rows = await (input.listProcesses ?? listNativeProcesses)();
    const byPid = new Map(rows.map(row => [row.pid, row]));
    if (byPid.size !== rows.length) return null;
    const root = byPid.get(pid);
    if (!root || !isWindowsShellHost(root.executablePath ?? "")) return null;
    const members = await (input.consoleProcesses ?? readWindowsConsoleProcesses)(pid);
    if (!members?.includes(pid) || new Set(members).size !== members.length) return null;
    const known: NativeProcessRow[] = [];
    for (const member of members) {
      const row = byPid.get(member);
      if (!row || row.platform !== "win32" || !row.executablePath || !Number.isFinite(Date.parse(row.startedAt ?? ""))) return null;
      const executable = parseWindowsCommandLine(row.command)[0];
      if (!executable || executable.replaceAll("/", "\\").toLowerCase() !== row.executablePath.replaceAll("/", "\\").toLowerCase()) return null;
      let current = row;
      const seen = new Set<number>();
      while (current.pid !== pid) {
        if (seen.has(current.pid)) return null;
        seen.add(current.pid);
        const parent = byPid.get(current.ppid);
        if (!parent || !Number.isFinite(Date.parse(parent.startedAt ?? "")) || Date.parse(parent.startedAt!) > Date.parse(current.startedAt!)) return null;
        current = parent;
      }
      known.push(row);
    }
    const receivers = known.filter(row => row.pid !== pid && !isWindowsShellHost(row.executablePath!)
      && !known.some(child => child.ppid === row.pid));
    return receivers.length === 1 ? JSON.stringify(known.sort((a, b) => a.pid - b.pid)) : null;
  };
  try { const first = await sample(); return first !== null && await sample() === first; }
  catch { return false; }
}
