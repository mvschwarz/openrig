// The transcript grep scan, on its own thread.
//
// A caller-supplied pattern is run against every line of a transcript, and some patterns the route
// accepts as valid syntax backtrack catastrophically: `new RegExp("(a+)+$").test("a".repeat(30) + "!")`
// does not finish. Running that on the daemon's thread stops every other request and every sweep for
// as long as it runs, so the scan lives here and the host ends this thread at its deadline
// (domain/transcript-grep.ts). A killed scan costs one grep; it cannot cost the daemon.
//
// The read is the chunked one the in-process scanner used: 64 KiB at a time, a StringDecoder across
// chunk boundaries, and a retained unfinished line between reads. A large transcript with no matches
// therefore costs a chunk's memory, not the file's, however many searches run at once.

import { parentPort } from "node:worker_threads";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

interface GrepRequest {
  id: number;
  filePath: string;
  pattern: string;
}

const CHUNK_SIZE = 64 * 1024;

/** Undo shell redraws: a character followed by a backspace overtypes the character before it. */
function applyBackspaces(text: string): string {
  const chars: string[] = [];
  for (const ch of text) {
    if (ch === "\b") {
      chars.pop();
      continue;
    }
    chars.push(ch);
  }
  return chars.join("");
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
    .replace(/\x1b\[(\d*)G/g, (_, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(applyBackspaces)
    .join("\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function stripShellPromptPrefix(line: string): string {
  return line.replace(/^\s*\S+@\S+ .*? %\s*/, "");
}

function readChunk(fd: number, size: number, offset: number): Buffer {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = readSync(fd, buffer, read, size - read, offset + read);
    if (count === 0) throw new Error("Transcript changed during read");
    read += count;
  }
  return buffer;
}

/** The matching lines, read the way the in-process scanner read them. */
function scan(filePath: string, pattern: string): string[] {
  const regex = new RegExp(pattern);
  const matches: string[] = [];
  const fd = openSync(filePath, "r");
  const decoder = new StringDecoder("utf-8");
  try {
    const stat = fstatSync(fd);
    let remainder: string[] = [];
    for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE) {
      const buf = readChunk(fd, Math.min(CHUNK_SIZE, stat.size - offset), offset);
      const lines = decoder.write(buf).split("\n");
      // A chunk that ends inside a long line carries it forward instead of joining and resplitting a
      // growing remainder on every read.
      if (lines.length === 1) {
        remainder.push(lines[0]!);
        continue;
      }
      lines[0] = remainder.join("") + lines[0];
      remainder = [lines.pop() ?? ""];
      for (const rawLine of lines) {
        for (const subLine of stripAnsi(rawLine).split("\n")) {
          const cleaned = stripShellPromptPrefix(subLine);
          if (cleaned && regex.test(cleaned)) matches.push(cleaned);
        }
      }
    }
    const finalChunk = remainder.join("") + decoder.end();
    if (finalChunk) {
      for (const subLine of stripAnsi(finalChunk).split("\n")) {
        const cleaned = stripShellPromptPrefix(subLine);
        if (cleaned && regex.test(cleaned)) matches.push(cleaned);
      }
    }
  } finally {
    closeSync(fd);
  }
  return matches;
}

parentPort?.on("message", (request: GrepRequest) => {
  try {
    parentPort!.postMessage({ id: request.id, matches: scan(request.filePath, request.pattern) });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});