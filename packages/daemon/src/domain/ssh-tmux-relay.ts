import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeProcessRow } from "./native-process-lineage.js";
import { parsePsTable } from "./process-table.js";

export interface SshTmuxRelay { kind: "ssh-tmux"; host: string; session: string }
export function parseSshTmuxRelay(value: unknown): SshTmuxRelay | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== "ssh-tmux" || typeof v.host !== "string" || typeof v.session !== "string"
    || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(v.host)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(v.session) || v.host.length > 255) return null;
  return { kind: "ssh-tmux", host: v.host, session: v.session };
}
export const RELAY_REMOTE_PATH = 'export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin"; ';
export function relayAttachCommand(relay: SshTmuxRelay): string {
  return `${RELAY_REMOTE_PATH}exec tmux attach-session -t =${relay.session}`;
}

/** Only the bounded launch grammar whose destination/config the independent probe shares.
 * In particular -F/-J/-p/-l/ProxyCommand overrides must not attest another endpoint. */
export function matchesRelaySsh(command: string, relay: SshTmuxRelay): boolean {
  const words = command.trim().split(/\s+/);
  if (words.shift()?.split("/").pop() !== "ssh") return false;
  let tty = false;
  while (words[0]?.startsWith("-")) {
    const option = words.shift();
    if (option === "-tt" || option === "-t") { tty = true; continue; }
    if (option === "-o") {
      const value = words.shift() ?? "";
      if (!/^(?:BatchMode=yes|StrictHostKeyChecking=yes|ConnectTimeout=\d+|ServerAliveInterval=\d+|ServerAliveCountMax=\d+|ExitOnForwardFailure=yes)$/.test(value)) return false;
    } else if (option === "-R") {
      if (!/^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/.test(words.shift() ?? "")) return false;
    } else return false;
  }
  return tty && words.shift() === relay.host && words.join(" ") === relayAttachCommand(relay);
}

export function relayLocalFingerprint(rows: NativeProcessRow[], panePid: number, relay: SshTmuxRelay): string | null {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const root = byPid.get(panePid);
  if (byPid.size !== rows.length || !root?.startedAt || !root.tpgid || root.tpgid < 0) return null;
  const matches: NativeProcessRow[][] = [];
  for (const row of rows) {
    if (row.executableName !== "ssh" || row.pgid !== root.tpgid || row.tpgid !== root.tpgid
      || !matchesRelaySsh(row.command, relay)) continue;
    const chain: NativeProcessRow[] = [];
    const seen = new Set<number>();
    let current: NativeProcessRow | undefined = row;
    while (current?.startedAt && !seen.has(current.pid)) {
      seen.add(current.pid); chain.push(current);
      if (current.pid === panePid) { matches.push(chain); break; }
      current = byPid.get(current.ppid);
    }
  }
  return matches.length === 1 ? JSON.stringify(matches[0]) : null;
}

export interface RelaySnapshot { panePid: number; rows: NativeProcessRow[]; identity: string }
const execute = promisify(execFile);
export async function readRelaySnapshot(relay: SshTmuxRelay): Promise<RelaySnapshot | null> {
  // Fixed commands and validated identifiers only. Never inherit a caller-supplied remote script.
  const command = `${RELAY_REMOTE_PATH}tmux list-panes -s -t =${relay.session} -F '#{session_id} #{session_created} #{pane_id} #{pane_pid}' && printf '\\nOPENRIG_PROCESS_TABLE\\n' && LC_ALL=C ps -Ao pid,ppid,pgid,tpgid,ucomm,lstart,command`;
  try {
    const { stdout } = await execute("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=3", "-o", "ClearAllForwardings=yes", relay.host, command],
    { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    return parseRelaySnapshot(stdout);
  } catch { return null; }
}
export function parseRelaySnapshot(stdout: string): RelaySnapshot | null {
  const parts = stdout.split("\nOPENRIG_PROCESS_TABLE\n");
  if (parts.length !== 2) return null;
  const identity = parts[0]!.trim();
  const pane = /^\$\d+ \d+ %\d+ ([1-9]\d*)$/.exec(identity);
  if (!pane) return null; // Multiple panes/windows, banners, missing or malformed observation.
  const rows = parsePsTable(parts[1]!);
  return rows.length ? { panePid: Number(pane[1]), rows, identity } : null;
}
