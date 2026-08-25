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
    const state = { generationId: "g1", content: "prior gen-1 record\n" };
    let sent = false;
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + "> the case prompt\n"; return "sent"; }
      return undefined;
    });
    // A fake current-generation reader standing in for the contextUsageStore-backed default: the record
    // grows append-only across reads, then goes quiet.
    const readGenerationRecord = async () => {
      const out = { generationId: state.generationId, content: state.content };
      if (sent && !state.content.includes("DONE")) state.content = state.content + "DONE rig context get skills/core/rig-lifecycle\n";
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
    expect(sends).toEqual([["send", "ops-eval@evalrig", "the case prompt"]]);
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
