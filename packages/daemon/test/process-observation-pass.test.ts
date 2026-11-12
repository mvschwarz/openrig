// #161 — agents checked in one poll share process listings, and each agent still gets what its own checks need:
// two distinct observations, the freshness limit, and a failed read that is never read as success.
import { describe, expect, it, vi } from "vitest";
import { ObservationPass } from "../src/domain/process-observation-pass.js";
import { verifyCodexPaneProcess, verifyPaneIdleShell, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

type Row = { pid: number };
const table = (n: number): Row[] => [{ pid: n }];

describe("ObservationPass", () => {
  it("shares a listing between agents one after another, and gives each agent two different tables, the second taken after its first check began", async () => {
    let n = 0;
    const base = vi.fn(async () => table(++n));
    const pass = new ObservationPass({ now: () => 0 });
    const a = pass.lister(base);
    const b = pass.lister(base);
    const seenA = [await a(), await a()];
    const seenB = [await b(), await b()];
    expect(base).toHaveBeenCalledTimes(3);
    expect(seenA).toEqual([[{ pid: 1 }], [{ pid: 2 }]]);
    // B starts from A's latest table and takes its second observation after its own first check began.
    expect(seenB).toEqual([[{ pid: 2 }], [{ pid: 3 }]]);
  });

  it("agents checked at the same time share one in-flight listing per step", async () => {
    let n = 0;
    const base = vi.fn(async () => { await Promise.resolve(); return table(++n); });
    const pass = new ObservationPass({ now: () => 0 });
    const agents = [pass.lister(base), pass.lister(base), pass.lister(base)];
    const first = await Promise.all(agents.map((list) => list()));
    const second = await Promise.all(agents.map((list) => list()));
    expect(base).toHaveBeenCalledTimes(2);
    expect(first.every((rows) => rows[0]!.pid === 1)).toBe(true);
    expect(second.every((rows) => rows[0]!.pid === 2)).toBe(true);
  });

  it("never reuses a listing older than the freshness limit", async () => {
    let t = 0;
    let n = 0;
    const base = vi.fn(async () => table(++n));
    const pass = new ObservationPass({ freshnessMs: 1000, now: () => t });
    await pass.lister(base)();
    t = 1001;
    expect(await pass.lister(base)()).toEqual([{ pid: 2 }]);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("a new pass starts with its own listing", async () => {
    const base = vi.fn(async () => table(1));
    await new ObservationPass({ now: () => 0 }).lister(base)();
    await new ObservationPass({ now: () => 0 }).lister(base)();
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("keeps listings from different listers apart", async () => {
    const one = vi.fn(async () => table(1));
    const two = vi.fn(async () => table(2));
    const pass = new ObservationPass({ now: () => 0 });
    expect(await pass.lister(one)()).toEqual(table(1));
    expect(await pass.lister(two)()).toEqual(table(2));
  });

  it("a failed shared listing is never reused: each waiting agent reads for itself", async () => {
    let calls = 0;
    const base = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ps ENOMEM");
      return table(calls);
    });
    const pass = new ObservationPass({ now: () => 0 });
    const [a, b] = [pass.lister(base), pass.lister(base)];
    const [ra, rb] = await Promise.all([a(), b()]);
    // The shared read failed once; both agents then read for themselves instead of seeing a failure as an empty table.
    expect(ra).not.toEqual([]);
    expect(rb).not.toEqual([]);
    expect(base).toHaveBeenCalledTimes(3);
    // The failed read left nothing behind for the next agent to reuse.
    expect(await pass.lister(base)()).toEqual(table(4));
  });

  it("after a failed shared listing each agent reads through its own fallback lister, not the shared one", async () => {
    const shared = vi.fn(async (): Promise<Row[]> => { throw new Error("ps ENOMEM"); });
    const own = vi.fn(async () => table(7));
    const pass = new ObservationPass({ now: () => 0 });
    expect(await pass.lister(shared, own)()).toEqual(table(7));
    expect(await pass.lister(shared, own)()).toEqual(table(7));
    expect(shared).toHaveBeenCalledTimes(2);
    expect(own).toHaveBeenCalledTimes(2);
  });

  it("an agent whose own fallback read also fails fails: the failure is not turned into a table", async () => {
    const base = vi.fn(async (): Promise<Row[]> => { throw new Error("ps ENOMEM"); });
    const list = new ObservationPass({ now: () => 0 }).lister(base);
    await expect(list()).rejects.toThrow("ps ENOMEM");
    expect(base).toHaveBeenCalledTimes(2);
  });
});

describe("agent checks through a pass match the same checks read agent by agent", () => {
  const token = (i: number) => `00000000-0000-7000-8000-00000000000${i}`;
  const startedAt = "Sat Jan  1 12:00:00 2000";
  // Agent i has a shell (pid 10*i) with a Codex child (pid 10*i+3) that resumed token i.
  const agentRows = (i: number, child = 10 * i + 3): NativeProcessRow[] => [
    { pid: 10 * i, ppid: 1, pgid: 10 * i, tpgid: 10 * i + 1, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 10 * i + 1, ppid: 10 * i, pgid: 10 * i + 1, tpgid: 10 * i + 1, executableName: "bash", command: "/bin/sh /tmp/send", startedAt },
    { pid: child, ppid: 10 * i + 1, pgid: 10 * i + 1, tpgid: 10 * i + 1, executableName: "codex",
      command: `/opt/native/codex resume ${token(i)}`, argv: ["/opt/native/codex", "resume", token(i)], startedAt },
  ];
  // Observation 1 (odd calls) and observation 2 (even calls) of every agent: agent 3's Codex is replaced between
  // them (same shell, new child pid), agent 2 is steady, agent 1 steady.
  const tableFor = (call: number): NativeProcessRow[] => [
    ...agentRows(1), ...agentRows(2), ...agentRows(3, call % 2 === 1 ? 33 : 34),
  ];
  const run = async (viaPass: boolean) => {
    let calls = 0;
    const base = vi.fn(async () => tableFor(++calls));
    const pass = new ObservationPass({ now: () => 0 });
    const results: Array<NativeProcessRow["pid"] | null> = [];
    for (const i of [1, 2, 3]) {
      const listProcesses = viaPass ? pass.lister(base) : base;
      const seen = await verifyCodexPaneProcess({ target: `%${i}`, tmux: { getPanePid: async () => 10 * i },
        listProcesses, expectedToken: token(i), requireResume: true });
      results.push(seen ? seen.process.pid : null);
    }
    return { results, listings: base.mock.calls.length };
  };

  it("gives the same per-agent results with fewer listings (one more than agents), and refuses the replaced process", async () => {
    const perAgent = await run(false);
    const shared = await run(true);
    expect(shared.results).toEqual(perAgent.results);
    expect(shared.results).toEqual([13, 23, null]);
    expect(perAgent.listings).toBe(6);
    // Each later agent starts from the latest table and takes one new listing after its first check began.
    expect(shared.listings).toBe(4);
  });

  it("an idle-shell proof needs two different listings even when other agents share them", async () => {
    let calls = 0;
    const idle = (call: number): NativeProcessRow[] => [
      { pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "zsh", command: "-zsh", startedAt },
      // Between the two observations a command takes the foreground of agent 2's pane.
      { pid: 20, ppid: 1, pgid: 20, tpgid: call % 2 === 0 ? 21 : 20, executableName: "zsh", command: "-zsh", startedAt },
      ...(call % 2 === 0 ? [{ pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "make", command: "make", startedAt }] : []),
    ];
    const base = vi.fn(async () => idle(++calls));
    const pass = new ObservationPass({ now: () => 0 });
    const results = [];
    for (const pane of [10, 20]) {
      results.push(await verifyPaneIdleShell({ target: `%${pane}`, tmux: { getPanePid: async () => pane }, listProcesses: pass.lister(base) }));
    }
    expect(results).toEqual([true, false]);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("a later agent's second observation is taken after its first, even when earlier agents cached two tables", async () => {
    // Agents 1 and 2 both have a shell with a Codex child. Agent 1's two checks make the first two listings,
    // which include agent 2's Codex. Then agent 2's Codex exits (same shell pid) and agent 2 is checked inside
    // the freshness window: it must not pass on the two cached tables, it must see the idle shell.
    let calls = 0;
    const codexGone = (call: number) => call > 2;
    const tableAt = (call: number): NativeProcessRow[] => [
      ...agentRows(1),
      ...agentRows(2).filter((row) => !(codexGone(call) && row.executableName === "codex")),
    ];
    const base = vi.fn(async () => tableAt(++calls));
    const pass = new ObservationPass({ now: () => 0 });
    const check = (i: number) => verifyCodexPaneProcess({ target: `%${i}`, tmux: { getPanePid: async () => 10 * i },
      listProcesses: pass.lister(base), expectedToken: token(i), requireResume: true });
    expect((await check(1))?.process.pid).toBe(13);
    expect(await check(2)).toBeNull();
    // Agent 1's two listings, then one new listing for agent 2's second observation; agent 2's first reuses agent 1's latest.
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("a failed listing is not read as an idle shell or as a gone process", async () => {
    const base = vi.fn(async (): Promise<NativeProcessRow[]> => { throw new Error("ps ENOMEM"); });
    const pass = new ObservationPass({ now: () => 0 });
    expect(await verifyPaneIdleShell({ target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: pass.lister(base) })).toBe(false);
    expect(await verifyCodexPaneProcess({ target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: pass.lister(base) })).toBeNull();
  });
});
