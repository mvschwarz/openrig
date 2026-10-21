import { describe, expect, it } from "vitest";
import { explainNativeRejection, observeClaudePaneProcess, observeCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

// `explainNativeRejection` words a failed check, so it must agree with the check itself: it says "passes"
// exactly when the observer that applies `selectNativeProcess` returns a process.
const startedAt = "Fri Oct  2 20:00:00 2026";
const A = "a5ddbaea-05cf-4723-8a52-4a9f0087b9d4";
const B = "cda8d870-0478-45df-9aa5-ce029845711c";
const shell: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, command: "/bin/sh /tmp/launch.sh", executableName: "sh", startedAt };
const claude = (args: string, pid = 101): NativeProcessRow => ({ pid, ppid: 100, pgid: 100, tpgid: 100, executableName: "2.1.1", startedAt, command: `/home/u/.local/share/claude/versions/2.1.1 ${args}`.trim() });
const codex = (args: string, pid = 101, ppid = 100): NativeProcessRow => ({ pid, ppid, pgid: 100, tpgid: 100, executableName: "codex", startedAt, command: `codex ${args}`.trim() });
const tmux = { getPanePid: async () => 100 };

describe("explainNativeRejection agrees with the process check", () => {
  const rotation = (pid: number) => ({ token: B, process: { pid, startedAt } });
  const codexCases: [string, NativeProcessRow[], string | null, boolean][] = [
    ["resume A", [shell, codex(`resume ${A}`)], A, false],
    ["resume A strict", [shell, codex(`resume ${A}`)], A, true],
    ["resume B", [shell, codex(`resume ${B}`)], A, false],
    ["resume B strict", [shell, codex(`resume ${B}`)], A, true],
    ["fresh", [shell, codex("-C /p")], A, false],
    ["fresh strict", [shell, codex("-C /p")], A, true],
    ["resume --last", [shell, codex("resume --last")], A, false],
    ["resume --last, no token", [shell, codex("resume --last")], null, false],
    ["resume A, no token", [shell, codex(`resume ${A}`)], null, false],
    ["resume A, no token, strict", [shell, codex(`resume ${A}`)], null, true],
    ["fresh, no token", [shell, codex("-C /p")], null, false],
    ["chain: outer B, inner fresh", [shell, codex(`resume ${B}`), codex("-C /p", 102, 101)], A, false],
    ["chain: outer A, inner A", [shell, codex(`resume ${A}`), codex(`resume ${A}`, 102, 101)], A, true],
    ["chain: A and B", [shell, codex(`resume ${A}`), codex(`resume ${B}`, 102, 101)], A, false],
    ["no codex", [shell], A, false],
  ];
  it.each(codexCases)("codex: %s", async (_name, rows, token, requireResume) => {
    const observed = await observeCodexPaneProcess({ target: "%1", tmux, listProcesses: () => rows, expectedToken: token, requireResume });
    expect(explainNativeRejection(rows, 100, "codex", token, requireResume).kind === "passes").toBe(observed !== null);
  });
  const claudeCases: [string, NativeProcessRow[], string | null, ReturnType<typeof rotation> | null][] = [
    ["session A", [shell, claude(`--session-id ${A}`)], A, null],
    ["session B", [shell, claude(`--session-id ${B}`)], A, null],
    ["names none", [shell, claude("")], A, null],
    ["no token", [shell, claude(`--session-id ${A}`)], null, null],
    ["rotation, recorded process", [shell, claude(`--resume ${B}`)], A, rotation(101)],
    ["rotation, other process", [shell, claude(`--resume ${B}`)], A, rotation(999)],
    ["two claudes", [shell, claude(`--session-id ${A}`), claude(`--session-id ${A}`, 102)], A, null],
    ["no claude", [shell], A, null],
  ];
  it.each(claudeCases)("claude: %s", async (_name, rows, token, rot) => {
    const observed = await observeClaudePaneProcess({ target: "%1", tmux, listProcesses: () => rows, expectedToken: token, rotation: rot });
    expect(explainNativeRejection(rows, 100, "claude-code", token, false, rot).kind === "passes").toBe(observed !== null);
  });
});
