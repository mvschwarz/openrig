import { describe, expect, it } from "vitest";
import { BackgroundProcessEvidence } from "../src/domain/background-process-evidence.js";

describe("background process evidence", () => {
  it("retains sampled descendants across reparenting, but not reused pids or another occupant", () => {
    const evidence = new BackgroundProcessEvidence();
    const root = { pid: 10, ppid: 1, command: "shell", startedAt: "t0" };
    const child = { pid: 11, ppid: 10, command: "worker", startedAt: "t1" };
    const nested = { pid: 12, ppid: 11, command: "build", startedAt: "t2" };
    const neighbor = { pid: 13, ppid: 99, command: "other", startedAt: "t3" };
    evidence.capture("node", "gen-1", "session", "%1", 10, [root, child, nested, neighbor]);
    const now = [{ ...child, ppid: 1 }, { ...nested, ppid: 1 }, neighbor];
    expect(evidence.afterLoss("node", "gen-1", "session", "%1", now)).toEqual([
      { pid: 11, command: "worker", startedAt: "t1" }, { pid: 12, command: "build", startedAt: "t2" },
    ]);
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
