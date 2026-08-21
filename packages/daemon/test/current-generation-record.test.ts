// D-a — record-liveness selection: NO single pointer (sidecar / registry / pane argument) is
// generation-true — both directions were measured live in one night (B16: sidecar stale, argument
// right; D-a specimen: argument stale, sidecar right). The transcript being WRITTEN is the truth.

import { describe, it, expect } from "vitest";
import {
  paneClaudeSessionIdArgument,
  selectLiveClaudeRecord,
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

describe("selectLiveClaudeRecord — FAIL-CLOSED via OBSERVED ADVANCEMENT (r2 HIGH-1, rounds 2+3)", () => {
  // Two-sample harness: stats(path) returns first-sample then second-sample values.
  function twoSampleStat(first: Record<string, [number, number] | null>, second: Record<string, [number, number] | null>) {
    let probed = false;
    return {
      stat: (path: string) => {
        const v = (probed ? second : first)[path] ?? null;
        return v ? { mtimeMs: v[0], size: v[1] } : null;
      },
      sleep: async () => { probed = true; },
    };
  }

  it("the D-a specimen, replayed: disagreeing ids — the record that ADVANCES between samples wins, regardless of mtime rank", async () => {
    const { stat, sleep } = twoSampleStat(
      { "/p/current.jsonl": [1_000, 500], "/p/stale.jsonl": [2_000, 900] }, // stale even has the FRESHER mtime
      { "/p/current.jsonl": [1_500, 620], "/p/stale.jsonl": [2_000, 900] }, // only current advances
    );
    const out = await selectLiveClaudeRecord([
      { source: "sidecar", id: "current", path: "/p/current.jsonl" },
      { source: "pane-argument", id: "stale", path: "/p/stale.jsonl" },
    ], stat, { sleep, probeDelayMs: 0 });
    expect(out).toMatchObject({ ok: true, id: "current", source: "sidecar" });
  });

  it("r2 round-3 case 1: an UNREADABLE contender ALWAYS forces INDETERMINATE — even when the readable record was written seconds ago", async () => {
    const { stat, sleep } = twoSampleStat(
      { "/p/stale.jsonl": [9_999, 900] },
      { "/p/stale.jsonl": [10_050, 950] }, // the stale record is even actively advancing
    );
    const out = await selectLiveClaudeRecord([
      { source: "sidecar", id: "rolled-current", path: "/p/missing.jsonl" },
      { source: "pane-argument", id: "stale", path: "/p/stale.jsonl" },
    ], stat, { sleep, probeDelayMs: 0 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("unreadable");
      expect(out.reason).toContain("rolled-c");
      expect(out.reason).toContain("may be the record being written");
    }
  });

  it("r2 round-3 case 2: two readable ids written 61s and 60s ago, NEITHER advancing = INDETERMINATE (recency proves nothing)", async () => {
    const { stat, sleep } = twoSampleStat(
      { "/p/a.jsonl": [61_000, 100], "/p/b.jsonl": [60_000, 100] },
      { "/p/a.jsonl": [61_000, 100], "/p/b.jsonl": [60_000, 100] },
    );
    const out = await selectLiveClaudeRecord([
      { source: "sidecar", id: "id-a", path: "/p/a.jsonl" },
      { source: "pane-argument", id: "id-b", path: "/p/b.jsonl" },
    ], stat, { sleep, probeDelayMs: 0 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no record advanced");
  });

  it("multiple records advancing simultaneously = INDETERMINATE named as genuinely ambiguous", async () => {
    const { stat, sleep } = twoSampleStat(
      { "/p/a.jsonl": [1_000, 100], "/p/b.jsonl": [1_000, 100] },
      { "/p/a.jsonl": [2_000, 150], "/p/b.jsonl": [2_000, 160] },
    );
    const out = await selectLiveClaudeRecord([
      { source: "sidecar", id: "id-a", path: "/p/a.jsonl" },
      { source: "pane-argument", id: "id-b", path: "/p/b.jsonl" },
    ], stat, { sleep, probeDelayMs: 0 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("advanced simultaneously");
  });

  it("UNANIMITY needs no probe: one readable id everywhere resolves immediately even when dormant", async () => {
    let slept = false;
    const out = await selectLiveClaudeRecord([
      { source: "sidecar", id: "only-id", path: "/p/a.jsonl" },
      { source: "pane-argument", id: "only-id", path: "/p/a.jsonl" },
    ], () => ({ mtimeMs: 1, size: 1 }), { sleep: async () => { slept = true; }, probeDelayMs: 0 });
    expect(out).toMatchObject({ ok: true, id: "only-id" });
    expect(slept).toBe(false);
  });

  it("zero readable candidates = NAMED INDETERMINATE listing every dead candidate", async () => {
    const out = await selectLiveClaudeRecord([
      { source: "sidecar", id: "ghost-1", path: "/p/missing.jsonl" },
      { source: "registry", id: "ghost-2", path: null },
    ], () => null, { sleep: async () => {}, probeDelayMs: 0 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("sidecar:ghost-1");
      expect(out.reason).toContain("registry:ghost-2");
    }
  });

  it("an id readable via ONE source is readable, period (dedupe keeps the readable path)", async () => {
    const out = await selectLiveClaudeRecord([
      { source: "registry", id: "current", path: null },
      { source: "sidecar", id: "current", path: "/p/a.jsonl" },
    ], () => ({ mtimeMs: 1, size: 1 }), { sleep: async () => {}, probeDelayMs: 0 });
    expect(out).toMatchObject({ ok: true, id: "current" });
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
