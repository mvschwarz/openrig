import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { scanTranscriptGrep, TranscriptGrepTimeoutError, TRANSCRIPT_GREP_TIMEOUT_MS } from "../src/domain/transcript-grep.js";

// The scan runs on its own thread so a caller-supplied pattern cannot hold the daemon's event loop.
// These tests cover both halves of that contract: the thread reads a file the way the store does, and
// a scan that will not finish is ended at its deadline instead of running forever.
const tmpDir = mkdtempSync(join(tmpdir(), "openrig-transcript-grep-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

function writeTranscript(name: string, body: string): string {
  const store = new TranscriptStore({ transcriptsRoot: tmpDir });
  store.ensureTranscriptDir(name);
  const path = store.getTranscriptPath(name, `dev@${name}`);
  writeFileSync(path, body);
  return path;
}

describe("scanTranscriptGrep", () => {
  it("returns the matching lines, cleaned the way the store cleans them", async () => {
    const path = writeTranscript("parity", [
      "plain line",
      "\x1b[1mdecision made\x1b[0m",
      "user@host project % printf 'decision from a prompt'\r",
      "abc\b\bdecision final",
      "unrelated",
      "",
    ].join("\n"));

    // The expectation is hand-computed from the store's own cleaning rules: ANSI stripped, a prompt
    // prefix removed, and backspace overtypes applied (`abc\b\b` leaves `a`).
    expect(await scanTranscriptGrep(path, "decision")).toEqual([
      "decision made",
      "printf 'decision from a prompt'",
      "adecision final",
    ]);
    expect(await scanTranscriptGrep(path, "nothing here")).toEqual([]);
  });

  it("returns null when the file is missing", async () => {
    expect(await scanTranscriptGrep(join(tmpDir, "absent", "nope.log"), "x")).toBeNull();
  });

  it("scans a large transcript well inside the default deadline", async () => {
    // The size the deadline was chosen against: 20,000 lines of a 100-byte line, about 2 MB. A scan
    // that took longer than the bound would mean the bound is too tight for an ordinary search.
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) lines.push(i % 500 === 0 ? `decision ${i}` : `line ${i}: ${"x".repeat(90)}`);
    const path = writeTranscript("large", `${lines.join("\n")}\n`);

    const started = performance.now();
    const matches = await scanTranscriptGrep(path, "decision");
    const elapsed = performance.now() - started;

    expect(matches?.length).toBe(40);
    expect(elapsed, `a 2 MB transcript scanned in ${elapsed.toFixed(0)} ms`).toBeLessThan(TRANSCRIPT_GREP_TIMEOUT_MS);
  });

  it("ends a scan that will not finish instead of holding the caller", async () => {
    // `(a+)+$` against this line backtracks catastrophically: measured with plain `node`, the match
    // does not return in a minute. The scan must be ended at its deadline instead.
    const path = writeTranscript("slow", `${"a".repeat(30)}!\n`);
    await expect(scanTranscriptGrep(path, "(a+)+$", 300)).rejects.toBeInstanceOf(TranscriptGrepTimeoutError);
  });

  it("leaves a long pattern to the caller, since the deadline is what bounds the scan", async () => {
    const path = writeTranscript("long-pattern", "aaa bbb ccc\n");
    const pattern = `${"a".repeat(300)}|bbb`;
    expect(await scanTranscriptGrep(path, pattern)).toEqual(["aaa bbb ccc"]);
  });
});