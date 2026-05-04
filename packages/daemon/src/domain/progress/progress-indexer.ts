// UI Enhancement Pack v0 — workspace PROGRESS.md indexer.
//
// Walks operator-allowlisted scan roots, finds PROGRESS.md files,
// parses each into a checkbox-hierarchy tree, and emits a normalized
// payload consumed by:
//   - GET /api/progress/tree (the new top-level Progress browse view)
//   - the new ProgressTree React component
//
// Scan strategy (item 1B):
//   - Operator configures progress-scan roots via env var
//     OPENRIG_PROGRESS_SCAN_ROOTS=root1:/abs/path,root2:/abs/path
//     (same delimited-pair shape as OPENRIG_FILES_ALLOWLIST).
//   - For each configured root, recursively find PROGRESS.md files
//     up to a small max depth (default 6) — enough to catch
//     mission/lane/slice nesting without descending into node_modules
//     or other deep trees.
//   - Each PROGRESS.md becomes one mission/lane/slice node; rows
//     parsed from `[ ]` / `[x]` / `[~]` checkbox lines + Markdown
//     headings (## / ###) for hierarchy.
//
// MVP single-host: in-memory walk per request; no caching at v0
// (file count is bounded by operator's allowlist scope; sub-second
// for the typical workspace).

import * as fs from "node:fs";
import * as path from "node:path";

export type CheckboxStatus = "active" | "done" | "blocked" | "unknown";

export interface ProgressRow {
  /** 1-based source line number. */
  line: number;
  /** Indent depth (0 = top-level; nested by 2-space indent / Markdown heading depth). */
  depth: number;
  /** Parsed status from the `[x]` / `[ ]` / `[~]` syntax. */
  status: CheckboxStatus;
  /** The text after the checkbox (or the heading text when this row is a heading). */
  text: string;
  /** "checkbox" for `[ ]` lines; "heading" for `##` / `###`. */
  kind: "checkbox" | "heading";
}

export interface ProgressFileNode {
  /** Operator-supplied scan-root display name. */
  rootName: string;
  /** Path relative to the scan root (e.g., "missions/foo/PROGRESS.md"). */
  relPath: string;
  /** Canonical absolute path on disk (handy for the UI's "open in editor" affordance). */
  absolutePath: string;
  mtime: string;
  rows: ProgressRow[];
  /** Top-level title (from frontmatter or first H1). */
  title: string | null;
  /** Aggregate counts derived from rows (kind === "checkbox"). */
  counts: { total: number; done: number; blocked: number; active: number };
}

export interface ProgressScanRoot {
  name: string;
  canonicalPath: string;
}

export interface ProgressTreeResult {
  files: ProgressFileNode[];
  /** Aggregate over all files. */
  aggregate: { totalFiles: number; totalRows: number; totalDone: number; totalBlocked: number; totalActive: number };
  /** Roots that were scanned (for the UI to render "scanned N roots"). */
  scannedRoots: ProgressScanRoot[];
}

const DEFAULT_MAX_DEPTH = 6;
const PROGRESS_FILENAME = "PROGRESS.md";
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".turbo", ".next"]);

const ENV_VAR = "OPENRIG_PROGRESS_SCAN_ROOTS";
const LEGACY_ENV_VAR = "RIGGED_PROGRESS_SCAN_ROOTS";

export function readProgressRootsFromEnv(env: NodeJS.ProcessEnv = process.env): ProgressScanRoot[] {
  const raw = env[ENV_VAR] ?? env[LEGACY_ENV_VAR] ?? "";
  if (!raw.trim()) return [];
  const out = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const rawPath = trimmed.slice(colon + 1).trim();
    if (!name || !rawPath || !path.isAbsolute(rawPath)) continue;
    let canonical: string;
    try { canonical = fs.realpathSync(rawPath); } catch { canonical = path.resolve(rawPath); }
    out.set(name, canonical);
  }
  return Array.from(out.entries()).map(([name, canonicalPath]) => ({ name, canonicalPath }));
}

export interface ProgressIndexerOpts {
  roots: ProgressScanRoot[];
  /** Override max recursion depth for tests. */
  maxDepth?: number;
}

