import { describe, expect, it } from "vitest";
import { BackgroundProcessEvidence } from "../src/domain/background-process-evidence.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readProcessTableCensusNow } from "../src/domain/process-table.js";

describe("background process evidence", () => {
  it.skipIf(process.platform !== "linux")("matches a task-owned live process through a simulated reparenting", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "ignore" });
    try {
      await once(child, "spawn");
      await new Promise(resolve => setTimeout(resolve, 2200));
      const { rows } = await readProcessTableCensusNow();
      const parent = rows.find(row => row.pid === process.pid);
      const worker = rows.find(row => row.pid === child.pid);
      expect(parent).toBeDefined();
      expect(worker?.ppid).toBe(process.pid);
      const evidence = new BackgroundProcessEvidence();
      evidence.capture("node", "gen", "session", "%1", process.pid, [parent!, worker!]);
      expect(evidence.afterLoss("node", "gen", "session", "%1", [{ ...worker!, ppid: 1 }]))
        .toMatchObject([{ pid: child.pid, startedAt: worker!.startedAt }]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
    }
  }, 10000);

  it("retains sampled descendants across reparenting, but not reused pids or another occupant", () => {
    const evidence = new BackgroundProcessEvidence();
    const root = { pid: 10, ppid: 1, command: "shell", startedAt: "2026-01-01T00:00:00Z" };
    const child = { pid: 11, ppid: 10, command: "/usr/bin/worker --token=private", startedAt: "2026-01-01T00:00:01Z" };
    const nested = { pid: 12, ppid: 11, command: "build", startedAt: "2026-01-01T00:00:02Z" };
    const neighbor = { pid: 13, ppid: 99, command: "other", startedAt: "2026-01-01T00:00:03Z" };
    evidence.capture("node", "gen-1", "session", "%1", 10, [root, child, nested, neighbor]);
    const now = [{ ...child, ppid: 1 }, { ...nested, ppid: 1 }, neighbor];
    // A later live-pane pass must not forget previously observed work just because it detached.
    evidence.capture("node", "gen-1", "session", "%1", 10, [root, ...now]);
    expect(evidence.afterLoss("node", "gen-1", "session", "%1", now)).toEqual([
      { pid: 11, command: "worker", startedAt: child.startedAt }, { pid: 12, command: "build", startedAt: nested.startedAt },
    ]);
    expect(JSON.stringify(evidence.afterLoss("node", "gen-1", "session", "%1", now))).not.toContain("private");
    expect(evidence.afterLoss("node", "gen-1", "session", "%1", [{ ...child, command: "/usr/bin/worker --token=changed" }])).toEqual([]);
    expect(evidence.afterLoss("node", "gen-2", "session", "%1", now)).toEqual([]);
    expect(evidence.afterLoss("node", "gen-1", "session", "%2", now)).toEqual([]);
    expect(evidence.afterLoss("node", "gen-1", "session", "%1", [{ ...child, startedAt: "new" }])).toEqual([]);
  });

  it("does not attribute an unreadable identity, zombie, or ambiguous process table", () => {
    const evidence = new BackgroundProcessEvidence();
    const root = { pid: 10, ppid: 1, command: "shell", startedAt: "t0" };
    const unreadable = { pid: 11, ppid: 10, command: "worker" };
    const zombie = { pid: 12, ppid: 10, command: "dead", startedAt: "t2", state: "Z" };
    evidence.capture("node", "gen", "session", "%1", 10, [root, unreadable, zombie]);
    expect(evidence.afterLoss("node", "gen", "session", "%1", [unreadable, zombie])).toEqual([]);
    evidence.capture("node", "gen", "session", "%1", 10, [root, root]);
    expect(evidence.afterLoss("node", "gen", "session", "%1", [root])).toEqual([]);
  });
});
