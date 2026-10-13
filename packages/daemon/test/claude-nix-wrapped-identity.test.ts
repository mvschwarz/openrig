import { expect, it } from "vitest";
import { observeClaudeDelivery, verifyClaudePaneProcess, verifyClaudePaneRuntime, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
// Rows as `ps -Ao pid,ppid,pgid,tpgid,ucomm,lstart,command` reports a NixOS seat: the
// claude-code package is a makeCWrapper (`--inherit-argv0`) that execs its sibling
// `.claude-unwrapped`, so ucomm is that name truncated to 15 bytes and argv[0] is `claude`.
const store = "/nix/store/6gsgll38snbxizg97jfykgc206m9nily-claude-code-2.1.280/bin";
const wrapper = `${store}/claude`;
const path = `${store}/.claude-unwrapped`;
const startedAt = "Thu Oct  8 17:48:34 2026";
const token = "9bab03df-f6e6-4ed3-8f3d-9a9efa3a79cc";
function rows(argv0 = "claude"): NativeProcessRow[] {
  return [
    { pid: 538586, ppid: 538585, pgid: 538586, tpgid: 538612, executableName: "bash", command: "-bash", startedAt },
    { pid: 538612, ppid: 538586, pgid: 538612, tpgid: 538612, executableName: "bash", command: "-bash", startedAt },
    { pid: 538614, ppid: 538612, pgid: 538612, tpgid: 538612, executableName: ".claude-unwrapp", executablePath: path,
      command: `${argv0} --permission-mode acceptEdits --settings {"permissions":{"allow":["Skill","Read"]}} --session-id ${token} --name seat@rig`, startedAt },
  ];
}
const input = (listProcesses: () => NativeProcessRow[]) => ({ target: "%0", tmux: { getPanePid: async () => 538586 }, listProcesses, expectedToken: token });

it.each(["claude", wrapper])("joins a Nix-wrapped Claude (argv0 %s) to its unwrapped OS executable", async argv0 => {
  const list = () => rows(argv0);
  expect((await verifyClaudePaneProcess(input(list)))?.process.pid).toBe(538614);
  expect((await verifyClaudePaneRuntime(input(list)))?.process.pid).toBe(538614);
  expect((await observeClaudeDelivery(input(list))).state).toBe("verified");
  // A managed launch freezes the wrapper's realpath; its own unwrapped sibling is that launch.
  expect((await verifyClaudePaneProcess({ ...input(list), selectedExecutable: wrapper }))?.process.pid).toBe(538614);
});
it("accepts the wrapProgram `.claude-wrapped` spelling, which fits ucomm untruncated", async () => {
  const list = () => rows().map(r => r.pid === 538614 ? { ...r, executableName: ".claude-wrapped", executablePath: `${store}/.claude-wrapped` } : r);
  expect((await verifyClaudePaneProcess(input(list)))?.process.pid).toBe(538614);
});

const other = "/nix/store/0bi0qdpi7da0iqisvqgci7djgxlrmzyr-python3-3.13.15-env/bin";
const native = (patch: Partial<NativeProcessRow>) => (r: NativeProcessRow[]) => r.map(x => x.pid === 538614 ? { ...x, ...patch } : x);
const cases: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
  ["unavailable path", native({ executablePath: undefined })],
  ["unwrapped name outside a claude-code store path", native({ executablePath: `${other}/.claude-unwrapped` })],
  ["claude-code store path, different wrapped program", native({ executablePath: `${store}/.node-unwrapped` })],
  ["truncated name disagrees with the path", native({ executablePath: `${store}/.claude-wrapped` })],
  ["unrelated truncated OS name", native({ executableName: ".claude-unwrapx" })],
  ["relative path", native({ executablePath: path.slice(1) })],
  ["traversal path", native({ executablePath: `${other}/../../6gsgll38snbxizg97jfykgc206m9nily-claude-code-2.1.280/bin/.claude-unwrapped` })],
  // Claude's own embedded helpers keep its OS name but are not the seat runtime.
  ["Claude helper with a different argv0", native({ command: `ugrep -G --hidden --session-id ${token}` })],
  ["non-Claude argv0 in a wrapped process", native({ command: `/bin/echo claude --session-id ${token}` })],
  ["wrong token", native({ command: "claude --session-id other" })],
  ["missing token", native({ command: "claude --name seat@rig" })],
  ["background", native({ pgid: 88 })],
  ["ambiguous", r => [...r, { ...r[2]!, pid: 538615 }]],
];
it.each(cases)("retains strict refusal for a Nix-wrapped Claude: %s", async (_name, mutate) => {
  expect(await verifyClaudePaneProcess(input(() => mutate(rows())))).toBeNull();
});
it("a different launch's wrapper does not prove this unwrapped executable", async () => {
  const elsewhere = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-claude-code-2.1.281/bin/claude";
  expect(await verifyClaudePaneProcess({ ...input(() => rows()), selectedExecutable: elsewhere })).toBeNull();
  expect(await verifyClaudePaneProcess({ ...input(() => rows(wrapper)), selectedExecutable: elsewhere })).toBeNull();
});
