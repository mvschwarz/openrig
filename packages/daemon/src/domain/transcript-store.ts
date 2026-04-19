import { mkdirSync, appendFileSync, existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getCompatibleOpenRigPath } from "../openrig-compat.js";

export interface TranscriptStoreOpts {
  transcriptsRoot?: string;
  enabled?: boolean;
}

const DEFAULT_ROOT = getCompatibleOpenRigPath("transcripts");

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

function stripShellPromptPrefix(line: string): string {
  return line.replace(/^\s*\S+@\S+ .*? %\s*/, "");
}

function isBareShellPrompt(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "%" || /^\S+@\S+ .*? %$/.test(trimmed);
}

function isPromptRedrawDuplicate(line: string, nextLine?: string): boolean {
  const trimmed = line.trimEnd();
  if (!trimmed.endsWith("%")) return false;
  const withoutPrompt = trimmed.slice(0, -1).trimEnd();
  return withoutPrompt.length > 0 && nextLine?.trim() === withoutPrompt;
}

function isUiChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === "? for shortcuts" || trimmed === "esc to interrupt") return true;
  return /[─━]{8,}/.test(trimmed);
}

function isSpinnerOnlyLine(line: string): boolean {
  return /^[\s✢✳✶✻✽·⏺❯]+$/.test(line);
}

function normalizeTuiFragment(line: string): string {
  return line
    .replace(/[✢✳✶✻✽·⏺❯]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyTuiFragment(line: string): boolean {
  const normalized = normalizeTuiFragment(line);
  if (!normalized) return false;
  if (!(/[✢✳✶✻✽·⏺❯]/.test(line) || /\s{2,}/.test(line))) return false;
  if (/[0-9@:/[\]{}()'"`=.,!?_-]/.test(normalized)) return false;
  if (/[^A-Za-z… ]/.test(normalized)) return false;
  return normalized.length <= 12;
}

function stripOrphanCursorFragments(line: string): string {
  return line.replace(/\[\d{1,3}[A-Za-z](?=\S)/g, " ");
}

function isStatusOverlayLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === "Checking for updates") return true;
  if (/^(?:[›⏵⏺❯]+\s*)?accept edits on\b.*\/clear to save\b.*tokens?$/i.test(trimmed)) return true;
  if (/^\d+\s+background terminal running\b.*\/ps to view\b.*\/stop to close\b/i.test(trimmed)) return true;
  if (/^gpt-[^\n]+ · Context \[[^\]]+\] · .+$/.test(trimmed)) return true;
  return false;
}

const TAIL_CHUNK_SIZE = 16 * 1024;

/**
 * Read the last N raw lines from a file by reading backwards in chunks.
 * Handles UTF-8 multibyte characters at chunk boundaries by adjusting
 * the read offset to avoid splitting characters.
 */
function readTailChunked(filePath: string, rawLines: number): string | null {
  const stat = statSync(filePath);
  if (stat.size === 0) return null;

  const fd = openSync(filePath, "r");
  try {
    let text = "";
    let offset = stat.size;

    while (offset > 0) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, offset);
      offset -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, offset);

      // Adjust for split UTF-8 multibyte: if the first byte is a continuation
      // byte (10xxxxxx = 0x80-0xBF), we've split a character. Move the offset
      // forward past the continuation bytes so the leading char bytes will be
      // included in the next (earlier) chunk read.
      let skipBytes = 0;
      while (skipBytes < buf.length && (buf[skipBytes]! & 0xC0) === 0x80) {
        skipBytes++;
      }
      if (skipBytes > 0) {
        offset += skipBytes; // push those bytes back for the next iteration
      }

      const chunk = buf.subarray(skipBytes).toString("utf-8");
      text = chunk + text;

      const newlineCount = countNewlines(text);
      if (newlineCount >= rawLines) break;
    }

    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const tail = lines.slice(-rawLines);
    return tail.join("\n");
  } finally {
    closeSync(fd);
  }
}

function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}

export class TranscriptStore {
  private readonly root: string;
  private readonly _enabled: boolean;

