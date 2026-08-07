import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlExchanges } from "../src/domain/session-jsonl.js";

// Seat-handover stopgap (plan 411c43de): read the PROVIDER session JSONL (claude sidecar
// transcript_path / codex rollout_path) into the last-N {role, content} exchanges for the boot recap.
// Defensive / honest-degraded: metadata + thinking/tool_use-only lines carry no user text and are
// skipped; unparseable lines are skipped (a corrupt tail never throws). Grounded on the real
// claude-projects line shape ({type,message:{role,content}}; content string OR [{type,text}] blocks).

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(lines: unknown[]): string {
  const d = mkdtempSync(join(tmpdir(), "sj-"));
  dirs.push(d);
  const p = join(d, "transcript.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

describe("parseJsonlExchanges — claude-projects role/content shape", () => {
  it("extracts {role, content} from user-string + assistant-text lines, newest-last", () => {
    const p = fixture([
      { type: "custom-title", customTitle: "x" }, // metadata — skipped
      { type: "user", message: { role: "user", content: "do the thing" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", text: "hmm" }] } }, // thinking-only — skipped
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done the thing" }] } },
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "done the thing" },
    ]);
  });

  it("joins multiple text blocks and skips tool_use blocks in an assistant array", () => {
    const p = fixture([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "part A" }, { type: "tool_use", name: "x" }, { type: "text", text: "part B" }] } },
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "assistant", content: "part A\npart B" }]);
  });

  it("bounds to the last N exchanges", () => {
    const p = fixture([
      { type: "user", message: { role: "user", content: "1" } },
      { type: "user", message: { role: "user", content: "2" } },
      { type: "user", message: { role: "user", content: "3" } },
    ]);
    expect(parseJsonlExchanges(p, 2)).toEqual([
      { role: "user", content: "2" },
      { role: "user", content: "3" },
    ]);
  });

  it("skips unparseable lines (corrupt tail never throws) and empty-text messages", () => {
    const d = mkdtempSync(join(tmpdir(), "sj-"));
    dirs.push(d);
    const p = join(d, "t.jsonl");
    writeFileSync(p, [
      JSON.stringify({ type: "user", message: { role: "user", content: "good" } }),
      "{ this is not json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] } }), // no text → skipped
    ].join("\n") + "\n");
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "user", content: "good" }]);
  });

  it("a missing file yields [] (honest-degraded, never throws)", () => {
    expect(parseJsonlExchanges(join(tmpdir(), "does-not-exist-xyz.jsonl"), 5)).toEqual([]);
  });

  it("also reads the codex rollout shape (payload.type=message with role/content)", () => {
    const p = fixture([
      { payload: { type: "message", role: "user", content: "codex hello" } },
      { payload: { type: "token_count", info: {} } }, // non-message — skipped
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "user", content: "codex hello" }]);
  });
});
