import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExecDep = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

export interface SearchResult {
  backend: "rg" | "grep" | "none";
  excerpts: string[];
  insufficient: boolean;
  noTranscriptDir?: boolean;
  error?: string;
}

/** One keyword hit from a seat-scoped search, labeled with the generation
 *  (tenure) segment it fell in — the segments are delimited by the
 *  `--- SESSION BOUNDARY … ---` markers a seat's log accumulates across tenures. */
export interface SeatHit {
  generation: number;
  text: string;
}

export type SeatDegradeReason =
  | "capture_missing"
  | "capture_empty"
  | "capture_unreadable"
  | "boundary_only";

export interface SeatSearchResult {
  backend: "read" | "none";
  seat: string;
  /** count of tenure segments = (boundary markers seen) + 1 */
  generations: number;
  hits: SeatHit[];
  insufficient: boolean;
  /** honest-degraded signal — never a silent zero-hits that implies the seat never spoke */
  degraded?: { reason: SeatDegradeReason; message: string };
  /** large-file advisory (pin 5) — surfaced, never a silent slow read */
  advisory?: string;
}

export interface ChatSearchResult {
  sender: string;
  body: string;
  createdAt: string;
}

interface HistoryQueryOpts {
  transcriptsRoot: string;
  exec: ExecDep;
  chatSearchFn?: (rigId: string, pattern: string) => ChatSearchResult[];
  /** root of per-session provider JSONL (Claude): ~/.claude/projects. Injectable for tests. */
  claudeProjectsRoot?: string;
}

export interface SessionSearchResult {
  backend: "rg" | "grep" | "none";
  token: string;
  found: boolean;
  path?: string;
  sizeBytes?: number;
  excerpts: string[];
  insufficient: boolean;
  degraded?: { reason: "session_not_found" | "unreadable"; message: string };
  advisory?: string;
}

