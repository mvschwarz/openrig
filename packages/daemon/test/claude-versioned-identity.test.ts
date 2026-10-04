import { expect, it, vi } from "vitest";
import { verifyClaudePaneProcess, verifyClaudePaneRuntime, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
const path = "/fixture/.local/share/claude/versions/2.1.289";
const startedAt = "Sun Oct  4 15:21:03 2026";
function rows(): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "2.1.289", executablePath: path, command: "claude --session-id token --effort high", startedAt },
  ];
}
const input = (listProcesses: () => NativeProcessRow[]) => ({ target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses, expectedToken: "token", requireResume: true });
it("#273 joins versioned OS name with rewritten Claude argv using the OS path", async () => {
  expect((await verifyClaudePaneProcess(input(rows)))?.process.pid).toBe(12);
  expect((await verifyClaudePaneProcess({ ...input(rows), selectedExecutable: path }))?.process.pid).toBe(12);
  expect(await verifyClaudePaneProcess({ ...input(rows), selectedExecutable: "/elsewhere/2.1.289" })).toBeNull();
});
it("#273 tokenless runtime identity is not exact conversation proof", async () => {
  const fresh = () => rows().map(r => r.pid === 12 ? { ...r, command: "claude --name worker@rig" } : r);
  expect((await verifyClaudePaneRuntime(input(fresh)))?.process.pid).toBe(12);
  expect(await verifyClaudePaneProcess(input(fresh))).toBeNull();
});
const cases: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
  ["unavailable path", r => r.map(x => ({ ...x, executablePath: undefined }))],
  ["unrelated versioned executable", r => r.map(x => ({ ...x, executablePath: "/unrelated/2.1.289" }))],
  ["different version", r => r.map(x => ({ ...x, executablePath: path.replace("289", "288") }))],
  ["relative path", r => r.map(x => ({ ...x, executablePath: path.slice(1) }))],
  ["traversal path", r => r.map(x => ({ ...x, executablePath: "/unrelated/../" + path.slice(1) }))],
  ["version only argv", r => r.map(x => x.pid === 12 ? { ...x, command: "2.1.289 --session-id token" } : x)],
  ["missing token", r => r.map(x => x.pid === 12 ? { ...x, command: "claude" } : x)],
  ["wrong token", r => r.map(x => x.pid === 12 ? { ...x, command: "claude --resume wrong" } : x)],
  ["fork", r => r.map(x => x.pid === 12 ? { ...x, command: "claude --resume token --fork-session" } : x)],
  ["ambiguous", r => [...r, { ...r[2]!, pid: 13 }]],
  ["background", r => r.map(x => x.pid === 12 ? { ...x, pgid: 88 } : x)],
  ["missing ancestry", r => r.filter(x => x.pid !== 11)],
  ["missing start", r => r.map(x => ({ ...x, startedAt: undefined }))],
];
it.each(cases)("#273 retains strict refusal: %s", async (_name, mutate) => {
  expect(await verifyClaudePaneProcess(input(() => mutate(rows())))).toBeNull();
});
it.each(["executablePath", "startedAt", "pid"] as const)("#273 rejects changed %s between samples", async field => {
  const changed = rows().map(r => r.pid === 12 ? { ...r, [field]: field === "executablePath" ? path.replace("fixture", "other") : field === "pid" ? 13 : startedAt.replace("03", "04") } : r);
  expect(await verifyClaudePaneProcess(input(vi.fn().mockReturnValueOnce(rows()).mockReturnValueOnce(changed)))).toBeNull();
});
