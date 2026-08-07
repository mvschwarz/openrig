import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

  constructor(opts: HistoryQueryOpts) {
    this.transcriptsRoot = opts.transcriptsRoot;
    this.exec = opts.exec;
    this.chatSearchFn = opts.chatSearchFn;
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