const STOP_WORDS = new Set([
  "the", "is", "was", "are", "were", "been", "being",
  "have", "has", "had", "having",
  "does", "did", "doing",
  "will", "would", "shall", "should",
  "may", "might", "must", "can", "could",
  "and", "but", "for", "nor", "not", "yet", "also",
  "this", "that", "these", "those",
  "what", "which", "who", "whom", "whose",
  "where", "when", "why", "how",
  "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "than", "too", "very",
  "its", "his", "her", "our", "your", "their",
  "with", "from", "into", "about", "between", "through",
  "during", "before", "after", "above", "below",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A JSONL event line can be huge; cap what we echo so a hit stays readable. */
function truncateExcerpt(line: string, max = 240): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function extractKeywords(question: string): string[] {
  const words = question.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const word of words) {
    // Strip trailing punctuation for stop-word check, but keep original for escaping
    const stripped = word.replace(/[?.!,;:]+$/, "");
    if (stripped.length < 3) continue;
    if (STOP_WORDS.has(stripped.toLowerCase())) continue;

    const escaped = escapeRegex(word.replace(/[?.!,;:]+$/, ""));
    if (seen.has(escaped)) continue;
    seen.add(escaped);
    result.push(escaped);
  }

  return result;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_: string, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
    .replace(/\x1b\[(\d*)G/g, (_: string, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Matches a session-boundary marker line (transcript-store.writeBoundaryMarker
 *  format): `--- SESSION BOUNDARY: <reason> at <ts> ---`. */
const SEAT_BOUNDARY_RE = /^--- SESSION BOUNDARY: .* at .* ---\s*$/;

/** Above this size a seat search surfaces a large-file advisory (pin 5) rather
 *  than reading silently — the full read still runs; the caller is told. */
const SEAT_LARGE_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export class HistoryQuery {
  private readonly transcriptsRoot: string;
  private readonly exec: ExecDep;
  private readonly chatSearchFn?: (rigId: string, pattern: string) => ChatSearchResult[];
  private readonly claudeProjectsRoot: string;

  constructor(opts: HistoryQueryOpts) {
    this.transcriptsRoot = opts.transcriptsRoot;
    this.exec = opts.exec;
    this.chatSearchFn = opts.chatSearchFn;
    this.claudeProjectsRoot = opts.claudeProjectsRoot ?? join(homedir(), ".claude", "projects");
  }

  /** Locate a session's JSONL by token: `<projectsRoot>/<any-encoded-cwd>/<token>.jsonl`.
   *  Token alone is enough (we scan the encoded-cwd dirs) — the founder's "I have
   *  the token, go find something". Returns null when nothing matches. */
  private locateSessionFile(token: string): string | null {
    const root = this.claudeProjectsRoot;
    if (!existsSync(root)) return null;
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const candidate = join(root, d, `${token}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * L2 — search ONE session's JSONL by its token (read-only). Locates the file
   * under ~/.claude/projects/<encoded-cwd>/<token>.jsonl and greps it (rg→grep
   * fallback; streaming, so a large 100s-of-MB session file is safe). Honest:
   * a token with no session file returns session_not_found teaching, never a
   * silent empty; a large file surfaces an advisory (pin 5).
   */
  async searchSession(sessionToken: string, question: string): Promise<SessionSearchResult> {
    const filePath = this.locateSessionFile(sessionToken);
    if (!filePath) {
      return {
        backend: "none",
        token: sessionToken,
        found: false,
        excerpts: [],
        insufficient: true,
        degraded: {
          reason: "session_not_found",
          message: `No session JSONL found for token '${sessionToken}' under ${this.claudeProjectsRoot}. Check the token — or the session may have run under a different host/home.`,
        },
      };
    }

    let sizeBytes: number;
    try {
      sizeBytes = statSync(filePath).size;
    } catch {
      return {
        backend: "none",
        token: sessionToken,
        found: true,
        path: filePath,
        excerpts: [],
        insufficient: true,
        degraded: { reason: "unreadable", message: `Session JSONL for '${sessionToken}' exists but could not be read.` },
      };
    }

    const advisory = sizeBytes > SEAT_LARGE_FILE_BYTES
      ? `Session JSONL is large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB); the search streams via rg/grep — a broad query may take a moment.`
      : undefined;

    const keywords = extractKeywords(question);
    if (keywords.length === 0) {
      return { backend: "none", token: sessionToken, found: true, path: filePath, sizeBytes, excerpts: [], insufficient: true, advisory };
    }
    const pattern = keywords.join("|");

    const rg = await this.exec("rg", ["-i", "--no-filename", "-e", pattern, filePath]);
    if (rg.exitCode === 0 || rg.exitCode === 1) {
      const excerpts = this.parseExcerpts(rg.stdout).map((e) => truncateExcerpt(e));
      return { backend: "rg", token: sessionToken, found: true, path: filePath, sizeBytes, excerpts, insufficient: excerpts.length === 0, advisory };
    }

    const grep = await this.exec("grep", ["-E", "-i", "-h", "-e", pattern, filePath]);
    if (grep.exitCode === 0 || grep.exitCode === 1) {
      const excerpts = this.parseExcerpts(grep.stdout).map((e) => truncateExcerpt(e));
      return { backend: "grep", token: sessionToken, found: true, path: filePath, sizeBytes, excerpts, insufficient: excerpts.length === 0, advisory };
    }

    return {
      backend: "none",
      token: sessionToken,
      found: true,
      path: filePath,
      sizeBytes,
      excerpts: [],
      insufficient: true,
      advisory,
      degraded: { reason: "unreadable", message: "Search backends (rg, grep) both failed on the session JSONL." },
    };
  }

  async search(rigName: string, question: string): Promise<SearchResult> {
    const rigDir = join(this.transcriptsRoot, rigName);

    if (!existsSync(rigDir)) {
      return { backend: "rg", excerpts: [], insufficient: true, noTranscriptDir: true };
    }

    const keywords = extractKeywords(question);
    if (keywords.length === 0) {
      return { backend: "none", excerpts: [], insufficient: true };
    }

    const pattern = keywords.join("|");

    // Try rg first — use -e to avoid dash-led patterns being parsed as flags
    const rgResult = await this.exec("rg", ["-i", "--no-filename", "-e", pattern, rigDir]);

    if (rgResult.exitCode === 0 || rgResult.exitCode === 1) {
      const excerpts = this.parseExcerpts(rgResult.stdout);
      // exit 0 = matches found, exit 1 = no matches → insufficient
      return { backend: "rg", excerpts, insufficient: excerpts.length === 0 };
    }

    // rg failed (exit code >= 2), fall back to grep
    const logFiles = this.getLogFiles(rigDir);
    if (logFiles.length === 0) {
      return { backend: "grep", excerpts: [], insufficient: true };
    }

    // Use -e for grep too — prevents dash-led patterns from being parsed as flags
    const grepResult = await this.exec("grep", ["-E", "-i", "-h", "-e", pattern, ...logFiles]);

    if (grepResult.exitCode === 0 || grepResult.exitCode === 1) {
      const excerpts = this.parseExcerpts(grepResult.stdout);
      return { backend: "grep", excerpts, insufficient: excerpts.length === 0 };
    }

    // Both backends failed (exit code 2+) — honest error
    return { backend: "none", excerpts: [], insufficient: true, error: "Search backends (rg, grep) both failed. Check that rg or grep is installed and the transcript directory is readable." };
  }

  /**
   * L1 — seat-scoped, cross-generation transcript search. Scopes to ONE seat's
   * `<rig>/<sessionName>.log` (never the whole rig dir) and labels every hit with
   * the generation (tenure) it fell in — the generations are the segments between
   * `--- SESSION BOUNDARY … ---` markers the seat's log accumulates as agents come
   * and go. Cross-generation is the point: a hit from before and after a boundary
   * proves the search spans tenures. Honest-degraded (never a silent zero-hits):
   * a missing / empty / boundary-only transcript says so.
   */
  async searchSeat(rigName: string, seatSessionName: string, question: string): Promise<SeatSearchResult> {
    const base = { backend: "read" as const, seat: seatSessionName, generations: 0, hits: [] as SeatHit[] };
    const filePath = join(this.transcriptsRoot, rigName, `${seatSessionName}.log`);

    if (!existsSync(filePath)) {
      return {
        ...base,
        insufficient: true,
        degraded: {
          reason: "capture_missing",
          message: `No transcript captured for seat '${seatSessionName}' in rig '${rigName}' — the seat may never have been managed on this host, or capture is disabled. This is not proof the seat never spoke.`,
        },
      };
    }

    let sizeBytes: number;
    let content: string;
    try {
      sizeBytes = statSync(filePath).size;
      if (sizeBytes === 0) {
        return {
          ...base,
          insufficient: true,
          degraded: {
            reason: "capture_empty",
            message: `Transcript for seat '${seatSessionName}' is empty (0 bytes) — no captured history yet, not proof the seat never spoke.`,
          },
        };
      }
      content = readFileSync(filePath, "utf-8");
    } catch {
      return {
        ...base,
        insufficient: true,
        degraded: {
          reason: "capture_unreadable",
          message: `Transcript for seat '${seatSessionName}' exists but could not be read (permissions or a transient FS error).`,
        },
      };
    }

    const advisory = sizeBytes > SEAT_LARGE_FILE_BYTES
      ? `Transcript is large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB); the full file was read — for a very large seat history prefer a more specific question.`
      : undefined;

    const keywords = extractKeywords(question);
    const pattern = keywords.length > 0 ? new RegExp(keywords.join("|"), "i") : null;

    let generation = 1;
    let sawConversation = false;
    const hits: SeatHit[] = [];
    for (const raw of content.split("\n")) {
      if (SEAT_BOUNDARY_RE.test(raw)) {
        generation += 1;
        continue;
      }
      const line = stripAnsi(raw).trim();
      if (line === "") continue;
      sawConversation = true;
      if (pattern && pattern.test(line)) hits.push({ generation, text: line });
    }
    const generations = generation; // boundaries + 1

    if (!sawConversation) {
      return {
        ...base,
        generations,
        insufficient: true,
        advisory,
        degraded: {
          reason: "boundary_only",
          message: `Seat '${seatSessionName}' transcript contains only session-boundary markers — no captured conversation. This host may be on boundary-only transcript capture; the record is degraded, not absent.`,
        },
      };
    }

    if (!pattern) {
      return { backend: "none", seat: seatSessionName, generations, hits: [], insufficient: true, advisory };
    }

    return { ...base, generations, hits, insufficient: hits.length === 0, advisory };
  }

  private parseExcerpts(stdout: string): string[] {
    if (!stdout.trim()) return [];
    return stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => stripAnsi(line).trim())
      .filter((line) => line !== "");
  }

  searchChat(rigId: string, question: string): ChatSearchResult[] {
    if (!this.chatSearchFn) return [];
    const keywords = extractKeywords(question);
    if (keywords.length === 0) return [];
    const pattern = keywords.join("|");
    return this.chatSearchFn(rigId, pattern);
  }

  private getLogFiles(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  }
}
