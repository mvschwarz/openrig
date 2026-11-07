import { beforeEach, expect, it, vi } from "vitest";
import type { ProcessTableRow } from "../src/domain/process-table.js";

const { table, paths, argv } = vi.hoisted(() => ({ table: vi.fn(), paths: vi.fn(), argv: vi.fn() }));
vi.mock("../src/domain/process-table.js", () => ({ readProcessTable: table }));
vi.mock("../src/domain/native-process-executable.js", () => ({ readNativeExecutablePaths: paths }));
vi.mock("../src/domain/native-process-arguments.js", () => ({ readNativeProcessArguments: argv }));
import { verifyPaneIdleShell } from "../src/domain/native-process-lineage.js";

const shell: ProcessTableRow = {
  pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "zsh", command: "-zsh", startedAt: "first start",
};
// Both would trigger enrichment on macOS, but neither belongs to the target foreground.
const unrelated = [
  { ...shell, pid: 20, pgid: 20, tpgid: 20, executableName: "2.1.289", command: "claude --resume other" },
  { ...shell, pid: 30, pgid: 30, tpgid: 30, executableName: "codex", command: "codex resume other" },
];
const input = { target: "%1", tmux: { getPanePid: async () => 10 } };
beforeEach(() => {
  vi.resetAllMocks();
  paths.mockResolvedValue(new Map());
  argv.mockResolvedValue(new Map());
});

it("proves an idle shell from two fresh tables without enriching unrelated processes", async () => {
  table.mockResolvedValueOnce([shell, ...unrelated]).mockResolvedValueOnce([{ ...shell }, ...unrelated]);
  expect(await verifyPaneIdleShell(input)).toBe(true);
  expect(table).toHaveBeenCalledTimes(2);
  expect(paths).not.toHaveBeenCalled();
  expect(argv).not.toHaveBeenCalled();
});

it.each([
  ["reused pane PID", [{ ...shell, startedAt: "second start" }]],
  ["changed foreground", [{ ...shell, tpgid: 11 }]],
  ["foreground process outside the pane subtree", [shell, { ...shell, pid: 11, ppid: 1, executableName: "vim", command: "vim" }]],
  ["duplicate PID", [shell, { ...shell }]],
  ["missing pane", []],
])("refuses idle proof after %s", async (_reason, second) => {
  table.mockResolvedValueOnce([shell]).mockResolvedValueOnce(second);
  expect(await verifyPaneIdleShell(input)).toBe(false);
  expect(table).toHaveBeenCalledTimes(2);
});

it.each([1, 2])("refuses idle proof when table sample %i fails", async failingSample => {
  if (failingSample === 2) table.mockResolvedValueOnce([shell]);
  table.mockRejectedValueOnce(new Error("process table unavailable"));
  expect(await verifyPaneIdleShell(input)).toBe(false);
  expect(table).toHaveBeenCalledTimes(failingSample);
});

it("retains the injected lister and its two-sample proof", async () => {
  const listProcesses = vi.fn().mockResolvedValue([shell]);
  expect(await verifyPaneIdleShell({ ...input, listProcesses })).toBe(true);
  expect(listProcesses).toHaveBeenCalledTimes(2);
  expect(table).not.toHaveBeenCalled();
});
