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
});

describe("readTailLines", () => {
  it("drops the possibly-truncated first line when the read starts mid-file", () => {
    const p = tmp("f.txt", "aaaa\nbbbb\ncccc\n");
    const lines = readTailLines(p, 7); // lands mid-"bbbb"
    expect(lines).not.toContain("aaaa");
    expect(lines).toContain("cccc");
  });
});
