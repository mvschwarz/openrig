// OPR.0.5.9.13 — no name-keyed pointer or transcript recency signal is occupant identity. Resolve
// the canonical current generation through its binding and verified pane/process instead.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paneClaudeSessionIdArgument,
  resolveIdentityVerifiedClaudeRecord,
  resolveLiveCodexThreadId,
  type ProcessRow,
} from "../src/domain/model-divergence/current-generation-record.js";

describe("resolveIdentityVerifiedClaudeRecord — canonical occupant identity", () => {
  const canonicalId = "f16594c5-179a-4be7-bf5e-fd759b2b87a3";
  const reserveId = "9e1ac0df-505a-4050-857b-a494b46dabc6";
  const bootAt = "2026-09-04T02:00:00.000Z";
  const canonicalSession = "orch-advisor@v-openrig-build";
  const processes: ProcessRow[] = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 20, ppid: 10, command: `claude --model claude-fable-5-1 --resume ${canonicalId} --name ${canonicalSession}` },
    { pid: 30, ppid: 1, command: "-zsh" },
    { pid: 40, ppid: 30, command: `claude --model claude-fable-5 --resume ${reserveId} --name ${canonicalSession}` },
  ];

  function input(transcriptPath: string) {
    return {
      sessionName: canonicalSession,
      generation: "generation-current",
      occupantBootAt: bootAt,
      binding: { tmuxSession: canonicalSession, tmuxPane: "%156" },
      identity: {
        verdict: "verified",
        sessionName: canonicalSession,
        observedAt: "2026-09-04T02:30:00.000Z",
        evidence: { registeredPane: "%156", observedPid: 10 },
      },
      sidecar: {
        session_id: canonicalId,
        session_name: canonicalSession,
        transcript_path: transcriptPath,
        sampled_at: "2026-09-04T02:31:00.000Z",
      },
    } as const;
  }

  it("the verified canonical pane wins while the retained alias reserve advances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-current-occupant-"));
    try {
      const canonicalPath = join(dir, `${canonicalId}.jsonl`);
      const reservePath = join(dir, `${reserveId}.jsonl`);
      writeFileSync(canonicalPath, '{"model":"claude-fable-5-1"}\n');
      writeFileSync(reservePath, '{"model":"claude-opus-5"}\n');
      utimesSync(canonicalPath, new Date("2026-09-04T02:20:00Z"), new Date("2026-09-04T02:20:00Z"));
      utimesSync(reservePath, new Date("2026-09-04T02:40:00Z"), new Date("2026-09-04T02:40:00Z"));

      const base = input(reservePath);
      const out = await resolveIdentityVerifiedClaudeRecord(
        {
          ...base,
          sidecar: {
            ...base.sidecar,
            session_id: reserveId,
            occupant_generation: "generation-retained-predecessor",
          },
        },
        {
          getPanePid: async (target) => target === "%156" ? 10 : null,
          listProcesses: async () => processes,
          readThreadIdByPid: () => undefined,
        },
        (path) => { try { return statSync(path).isFile(); } catch { return false; } },
      );

      expect(out).toEqual({
        ok: true,
        id: canonicalId,
        path: canonicalPath,
        source: "verified-pane-argument",
      });
      expect(statSync(reservePath).mtimeMs).toBeGreaterThan(statSync(canonicalPath).mtimeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing, stale, changed, or ambiguous pane identity is explicit and never transcript-recency-selected", async () => {
    const readable = () => true;
    const base = input(`/tmp/${canonicalId}.jsonl`);
    const cases = [
      { value: { ...base, generation: null }, reason: "occupant generation is unknown" },
      { value: { ...base, identity: null }, reason: "no verified pane identity" },
      { value: { ...base, identity: { ...base.identity, observedAt: "2026-09-04T01:59:59.000Z" } }, reason: "predates occupant generation" },
      { value: { ...base, identity: { ...base.identity, evidence: { ...base.identity.evidence, registeredPane: "%6" } } }, reason: "registered pane does not match" },
    ];
    for (const testCase of cases) {
      const out = await resolveIdentityVerifiedClaudeRecord(testCase.value, {
        getPanePid: async () => 10,
        listProcesses: async () => processes,
        readThreadIdByPid: () => undefined,
      }, readable);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain(testCase.reason);
    }

    const changed = await resolveIdentityVerifiedClaudeRecord(base, {
      getPanePid: async () => 999,
      listProcesses: async () => processes,
      readThreadIdByPid: () => undefined,
    }, readable);
    expect(!changed.ok && changed.reason).toContain("changed since identity verification");

    const ambiguous = await resolveIdentityVerifiedClaudeRecord(base, {
      getPanePid: async () => 10,
      listProcesses: async () => [...processes, {
        pid: 21,
        ppid: 10,
        command: "claude --resume 11111111-1111-4111-8111-111111111111",
      }],
      readThreadIdByPid: () => undefined,
    }, readable);
    expect(!ambiguous.ok && ambiguous.reason).toContain("multiple claude session ids");
  });

  it("a generation-stamped sidecar may name a provider rollover inside the verified occupant", async () => {
    const rolledId = "22222222-2222-4222-8222-222222222222";
    const base = input(`/tmp/${rolledId}.jsonl`);
    const out = await resolveIdentityVerifiedClaudeRecord({
      ...base,
      sidecar: { ...base.sidecar, session_id: rolledId, occupant_generation: "generation-current" },
    }, {
      getPanePid: async () => 10,
      listProcesses: async () => processes,
      readThreadIdByPid: () => undefined,
    }, () => true);
    expect(out).toMatchObject({ ok: true, id: rolledId, source: "generation-sidecar" });
  });
});

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
