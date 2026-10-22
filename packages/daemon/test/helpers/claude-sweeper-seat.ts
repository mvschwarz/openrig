import { vi } from "vitest";
import type Database from "better-sqlite3";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";
import type { NativeProcessRow } from "../../src/domain/native-process-lineage.js";
import type { NodeBinding } from "../../src/domain/runtime-adapter.js";

// A fresh Claude adapter with a mocked tmux and process list, and no launch record: the state after a
// daemon restart. The pane shows an auto-mode composer with the banner out of the capture.
export const token = "00000000-0000-4000-8000-000000001477";
export const autoScreen = "Restored conversation\n─────────\n❯ \n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";
export const startedAt = "Mon Oct 19 09:00:00 2026";
export const name = "seat@rig";
export const binary = "/home/user/.local/share/mise/installs/claude/2.1.303/claude";

export const rowsWith = (patch: Partial<NativeProcessRow> = {}): NativeProcessRow[] => [
  { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
  { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh fixture-launch.txt", startedAt },
  { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "claude", startedAt,
    command: `${binary} --permission-mode auto --resume ${token} --name ${name}`, ...patch },
];
export const real: NodeBinding = { id: "binding", nodeId: "node", tmuxSession: name, tmuxPane: "%1", tmuxWindow: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture", permissionMode: "auto" };
// What the sweepers passed before: no pane.
export const standIn: NodeBinding = { ...real, id: "sweeper:stand-in", tmuxPane: null };

// A seat whose Claude continued its conversation under a new id (#1077): the record names `rotatedToken` and carries the
// rotation back to `token`, which is what the process on the pane still names (pid 102, as rowsWith has it).
export const rotatedToken = "00000000-0000-4000-8000-000000001478";
export const rotation = { token, process: { pid: 102, startedAt } };
// The conversation a failed start asked for (`node.startup_failed.requestedResumeToken`), when it is not the one the
// seat's own record and process name.
export const requestedToken = "00000000-0000-4000-8000-000000001479";
export function recordRotation(db: Database.Database, sessionId: string): void {
  db.prepare(`UPDATE sessions SET resume_token = ?, resume_provenance = 'hook', resume_rotated_from = ?,
    resume_rotated_process = ?, resume_launch_process = ? WHERE id = ?`).run(rotatedToken, token,
    JSON.stringify(rotation.process), JSON.stringify({ ...rotation.process, token }), sessionId);
}

export function seat(over: { panes?: { id: string }[]; panePid?: (target: string, call: number) => number; managed?: boolean } = {}) {
  let rows = rowsWith();
  const calls: Record<string, number> = {};
  const listProcesses = vi.fn(async () => rows);
  const tmux = {
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "sh"),
    capturePaneContent: vi.fn(async () => autoScreen),
    getPanePid: vi.fn(async (target: string) => over.panePid?.(target, calls[target] = (calls[target] ?? 0) + 1) ?? 100),
    listPanes: vi.fn(async () => over.panes ?? [{ id: "%1" }]),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
  // A fresh adapter: the state after a daemon restart.
  const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {}, sessionIdFactory: () => token,
    claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`,
      assertCurrent: () => {}, configDir: "/fixture", executable: binary, executableIsScript: false }) } as never,
    fsOps: { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} } });
  return { adapter, tmux, listProcesses, set: (next: NativeProcessRow[]) => { rows = next; } };
}
