import { vi } from "vitest";

/** #1524 (b): what a genuine managed Codex resume of `token` looks like to the adapter's resume proof: the pane's one
 *  Codex process resuming `token`, and Codex's own records for that process naming `token`. Pass `getPanePid` to the
 *  tmux mock and the other two to the CodexRuntimeAdapter. */
export function provenCodexResume(token: string, opts: { panePid?: number; codexPid?: number; startedAt?: string } = {}) {
  const panePid = opts.panePid ?? 900;
  const codexPid = opts.codexPid ?? 901;
  const startedAt = opts.startedAt ?? "Tue Oct 20 05:00:01 2026";
  const codex = { pid: codexPid, ppid: panePid, command: `codex resume ${token}`, argv: ["codex", "resume", token],
    pgid: codexPid, tpgid: codexPid, executableName: "codex", startedAt };
  return {
    getPanePid: vi.fn(async () => panePid),
    listProcesses: () => panePid === codexPid ? [{ ...codex, ppid: 1 }] : [
      { pid: panePid, ppid: 1, command: "-zsh", pgid: panePid, tpgid: codexPid, executableName: "zsh", startedAt: "Tue Oct 20 04:59:00 2026" },
      codex,
    ],
    readResumeEvidence: vi.fn(() => ({ threadId: token })),
  };
}
