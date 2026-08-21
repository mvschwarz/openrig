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

describe("selectLiveClaudeRecord — FAIL-CLOSED: disagreement demands write-liveness (r2 HIGH-1)", () => {
  const NOW = 10_000_000;
  const nowMs = () => NOW;
  const MTIMES: Record<string, number | null> = {
    "/p/rolled-current.jsonl": NOW - 60_000, // appended a minute ago — provably live
    "/p/launch-arg-stale.jsonl": NOW - 86_400_000, // dormant a day (the D-a specimen)
    "/p/registry.jsonl": NOW - 120_000,
  };
  const stat = (path: string) => MTIMES[path] ?? null;

  it("the D-a specimen, replayed: disagreeing ids, but the winner is LIVE-written — the dormant argument record loses", () => {
    const out = selectLiveClaudeRecord([
      { source: "sidecar", id: "rolled-current", path: "/p/rolled-current.jsonl" },
      { source: "registry", id: "registry-id", path: "/p/registry.jsonl" },
      { source: "pane-argument", id: "launch-arg-stale", path: "/p/launch-arg-stale.jsonl" },
    ], stat, nowMs);
    expect(out).toMatchObject({ ok: true, id: "rolled-current", source: "sidecar" });
  });

  it("r2's discriminator: an UNREADABLE current contender + a readable stale record = NAMED INDETERMINATE, never confident stale truth", () => {
    const out = selectLiveClaudeRecord([
      { source: "sidecar", id: "rolled-current", path: "/p/missing.jsonl" }, // current session, record not readable yet
      { source: "pane-argument", id: "launch-arg-stale", path: "/p/launch-arg-stale.jsonl" }, // readable but dormant
    ], stat, nowMs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("disagree");
      expect(out.reason).toContain("rolled-c"); // the unreadable contender is named (8-char prefix)
      expect(out.reason).toContain("not provably the record being written now");
    }
  });

  it("disagreeing readable ids where even the freshest is BEYOND the liveness window = NAMED INDETERMINATE", () => {
    const out = selectLiveClaudeRecord([
      { source: "sidecar", id: "old-a", path: "/p/registry.jsonl" },
      { source: "pane-argument", id: "launch-arg-stale", path: "/p/launch-arg-stale.jsonl" },
    ], stat, () => NOW + 60 * 60 * 1000); // an hour later, nothing written since
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not provably the record being written now");
  });

  it("UNANIMOUS candidates need no recency: one id everywhere resolves even when idle for hours", () => {
    const out = selectLiveClaudeRecord([
      { source: "sidecar", id: "only-id", path: "/p/launch-arg-stale.jsonl" },
      { source: "pane-argument", id: "only-id", path: "/p/launch-arg-stale.jsonl" },
    ], stat, nowMs);
    expect(out).toMatchObject({ ok: true, id: "only-id" });
  });

  it("zero readable candidates = NAMED INDETERMINATE listing every dead candidate, never a guess", () => {
    const out = selectLiveClaudeRecord([
      { source: "sidecar", id: "ghost-1", path: "/p/missing.jsonl" },
      { source: "registry", id: "ghost-2", path: null },
    ], stat, nowMs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("sidecar:ghost-1");
      expect(out.reason).toContain("registry:ghost-2");
    }
  });

  it("an id readable via ONE source is readable, period (dedupe keeps the readable path)", () => {
    const out = selectLiveClaudeRecord([
      { source: "registry", id: "rolled-current", path: null },
      { source: "sidecar", id: "rolled-current", path: "/p/rolled-current.jsonl" },
    ], stat, nowMs);
    expect(out).toMatchObject({ ok: true, id: "rolled-current" });
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
