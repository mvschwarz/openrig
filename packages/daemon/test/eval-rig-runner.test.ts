// Test-A blocker 3 round 7 — the ENTRY-LEVEL discriminator r2 round-6 HIGH-1 requires: prove the
// PUBLIC runner seam (`run-evals.mjs --provider rig` via buildRigProviderSession) wires a
// current-generation record reader, submits ONE natural prompt, and captures the current-generation
// suffix — and that the authoritative default reader refuses LOUD when no record resolves. The green
// helper unit tests did not reach this seam; this test does.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRigProviderSession, defaultRunnerGenerationReader } from "./helpers/eval-rig-runner.js";
import type { RigExec } from "./helpers/eval-rig-session.js";

const WHOAMI = JSON.stringify({ session: "ops-eval@evalrig", occupantGeneration: "gen-1", nodeId: "01N" });

function scriptedExec(script: (args: string[]) => string | undefined): { exec: RigExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: RigExec = async (args) => {
    calls.push(args);
    const out = script(args);
    if (out === undefined) throw new Error(`unscripted exec: ${args.join(" ")}`);
    return out;
  };
  return { exec, calls };
}

describe("run-evals --provider rig — the wired runner seam (r2 round-6 HIGH-1)", () => {
  it("submits EXACTLY ONE natural prompt through the runner and captures the CURRENT-GENERATION suffix", async () => {
    // JSONL-shaped record (harness correction): the capture is schema-aware and grades assistant
    // OUTPUT with a terminal stop_reason — a raw pane-ish string is no longer a completable turn.
    const state = { generationId: "g1", content: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"prior gen-1 record"}]}}\n' };
    let sent = false;
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"the case prompt"}]}}\n'; return "sent"; }
      return undefined;
    });
    // A fake current-generation reader standing in for the contextUsageStore-backed default: the record
    // grows append-only across reads, then goes quiet.
    const readGenerationRecord = async () => {
      const out = { generationId: state.generationId, content: state.content };
      if (sent && !state.content.includes("DONE")) state.content = state.content + '{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"DONE rig context get skills/core/rig-lifecycle"}]}}\n';
      return out;
    };
    const session = await buildRigProviderSession({
      seat: "ops-eval@evalrig",
      exec,
      readGenerationRecord,
      session: { pollMs: 1, stablePolls: 2, sleep: async () => {} },
    }).spawn();

    await session.sendPrompt("the case prompt");
    const since = await session.captureSince("the case prompt");

    // ONE submitted send — the natural prompt (the frozen custody contract), through the runner seam.
    const sends = calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "--raw", "ops-eval@evalrig", "the case prompt"]]); // raw per PIN 5 — envelope suppressed, still exactly one send
    // The current-generation suffix is captured (grading sees the seat's turn), pre-send content excluded.
    expect(since).toContain("DONE rig context get skills/core/rig-lifecycle");
    expect(since).not.toContain("prior gen-1 record");
  });

  it("the authoritative default reader REFUSES LOUD when the seat has no current-generation record (no silent degrade)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-rig-runner-"));
    try {
      // No sidecar written at <stateDir>/context/<seat>.json => readAndNormalize resolves nothing.
      const reader = defaultRunnerGenerationReader({ stateDir });
      await expect(reader("dev-x@r")).rejects.toThrow(/no current-generation Claude conversation record|observation refused/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("SESSION-LIFETIME binding through the DEFAULT sidecar reader (r2 round-7 HIGH-1): a re-prime between cases emits ONLY the first send", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-rig-runner-"));
    try {
      const ctxDir = path.join(stateDir, "context");
      fs.mkdirSync(ctxDir, { recursive: true });
      const sidecar = path.join(ctxDir, "s@r.json");
      const writeSidecar = (gen: string, jsonl: string) =>
        fs.writeFileSync(sidecar, JSON.stringify({ session_id: gen, transcript_path: jsonl, context_window: { used_percentage: 10 } }));
      const j1 = path.join(stateDir, "g1.jsonl");
      fs.writeFileSync(j1, "gen-1 prior\n");
      writeSidecar("g1", j1);
      let currentJsonl = j1;
      const { exec, calls } = scriptedExec((args) => {
        if (args[0] === "whoami") return WHOAMI;
        if (args[0] === "send") { fs.appendFileSync(currentJsonl, `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(args[3])}}]}}\n{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"completed"}]}}\n`); return "sent"; }
        return undefined;
      });
      const session = await buildRigProviderSession({ seat: "s@r", exec, stateDir, session: { pollMs: 1, stablePolls: 2, sleep: async () => {} } }).spawn();
      // case 1 binds the session generation g1 (via the real ContextUsageStore sidecar reader)
      await session.sendPrompt("case-1");
      expect(await session.captureSince("case-1")).toContain("completed");
      // AUTHORITATIVE re-prime between cases: the seat's sidecar now names g2 + a fresh JSONL
      const j2 = path.join(stateDir, "g2.jsonl");
      fs.writeFileSync(j2, "gen-2 fresh\n");
      currentJsonl = j2;
      writeSidecar("g2", j2);
      // case 2 must refuse BEFORE the send — the cross-generation run is void
      await expect(session.sendPrompt("case-2")).rejects.toThrow(/generation changed BETWEEN cases/);
      expect(calls.filter((c) => c[0] === "send").map((c) => c[3])).toEqual(["case-1"]); // argv: send --raw <seat> <prompt>
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("the authoritative default reader resolves the sidecar's session id + JSONL as the generation record", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-rig-runner-"));
    try {
      const jsonl = path.join(stateDir, "gen-abc.jsonl");
      fs.writeFileSync(jsonl, '{"role":"assistant","text":"rig context get skills/core/rig-lifecycle"}\n');
      const ctxDir = path.join(stateDir, "context");
      fs.mkdirSync(ctxDir, { recursive: true });
      // Minimal Claude status-line sidecar: session id + transcript path (the append-only JSONL).
      fs.writeFileSync(path.join(ctxDir, "dev-x@r.json"), JSON.stringify({ session_id: "gen-abc", transcript_path: jsonl, context_window: { used_percentage: 10 } }));
      const reader = defaultRunnerGenerationReader({ stateDir });
      const rec = await reader("dev-x@r");
      expect(rec.generationId).toBe("gen-abc");
      expect(rec.content).toContain("rig context get skills/core/rig-lifecycle");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