  constructor(opts?: TranscriptStoreOpts) {
    this.root = opts?.transcriptsRoot ?? DEFAULT_ROOT;
    this._enabled = opts?.enabled ?? true;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  getTranscriptPath(rigName: string, sessionName: string): string {
    const resolved = join(this.root, rigName, `${sessionName}.log`);
    // Guard against path traversal from rig/session names containing ".."
    if (!resolved.startsWith(this.root + "/") && resolved !== this.root) {
      return join(this.root, "_unsafe", `${sessionName}.log`);
    }
    return resolved;
  }

  ensureTranscriptDir(rigName: string): boolean {
    if (!this._enabled) return false;
    try {
      const dir = join(this.root, rigName);
      // Guard against path traversal
      if (!dir.startsWith(this.root + "/") && dir !== this.root) {
        return false;
      }
      mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  writeBoundaryMarker(rigName: string, sessionName: string, reason: string): boolean {
    if (!this._enabled) return false;
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      const marker = `--- SESSION BOUNDARY: ${reason} at ${new Date().toISOString()} ---\n`;
      appendFileSync(filePath, marker, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  stripAnsi(text: string): string {
    return text
      // Preserve horizontal spacing from cursor-forward/absolute motions.
      .replace(/\x1b\[(\d*)C/g, (_, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
      .replace(/\x1b\[(\d*)G/g, (_, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
      // Strip OSC/title updates like ESC ] 0;title BEL.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Strip remaining CSI and single-char escape sequences.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[@-_]/g, "")
      // Shell redraws often emit char + backspace before replaying the line.
      .replace(/\r/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[^\n]\x08/g, (match) => applyBackspaces(match))
      .replace(/\x08+/g, "")
      // Treat carriage-return redraws as separate transcript lines.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  readTail(rigName: string, sessionName: string, lines: number): string | null {
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) return null;
      const fileSize = statSync(filePath).size;
      if (fileSize === 0) return "";

      // Adaptive: start with a generous oversample, expand if cleanup filters too many
      let rawMultiplier = 8;
      const MAX_MULTIPLIER = 64;

      while (rawMultiplier <= MAX_MULTIPLIER) {
        const rawTail = readTailChunked(filePath, lines * rawMultiplier);
        if (rawTail === null) return "";

        const cleanedTail = this.cleanupTailLines(rawTail, lines);
        if (cleanedTail.length >= lines || rawMultiplier >= MAX_MULTIPLIER) {
          const finalTail = cleanedTail.slice(-lines);
          return finalTail.length > 0 ? finalTail.join("\n") + "\n" : "";
        }

        // Not enough lines after cleanup — read more raw lines
        rawMultiplier *= 2;
      }

      return "";
    } catch {
      return null;
    }
  }

  private cleanupTailLines(rawText: string, _requestedLines: number): string[] {
    const normalizedLines = this.stripAnsi(rawText)
      .split("\n")
      .map((line) => stripShellPromptPrefix(line))
      .map((line) => stripOrphanCursorFragments(line))
      .map((line) => line.trimEnd());
    const filtered = normalizedLines
      .filter((line) => line.trim() !== "")
      .filter((line) => !isBareShellPrompt(line));
    return filtered
      .filter((line) => !isStatusOverlayLine(line))
      .filter((line) => !isUiChromeLine(line))
      .filter((line) => !isSpinnerOnlyLine(line))
      .filter((line) => !isLikelyTuiFragment(line))
      .filter((line, index) => !isPromptRedrawDuplicate(line, filtered[index + 1]));
  }

  grep(rigName: string, sessionName: string, pattern: string): string[] | null {
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) return null;
      return this.grepSync(filePath, pattern);
    } catch {
      return null;
    }
  }

  private grepSync(filePath: string, pattern: string): string[] {
    const regex = new RegExp(pattern);
    const matches: string[] = [];
    const fd = openSync(filePath, "r");
    const decoder = new StringDecoder("utf-8");
    try {
      const stat = statSync(filePath);
      const CHUNK_SIZE = 64 * 1024;
      let remainder = "";

      for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE) {
        const readSize = Math.min(CHUNK_SIZE, stat.size - offset);
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, offset);
        // StringDecoder handles incomplete multibyte sequences at chunk boundaries
        const chunk = remainder + decoder.write(buf);
        const lines = chunk.split("\n");
        remainder = lines.pop() ?? "";

        for (const rawLine of lines) {
          const stripped = this.stripAnsi(rawLine);
          for (const subLine of stripped.split("\n")) {
            const cleaned = stripShellPromptPrefix(subLine);
            if (cleaned && regex.test(cleaned)) {
              matches.push(cleaned);
            }
          }
        }
      }

      // Flush any remaining bytes from the decoder
      const finalChunk = remainder + decoder.end();
      if (finalChunk) {
        const stripped = this.stripAnsi(finalChunk);
        for (const subLine of stripped.split("\n")) {
          const cleaned = stripShellPromptPrefix(subLine);
          if (cleaned && regex.test(cleaned)) {
            matches.push(cleaned);
          }
        }
      }
    } finally {
      closeSync(fd);
    }

    return matches;
  }
}