export class ProgressIndexer {
  private readonly roots: ProgressScanRoot[];
  private readonly maxDepth: number;

  constructor(opts: ProgressIndexerOpts) {
    this.roots = opts.roots;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  isReady(): boolean {
    return this.roots.length > 0;
  }

  scan(): ProgressTreeResult {
    const files: ProgressFileNode[] = [];
    for (const root of this.roots) {
      this.walkRoot(root, files);
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const aggregate = files.reduce(
      (acc, f) => ({
        totalFiles: acc.totalFiles + 1,
        totalRows: acc.totalRows + f.counts.total,
        totalDone: acc.totalDone + f.counts.done,
        totalBlocked: acc.totalBlocked + f.counts.blocked,
        totalActive: acc.totalActive + f.counts.active,
      }),
      { totalFiles: 0, totalRows: 0, totalDone: 0, totalBlocked: 0, totalActive: 0 },
    );
    return { files, aggregate, scannedRoots: this.roots };
  }

  private walkRoot(root: ProgressScanRoot, out: ProgressFileNode[]): void {
    this.walkDir(root, root.canonicalPath, "", 0, out);
  }

  private walkDir(root: ProgressScanRoot, abs: string, rel: string, depth: number, out: ProgressFileNode[]): void {
    if (depth > this.maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        this.walkDir(root, childAbs, childRel, depth + 1, out);
      } else if (entry.isFile() && entry.name === PROGRESS_FILENAME) {
        const node = this.parseProgressFile(root, childAbs, childRel);
        if (node) out.push(node);
      }
    }
  }

  private parseProgressFile(root: ProgressScanRoot, absolutePath: string, relPath: string): ProgressFileNode | null {
    let content: string;
    let mtime: Date;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
      mtime = fs.statSync(absolutePath).mtime;
    } catch { return null; }

    const rows: ProgressRow[] = [];
    const lines = content.split("\n");
    let title: string | null = null;
    let inFrontmatter = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNumber = i + 1;

      // Skip YAML frontmatter.
      if (lineNumber === 1 && line.trim() === "---") { inFrontmatter = true; continue; }
      if (inFrontmatter) {
        if (line.trim() === "---") inFrontmatter = false;
        continue;
      }

      // First H1 → title (if frontmatter didn't supply one).
      if (!title) {
        const h1 = line.match(/^#\s+(.+?)$/);
        if (h1) title = h1[1]!.trim();
      }

      // Heading rows (## / ###).
      const h = line.match(/^(#{2,4})\s+(.+?)$/);
      if (h) {
        rows.push({
          line: lineNumber,
          depth: h[1]!.length - 2, // ## → 0, ### → 1, #### → 2
          status: "unknown",
          text: h[2]!.trim(),
          kind: "heading",
        });
        continue;
      }

      // Checkbox rows. Match either bare `[ ]` (no list bullet) or
      // `- [ ]` / `* [ ]`. The bullet's leading indent determines depth.
      const cb = line.match(/^(\s*)(?:[-*]\s+)?\[([ xX~])\]\s+(.+)$/);
      if (cb) {
        const indentSpaces = cb[1]!.length;
        const indicator = cb[2]!.toLowerCase();
        const text = cb[3]!.trim();
        const status: CheckboxStatus =
          indicator === "x" ? "done"
          : indicator === "~" ? "blocked"
          : "active";
        rows.push({
          line: lineNumber,
          depth: Math.floor(indentSpaces / 2),
          status,
          text,
          kind: "checkbox",
        });
      }
    }

    const checkboxes = rows.filter((r) => r.kind === "checkbox");
    const counts = {
      total: checkboxes.length,
      done: checkboxes.filter((r) => r.status === "done").length,
      blocked: checkboxes.filter((r) => r.status === "blocked").length,
      active: checkboxes.filter((r) => r.status === "active").length,
    };

    return {
      rootName: root.name,
      relPath,
      absolutePath,
      mtime: mtime.toISOString(),
      rows,
      title,
      counts,
    };
  }
}
