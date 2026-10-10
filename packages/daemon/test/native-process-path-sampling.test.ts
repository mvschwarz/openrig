import { beforeEach, expect, it, vi } from "vitest";
const { execute, paths } = vi.hoisted(() => ({ execute: vi.fn(), paths: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }) }));
vi.mock("../src/domain/native-process-executable.js", () => ({ readNativeExecutablePaths: paths }));
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";
const line = (pid: number, name: string, argv: string) => `${pid} 10 11 11 ${name} Sun Oct  4 15:21:03 2026 ${argv}`;
beforeEach(() => { vi.resetAllMocks(); });
it("batches only unresolved version-named Claude candidates; healthy seats need no extra subprocess", async () => {
  const healthy = [line(10, "zsh", "-zsh"), line(11, "claude", "claude"), line(12, "codex", "codex"), line(13, "2.1.289", "/x/.local/share/claude/versions/2.1.289"), line(14, "2.1.289", "unrelated")];
  execute.mockResolvedValue({ stdout: "HEADER\n" + healthy.join("\n") });
  expect(await listNativeProcesses()).toHaveLength(5);
  expect(paths).not.toHaveBeenCalled();
  const unresolved = [line(15, "2.1.289", "claude --resume token"), line(16, "2.1.288", "/bin/claude")];
  execute.mockResolvedValue({ stdout: "HEADER\n" + [...healthy, ...unresolved].join("\n") });
  paths.mockResolvedValue(new Map([[15, "/x/.local/share/claude/versions/2.1.289"]]));
  const rows = await listNativeProcesses();
  expect(paths).toHaveBeenCalledExactlyOnceWith([15, 16]);
  expect(rows.find(r => r.pid === 15)?.executablePath).toBe("/x/.local/share/claude/versions/2.1.289");
  expect(rows.find(r => r.pid === 16)?.executablePath).toBeUndefined();
});
it("reads the OS path for a Nix-wrapped Claude whose ucomm is the truncated `.claude-unwrapped`", async () => {
  const listed = [line(20, ".claude-unwrapp", "claude --session-id token"), line(21, ".claude-wrapped", "/nix/store/x-claude-code-2.1.280/bin/claude"),
    line(22, ".claude-unwrapp", "ugrep -G --hidden"), line(23, ".node-unwrapped", "claude")];
  execute.mockResolvedValue({ stdout: "HEADER\n" + listed.join("\n") });
  paths.mockResolvedValue(new Map([[20, "/nix/store/x-claude-code-2.1.280/bin/.claude-unwrapped"]]));
  const rows = await listNativeProcesses();
  expect(paths).toHaveBeenCalledExactlyOnceWith([20, 21]);
  expect(rows.find(r => r.pid === 20)?.executablePath).toBe("/nix/store/x-claude-code-2.1.280/bin/.claude-unwrapped");
});
