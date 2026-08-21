// B8 / slice-07 A3 — per-runtime effective-model reads: real-shape fixtures, bounded tails, honest
// nulls. Both specimens proved the REQUESTED echo lies; these read the runtime's own record.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readClaudeEffectiveModel,
  readCodexEffectiveModel,
  readTailLines,
} from "../src/domain/model-divergence/effective-model-readers.js";

const dirs: string[] = [];
function tmp(name: string, content: string): string {
  const d = mkdtempSync(join(tmpdir(), "emr-"));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, content);
  return p;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const claudeLine = (model: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text: "hi" }] } });
const codexWorldState = (model: string) =>
  JSON.stringify({ timestamp: "t", ordinal: 4, type: "world_state", payload: { full: true, state: { collaboration_mode: { mode: "default", model } } } });

describe("readClaudeEffectiveModel", () => {
  it("returns the NEWEST assistant turn's model (the API response names what actually answered)", () => {
    const p = tmp("t.jsonl", [
      claudeLine("claude-opus-5"),
      JSON.stringify({ type: "user", message: { role: "user", content: "q" } }),
      claudeLine("claude-fable-5"),
      "",
    ].join("\n"));
    expect(readClaudeEffectiveModel(p)).toBe("claude-fable-5");
  });

  it("a transcript with NO assistant turn reads null (pending, never assumed)", () => {
    const p = tmp("t.jsonl", JSON.stringify({ type: "user", message: { role: "user", content: "boot" } }) + "\n");
    expect(readClaudeEffectiveModel(p)).toBeNull();
  });

  it("missing file reads null, corrupt lines are skipped", () => {
    expect(readClaudeEffectiveModel("/nonexistent/t.jsonl")).toBeNull();
    const p = tmp("t.jsonl", "{not json \"assistant\" \"model\"\n" + claudeLine("claude-fable-5") + "\n");
    expect(readClaudeEffectiveModel(p)).toBe("claude-fable-5");
  });

  it("BOUNDED: only the tail window is read — a signal within the tail resolves even on a huge file", () => {
    const p = tmp("t.jsonl", "");
    // ~2MB of padding lines, then the signal — the 512KB tail still contains it.
    for (let i = 0; i < 2000; i++) appendFileSync(p, JSON.stringify({ type: "metadata", filler: "x".repeat(1000) }) + "\n");
    appendFileSync(p, claudeLine("claude-fable-5") + "\n");
    expect(readClaudeEffectiveModel(p)).toBe("claude-fable-5");
  });
});

describe("readCodexEffectiveModel", () => {
  it("returns the newest world_state's collaboration_mode.model", () => {
    const p = tmp("r.jsonl", [
      codexWorldState("gpt-5.6-luna"),
      JSON.stringify({ type: "turn_context", payload: {} }),
      codexWorldState("gpt-5.4-mini"), // the silent-degrade specimen: newest state wins
      "",
    ].join("\n"));
    expect(readCodexEffectiveModel(p)).toBe("gpt-5.4-mini");
  });

  it("no world_state in the tail reads null", () => {
    const p = tmp("r.jsonl", JSON.stringify({ type: "turn_context", payload: {} }) + "\n");
    expect(readCodexEffectiveModel(p)).toBeNull();
  });

  it("r1 finding: a SPARSE world_state deep in a large rollout is found by the backward scan (r1 measured 0.80MB from EOF on a live 65.9MB rollout)", () => {
    const p = tmp("r.jsonl", "");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    // ~1.5MB of post-signal noise — the signal sits ~3 tail-windows from EOF.
    for (let i = 0; i < 1500; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    expect(readCodexEffectiveModel(p)).toBe("gpt-5.6-luna");
  });

  it("the backward scan is CAPPED: a signal beyond maxScanBytes reads null (bounded, named unknown — never a stall)", () => {
    const p = tmp("r.jsonl", "");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    for (let i = 0; i < 2000; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    expect(readCodexEffectiveModel(p, 1024 * 1024)).toBeNull(); // 1MB cap; signal ~2MB deep
  });

  it("r1 by-construction case: a REAL-SIZED (20KB) sole-signal record straddling a window boundary is read whole, not lost", () => {
    // r1 proved the old fixed 4KB overlap lost exactly this shape (real world_state records reach
    // ~22KB); the overlap is now sized from the dropped fragment, so size cannot defeat mechanism.
    const bigRecord = JSON.stringify({
      timestamp: "t", ordinal: 4, type: "world_state",
      payload: { full: true, state: { collaboration_mode: { mode: "default", model: "gpt-5.6-luna" }, filler: "w".repeat(20_000) } },
    });
    for (const prePad of [500, 505, 510]) { // sweep the boundary so SOME run genuinely straddles
      const p = tmp("r.jsonl", "");
      for (let i = 0; i < prePad; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
      appendFileSync(p, bigRecord + "\n");
      for (let i = 0; i < 520; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
      expect(readCodexEffectiveModel(p), `prePad=${prePad}`).toBe("gpt-5.6-luna");
    }
  });

  it("a small straddling record is still read (the original overlap case)", () => {
    const p = tmp("r.jsonl", "");
    for (let i = 0; i < 500; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    for (let i = 0; i < 520; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    expect(readCodexEffectiveModel(p)).toBe("gpt-5.6-luna");
  });
});

describe("readCodexEffectiveModel — window-wide lines", () => {
  it("r1 regression: a single line WIDER THAN THE WINDOW terminates fast (full-window step), instead of 1-byte grinding", () => {
    const p = tmp("r.jsonl", "");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    // One 2MB line (wider than the 512KB window) between the signal and EOF — the pathology needs
    // a record bigger than the WINDOW, not bigger than the overlap.
    appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(2 * 1024 * 1024) }) + "\n");
    for (let i = 0; i < 300; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    const t0 = Date.now();
    const model = readCodexEffectiveModel(p);
    const ms = Date.now() - t0;
    expect(model).toBe("gpt-5.6-luna"); // the signal beyond the giant line is still reached
    expect(ms).toBeLessThan(2_000); // pre-fix this ground 1-byte steps (r1: >30s on a real 6MB file)
  });
});

describe("readTailLines", () => {
  it("drops the possibly-truncated first line when the read starts mid-file", () => {
    const p = tmp("f.txt", "aaaa\nbbbb\ncccc\n");
    const lines = readTailLines(p, 7); // lands mid-"bbbb"
    expect(lines).not.toContain("aaaa");
    expect(lines).toContain("cccc");
  });
});
