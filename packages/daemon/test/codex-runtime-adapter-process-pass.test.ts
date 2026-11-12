// #161 — the shared observation pass at its PRODUCTION boundary: the adapter's default lister over the real
// listNativeProcesses path, with only the OS process-table read replaced. A failed enumeration must not be cached
// as an empty (successful) table and handed to the next seat.
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessTableRow } from "../src/domain/process-table.js";

const osTable = vi.hoisted(() => ({ read: vi.fn<() => Promise<unknown[]>>() }));
vi.mock("../src/domain/process-table.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/domain/process-table.js")>()),
  readProcessTable: () => osTable.read(),
}));

import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { ObservationPass } from "../src/domain/process-observation-pass.js";
import { listNativeProcesses, listNativeProcessesOrThrow } from "../src/domain/native-process-lineage.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";

const startedAt = "Sat Jan  1 12:00:00 2000";
const paneContent = fs.readFileSync(new URL("./fixtures/codex-api-key-login-no-daemon.txt", import.meta.url), "utf8");

/** Three idle-shell panes: the OS table is the same on every read. */
const idleTable = (): ProcessTableRow[] => [900, 910, 920].map((pid) => (
  { pid, ppid: 1, pgid: pid, tpgid: pid, executableName: "bash", command: "/bin/bash", startedAt }));

function tmuxFor(pid: number): TmuxAdapter {
  return mockShellCommand({
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "bash"),
    getPanePid: vi.fn(async () => pid),
    capturePaneContent: vi.fn(async () => paneContent),
  } as unknown as TmuxAdapter);
}

const fsOps = { readFile: () => { throw new Error("none"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] } as unknown as CodexAdapterFsOps;
const binding: NodeBinding = { id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project" };

/** checkReady for each seat in turn through one pass, on the adapter's DEFAULT lister. */
async function pollThreeSeats() {
  const pass = new ObservationPass();
  const outcomes: string[] = [];
  for (const pid of [900, 910, 920]) {
    const result = await new CodexRuntimeAdapter({ tmux: tmuxFor(pid), fsOps }).checkReady(binding, { observationPass: pass });
    outcomes.push("code" in result && result.code ? String(result.code) : result.ready ? "ready" : "not-ready");
  }
  return outcomes;
}

describe("the shared pass at the production process listing (#161)", () => {
  beforeEach(() => { osTable.read.mockReset(); });

  it("the strict listing rejects on a failed enumeration; the lenient one keeps reading it as an empty table", async () => {
    osTable.read.mockRejectedValue(new Error("ps ENOMEM"));
    await expect(listNativeProcessesOrThrow()).rejects.toThrow("ps ENOMEM");
    expect(await listNativeProcesses()).toEqual([]);
    osTable.read.mockResolvedValue([]);
    expect(await listNativeProcessesOrThrow()).toEqual([]);
  });

  it("a legitimately empty table is a success: it is shared, not retried", async () => {
    osTable.read.mockResolvedValue([]);
    const outcomes = await pollThreeSeats();
    // The idle-shell proof's two steps shared by three seats in turn: each later seat starts from the latest table
    // and takes one new read after its own first check began, so one read more than seats.
    expect(osTable.read).toHaveBeenCalledTimes(4);
    expect(outcomes).toHaveLength(3);
  });

  // Whichever of the poll's reads fails, the seats must reach the results of a poll with no failure: a failed read
  // is retried by the seat that waited on it, never cached as an empty table for the next seat.
  it.each([1, 2, 3, 4])("one failed OS read (read #%i) does not leave an empty table for the other seats", async (failing) => {
    osTable.read.mockImplementation(async () => idleTable());
    const healthy = await pollThreeSeats();
    expect(healthy).toEqual(["returned_to_shell", "returned_to_shell", "returned_to_shell"]);

    osTable.read.mockReset();
    let reads = 0;
    osTable.read.mockImplementation(async () => {
      if (++reads === failing) throw new Error("ps ENOMEM");
      return idleTable();
    });
    expect(await pollThreeSeats()).toEqual(healthy);
    // The failed read was retried by a seat that waited on it, so more than the healthy four reads happened.
    expect(reads).toBeGreaterThan(4);
  });

  it("a failing OS table is never read as an idle shell or a ready seat, for any seat", async () => {
    osTable.read.mockRejectedValue(new Error("ps ENOMEM"));
    const outcomes = await pollThreeSeats();
    expect(outcomes.every((code) => code !== "returned_to_shell" && code !== "ready")).toBe(true);
    // Every seat took its own read after the shared one failed: none was handed a cached failure or empty table.
    expect(osTable.read.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
