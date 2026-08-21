// D-a — record-liveness selection: NO single pointer (sidecar / registry / pane argument) is
// generation-true — both directions were measured live in one night (B16: sidecar stale, argument
// right; D-a specimen: argument stale, sidecar right). The transcript being WRITTEN is the truth.

import { describe, it, expect } from "vitest";
import {
  paneClaudeSessionIdArgument,
  LiveClaudeRecordSelector,
  resolveLiveCodexThreadId,
  type ProcessRow,
} from "../src/domain/model-divergence/current-generation-record.js";

const TABLE: ProcessRow[] = [
  { pid: 10, ppid: 1, command: "-zsh" },
  { pid: 20, ppid: 10, command: "claude --permission-mode acceptEdits --session-id daaeb7b4-841b-45cb-8a33-b062e0ce8296 --name dev-planner@r" },
  { pid: 30, ppid: 10, command: "/usr/local/bin/codex --yolo resume 019f6343-aaaa-bbbb-cccc-ddddeeeeffff" },
  { pid: 40, ppid: 20, command: "node some-child" },
];

const deps = {
  getPanePid: async () => 10,
  listProcesses: async () => TABLE,
  readThreadIdByPid: (pid: number) => (pid === 30 ? "thread-live-123" : undefined),
};

describe("paneClaudeSessionIdArgument (a CANDIDATE source, never the answer alone)", () => {
  it("reads the launch-argument session uuid (the specimen shape)", async () => {
    const out = await paneClaudeSessionIdArgument("dev-planner@r", deps);
    expect(out).toEqual({ ok: true, id: "daaeb7b4-841b-45cb-8a33-b062e0ce8296" });
  });

  it("no pane pid / no claude process / no id argument each yield a NAMED reason, never a silent null", async () => {
    const none = await paneClaudeSessionIdArgument("s", { ...deps, getPanePid: async () => null });
    expect(!none.ok && none.reason).toContain("no live pane pid");
    const noClaude = await paneClaudeSessionIdArgument("s", { ...deps, listProcesses: async () => [{ pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noClaude.ok && noClaude.reason).toContain("no claude process");
    const noArg = await paneClaudeSessionIdArgument("s", { ...deps, listProcesses: async () => [{ pid: 20, ppid: 10, command: "claude --name x" }, { pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noArg.ok && noArg.reason).toContain("no --session-id/--resume argument");
  });
});

describe("LiveClaudeRecordSelector — CROSS-POLL advancement, stateful per seat (r2 round-4)", () => {
  const A = "/p/a.jsonl"; const B = "/p/b.jsonl";
  function statFn(table: Record<string, [number, number] | null>) {
    return (path: string) => {
      const v = table[path] ?? null;
      return v ? { mtimeMs: v[0], size: v[1] } : null;
    };
  }
  const CAND = [
    { source: "sidecar", id: "id-a", path: A },
    { source: "pane-argument", id: "id-b", path: B },
  ];

  it("r2 round-4 discriminator: advancement observed on one poll is NOT forgotten — the selection RETAINS across idle polls", () => {
    const sel = new LiveClaudeRecordSelector();
    // poll 1: first observation of a disagreeing set → INDETERMINATE by construction, named.
    const p1 = sel.select("seat", CAND, statFn({ [A]: [1000, 100], [B]: [2000, 900] }));
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.reason).toContain("first observation");
    // poll 2: id-a advanced across the FULL poll interval (any intervening write counts).
    const p2 = sel.select("seat", CAND, statFn({ [A]: [5000, 150], [B]: [2000, 900] }));
    expect(p2).toMatchObject({ ok: true, id: "id-a" });
    // poll 3: everything idle — the resolved generation is RETAINED, not re-litigated.
    const p3 = sel.select("seat", CAND, statFn({ [A]: [5000, 150], [B]: [2000, 900] }));
    expect(p3).toMatchObject({ ok: true, id: "id-a" });
  });

  it("the retained selection DROPS when the candidate id set changes (a new generation appears)", () => {
    const sel = new LiveClaudeRecordSelector();
    sel.select("seat", CAND, statFn({ [A]: [1000, 100], [B]: [2000, 900] }));
    const resolved = sel.select("seat", CAND, statFn({ [A]: [5000, 150], [B]: [2000, 900] }));
    expect(resolved.ok).toBe(true);
    const NEW = [...CAND, { source: "registry", id: "id-c", path: "/p/c.jsonl" }];
    const afterChange = sel.select("seat", NEW, statFn({ [A]: [5000, 150], [B]: [2000, 900], "/p/c.jsonl": [9000, 10] }));
    expect(afterChange.ok).toBe(false); // fresh set → first observation again
    if (!afterChange.ok) expect(afterChange.reason).toContain("first observation");
  });

  it("neither advancing across polls stays INDETERMINATE (idle seat), and resolves on the poll where exactly one advances", () => {
    const sel = new LiveClaudeRecordSelector();
    sel.select("seat", CAND, statFn({ [A]: [1000, 100], [B]: [2000, 900] }));
    const idle = sel.select("seat", CAND, statFn({ [A]: [1000, 100], [B]: [2000, 900] }));
    expect(idle.ok).toBe(false);
    if (!idle.ok) expect(idle.reason).toContain("no record advanced since the previous poll");
    const resolved = sel.select("seat", CAND, statFn({ [A]: [1000, 100], [B]: [2500, 950] }));
    expect(resolved).toMatchObject({ ok: true, id: "id-b" });
  });

  it("both advancing = genuinely ambiguous, named", () => {
    const sel = new LiveClaudeRecordSelector();
    sel.select("seat", CAND, statFn({ [A]: [1000, 100], [B]: [2000, 900] }));
    const both = sel.select("seat", CAND, statFn({ [A]: [1500, 130], [B]: [2500, 950] }));
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.reason).toContain("2 records advanced");
  });

  it("an UNREADABLE contender with a different id ALWAYS forces INDETERMINATE — even after a prior resolution", () => {
    const sel = new LiveClaudeRecordSelector();
    sel.select("seat", CAND, statFn({ [A]: [1000, 100], [B]: [2000, 900] }));
    sel.select("seat", CAND, statFn({ [A]: [5000, 150], [B]: [2000, 900] })); // resolved id-a
    const withGhost = [...CAND, { source: "registry", id: "ghost", path: "/p/missing.jsonl" }];
    const out = sel.select("seat", withGhost, statFn({ [A]: [6000, 180], [B]: [2000, 900] }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("unreadable");
      expect(out.reason).toContain("ghost");
    }
  });

  it("r2 adjacent pin: a dead first path does NOT mask a readable second path for the SAME id", () => {
    const sel = new LiveClaudeRecordSelector();
    const out = sel.select("seat", [
      { source: "sidecar", id: "only-id", path: "/p/dead.jsonl" },
      { source: "sidecar", id: "only-id", path: A },
    ], statFn({ [A]: [1000, 100] }));
    expect(out).toMatchObject({ ok: true, id: "only-id", path: A });
  });

  it("UNANIMITY resolves immediately even when dormant; zero readable = named INDETERMINATE listing dead candidates", () => {
    const sel = new LiveClaudeRecordSelector();
    const ok = sel.select("s1", [{ source: "sidecar", id: "only", path: A }], statFn({ [A]: [1, 1] }));
    expect(ok).toMatchObject({ ok: true, id: "only" });
    const none = sel.select("s2", [
      { source: "sidecar", id: "ghost-1", path: "/p/missing.jsonl" },
      { source: "registry", id: "ghost-2", path: null },
    ], statFn({}));
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.reason).toContain("sidecar:ghost-1");
      expect(none.reason).toContain("registry:ghost-2");
    }
  });
});

describe("resolveLiveCodexThreadId", () => {
  it("joins through the live codex pid's logs, bypassing any stored token", async () => {
    const out = await resolveLiveCodexThreadId("s", deps);
    expect(out).toEqual({ ok: true, id: "thread-live-123" });
  });

  it("a codex process whose logs yield nothing is a NAMED reason", async () => {
    const out = await resolveLiveCodexThreadId("s", { ...deps, readThreadIdByPid: () => undefined });
    expect(!out.ok && out.reason).toContain("yielded no thread id");
  });
});
