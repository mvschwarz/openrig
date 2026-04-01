import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TranscriptStoreOpts {
  transcriptsRoot?: string;
  enabled?: boolean;
}

const DEFAULT_ROOT = join(homedir(), ".rigged", "transcripts");

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
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\x1b\[\?[0-9]*[a-zA-Z]/g, "");
  }

  readTail(rigName: string, sessionName: string, lines: number): string | null {
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, "utf-8");
      const allLines = content.split("\n");
      // Remove trailing empty line from split
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
        allLines.pop();
      }
      const tail = allLines.slice(-lines);
      return tail.map((l) => this.stripAnsi(l)).join("\n") + "\n";
    } catch {
      return null;
    }
  }

  grep(rigName: string, sessionName: string, pattern: string): string[] | null {
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, "utf-8");
      const regex = new RegExp(pattern);
      return content
        .split("\n")
        .filter((line) => regex.test(line))
        .map((line) => this.stripAnsi(line));
    } catch {
      return null;
    }
  }
}
