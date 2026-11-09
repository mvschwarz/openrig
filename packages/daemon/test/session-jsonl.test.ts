import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync, statSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlExchanges } from "../src/domain/session-jsonl.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

// Seat-handover boot recap: read the PROVIDER session JSONL (claude sidecar
// transcript_path / codex rollout_path) into the last-N {role, content} exchanges for the boot recap.
// Defensive / honest-degraded: metadata + thinking/tool_use-only lines carry no user text and are
// skipped; unparseable lines are skipped (a corrupt tail never throws). Grounded on the real
// claude-projects line shape ({type,message:{role,content}}; content string OR [{type,text}] blocks).

const dirs: string[] = [];
afterEach(() => { vi.mocked(readSync).mockReset(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
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

  it("keeps Codex block types scoped to Codex messages", () => {
    const p = fixture([
      { type: "assistant", message: { role: "assistant", content: [{ type: "output_text", text: "not a Claude text block" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "legacy text" }, { type: "output_text", text: 42 }, { type: "tool_call", text: "not text" }] } },
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "assistant", content: "legacy text" }]);
  });

  it("also reads the codex rollout shape (payload.type=message with role/content)", () => {
    const p = fixture([
      { payload: { type: "message", role: "user", content: "codex hello" } },
      { payload: { type: "token_count", info: {} } }, // non-message — skipped
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "user", content: "codex hello" }]);
  });
});

describe("recap reads bounded chunks from the end", () => {
  it("reads the last six exchanges from a sparse transcript larger than the string limit", () => {
    const p = fixture([]);
    const expected = Array.from({ length: 6 }, (_, i) => ({ role: "user", content: String(i) }));
    const tail = "\n" + expected.map((message) => JSON.stringify({ message })).join("\n")
      + '\n{"type":"metadata"}\n{partial';
    const fd = openSync(p, "w");
    try {
      writeSync(fd, tail, 512 * 1024 * 1024 + 4096);
    } finally {
      closeSync(fd);
    }
    expect(statSync(p).size).toBeGreaterThan(512 * 1024 * 1024);
    expect(parseJsonlExchanges(p, 6)).toEqual(expected);
    const requestedBytes = vi.mocked(readSync).mock.calls.reduce((sum, call) => sum + Number(call[3] ?? 0), 0);
    expect(requestedBytes).toBeLessThan(1024 * 1024);
  });

  it.each(["", "\n", "\r\n"])("keeps UTF-8 and whole records across chunks with ending %j", (ending) => {
    const p = fixture([]);
    const long = "🍵é".repeat(40_000);
    const expected = [{ role: "user", content: "first" }, { role: "assistant", content: long }];
    writeFileSync(p, [
      JSON.stringify({ message: expected[0] }),
      '{"message":{"role":"user",', // Physical JSONL fragments stay corrupt; never join separate lines.
      '"content":"not an exchange"}}',
      JSON.stringify({ message: expected[1] }),
      JSON.stringify({ type: "metadata", padding: "x".repeat(150_000) }),
      "{partial",
    ].join("\r\n") + ending);
    expect(parseJsonlExchanges(p, 6)).toEqual(expected);
    expect(parseJsonlExchanges(p, 1)).toEqual(expected.slice(-1));
  });

  it("completes a short positional read before decoding", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const p = fixture([{ message: { role: "user", content: "🍵" } }]);
    vi.mocked(readSync).mockImplementationOnce((fd, buffer) => fs.readSync(fd, buffer, 0, 1, 0));
    expect(parseJsonlExchanges(p, 6)).toEqual([{ role: "user", content: "🍵" }]);
    expect(readSync).toHaveBeenCalledTimes(2);
  });

  it("returns no partial recap if the file becomes unreadable after a visible exchange", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const p = fixture([
      { message: { role: "user", content: "first" } },
      { type: "metadata", padding: "x".repeat(150_000) },
      { message: { role: "assistant", content: "last" } },
    ]);
    vi.mocked(readSync).mockImplementationOnce(fs.readSync).mockReturnValueOnce(0);
    expect(parseJsonlExchanges(p, 6)).toEqual([]);
    expect(readSync).toHaveBeenCalledTimes(2);
  });

  it("reports no exchanges for an unreadable record or metadata-only chunks", () => {
    const p = fixture([{ type: "metadata", padding: "x".repeat(150_000) }]);
    expect(parseJsonlExchanges(p, 6)).toEqual([]);
    expect(parseJsonlExchanges(join(p, ".."), 6)).toEqual([]);
  });
});

describe("recap tail boundaries", () => {
  it.each(["", "\n", "\r\n"])("keeps chronological order with trailing %j", (ending) => {
    const p = fixture([]);
    const message = (content: string) => JSON.stringify({ message: { role: "user", content } });
    writeFileSync(p, [message("old"), message("first retained"), "{partial", "", JSON.stringify({ type: "metadata" }), message("last retained")].join("\r\n") + ending);
    expect(parseJsonlExchanges(p, 2)).toEqual([
      { role: "user", content: "first retained" },
      { role: "user", content: "last retained" },
    ]);
  });

  it("returns the first line when it is the only visible exchange", () => {
    const p = fixture([{ message: { role: "user", content: "first" } }, { type: "metadata" }]);
    expect(parseJsonlExchanges(p, 6)).toEqual([{ role: "user", content: "first" }]);
    expect(parseJsonlExchanges(p, 0)).toEqual([]);
  });

  it("returns only the latest exchanges from a long record", () => {
    const p = fixture(Array.from({ length: 20_000 }, (_, i) => ({ message: { role: "user", content: String(i) } })));
    expect(parseJsonlExchanges(p, 2)).toEqual([
      { role: "user", content: "19998" },
      { role: "user", content: "19999" },
    ]);
  });
});
