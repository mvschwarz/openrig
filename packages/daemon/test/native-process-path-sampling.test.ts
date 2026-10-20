import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { execute, paths } = vi.hoisted(() => ({ execute: vi.fn(), paths: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }) }));
vi.mock("../src/domain/native-process-executable.js", () => ({ readNativeExecutablePaths: paths }));
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";
import { restoreProc, serveFakeProc, type FakeProcess } from "./helpers/fake-proc.js";
const row = (pid: number, name: string, command: string): FakeProcess => ({ pid, ppid: 10, pgid: 11, tpgid: 11, name, startedAt: "Sun Oct  4 15:21:03 2026", command });
// The process table's two sources: ps off Linux, /proc on Linux.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const SOURCES = {
  ps: (rows: FakeProcess[]) => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    execute.mockResolvedValue({ stdout: "HEADER\n" + rows.map((r) => `${r.pid} ${r.ppid} ${r.pgid} ${r.tpgid} ${r.name} ${r.startedAt} ${r.command}`).join("\n") });
  },
  "/proc": (rows: FakeProcess[]) => { restoreProc(); serveFakeProc(rows); },
};
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { restoreProc(); Object.defineProperty(process, "platform", platform); });
describe.each(Object.entries(SOURCES))("from %s", (source, serve) => {
  afterEach(() => { if (source === "/proc") expect(execute).not.toHaveBeenCalled(); });
  it("batches only unresolved version-named Claude candidates; healthy seats need no extra subprocess", async () => {
    const healthy = [row(10, "zsh", "-zsh"), row(11, "claude", "claude"), row(12, "codex", "codex"), row(13, "2.1.289", "/x/.local/share/claude/versions/2.1.289"), row(14, "2.1.289", "unrelated")];
    serve(healthy);
    expect(await listNativeProcesses()).toHaveLength(5);
    expect(paths).not.toHaveBeenCalled();
    const unresolved = [row(15, "2.1.289", "claude --resume token"), row(16, "2.1.288", "/bin/claude")];
    serve([...healthy, ...unresolved]);
    paths.mockResolvedValue(new Map([[15, "/x/.local/share/claude/versions/2.1.289"]]));
    const rows = await listNativeProcesses();
    expect(paths).toHaveBeenCalledExactlyOnceWith([15, 16]);
    expect(rows.find(r => r.pid === 15)?.executablePath).toBe("/x/.local/share/claude/versions/2.1.289");
    expect(rows.find(r => r.pid === 16)?.executablePath).toBeUndefined();
  });
  it("reads the OS path of a script launch's Claude only on request, and only for foreground path-named rows", async () => {
    // What a #! wrapper that exec's the install leaves: the OS name and argv[0]'s basename are both `claude`.
    const installed = "/x/installs/claude/2.1.302/claude";
    serve([row(10, "zsh", "-zsh"), row(30, "claude", `${installed} --resume token`), row(31, "claude", "claude --resume token"),
      { ...row(32, "claude", `${installed} --resume other`), pgid: 99 }, row(33, "claude", "ugrep -G --hidden")]);
    paths.mockResolvedValue(new Map([[30, installed]]));
    // Today's lister, which every other caller uses: no read, so no subprocess on macOS for healthy native seats.
    expect((await listNativeProcesses()).find(r => r.pid === 30)?.executablePath).toBeUndefined();
    expect(paths).not.toHaveBeenCalled();
    const rows = await listNativeProcesses({ claudeLaunchPaths: true });
    expect(paths).toHaveBeenCalledExactlyOnceWith([30]);
    expect(rows.find(r => r.pid === 30)?.executablePath).toBe(installed);
    expect(rows.find(r => r.pid === 31)?.executablePath).toBeUndefined();
  });
  it("reads the OS path for a Nix-wrapped Claude whose ucomm is the truncated `.claude-unwrapped`", async () => {
    serve([row(20, ".claude-unwrapp", "claude --session-id token"), row(21, ".claude-wrapped", "/nix/store/x-claude-code-2.1.280/bin/claude"),
      row(22, ".claude-unwrapp", "ugrep -G --hidden"), row(23, ".node-unwrapped", "claude")]);
    paths.mockResolvedValue(new Map([[20, "/nix/store/x-claude-code-2.1.280/bin/.claude-unwrapped"]]));
    const rows = await listNativeProcesses();
    expect(paths).toHaveBeenCalledExactlyOnceWith([20, 21]);
    expect(rows.find(r => r.pid === 20)?.executablePath).toBe("/nix/store/x-claude-code-2.1.280/bin/.claude-unwrapped");
  });
});
