// PL-007 Workspace Primitive v0 — frontmatter validator (advisory).
//
// Walks a workspace root, parses each .md file's YAML frontmatter
// (delimited by `---` lines at the start of file), and validates per-kind
// required fields. Outputs a structured gap report:
//
//   - missing-required-field
//   - unrecognized-status-value
//   - parse-error  (frontmatter present but malformed)
//   - missing-frontmatter (no frontmatter delimiter found)
//
// Advisory only — never modifies files. curate-steward consumes the
// gap report as hygiene input. The validator is deliberately minimal at
// v0 (per PL-007 PRD); broken-cross-reference / non-conforming-structure
// rules are deferred to v1+.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkspaceKind } from "../types.js";
import { WORKSPACE_KINDS } from "../types.js";

export type FrontmatterGapKind =
  | "missing-required-field"
  | "unrecognized-status-value"
  | "parse-error"
  | "missing-frontmatter";

export interface FrontmatterGap {
  filePath: string;
  /** Path relative to the validation root, for stable cross-machine output. */
  relativePath: string;
  kind: FrontmatterGapKind;
  /** Field name when kind === "missing-required-field" or
   *  "unrecognized-status-value"; null otherwise. */
  field: string | null;
  message: string;
  /** Workspace kind the file was validated against (e.g. "knowledge"). */
  workspaceKind: WorkspaceKind | null;
}

export interface FrontmatterValidationReport {
  root: string;
  /** Workspace kind applied to all files under this root. v0: caller picks
   *  one root + one kind per invocation. */
  workspaceKind: WorkspaceKind | null;
  totalFiles: number;
  filesWithFrontmatter: number;
  gapCount: number;
  gaps: FrontmatterGap[];
}

const VALID_STATUS_VALUES = new Set(["active", "draft", "archived", "superseded"]);

/** Per-kind required frontmatter fields. v0 minimum baseline (advisory). */
const REQUIRED_FIELDS_BY_KIND: Record<WorkspaceKind, readonly string[]> = {
  user: ["doc"],
  project: ["doc"],
  knowledge: ["doc", "status", "created", "owner"],
  lab: ["doc", "status", "created", "owner"],
  delivery: ["doc", "status", "created", "owner"],
};

export interface ValidateOpts {
  root: string;
  workspaceKind?: WorkspaceKind;
  /** When true, recurse into subdirectories. Defaults to true. */
  recursive?: boolean;
  /** When true, validate every .md file even if frontmatter is absent
   *  (records a `missing-frontmatter` gap). Defaults to false — files
   *  without `---` are skipped silently (treated as informal notes). */
  requireFrontmatter?: boolean;
  /** Hard cap on files walked. Defaults to 10000. Prevents accidental
   *  multi-GB walks from runaway invocations. */
  maxFiles?: number;
}

/** Run the frontmatter validator. */
export function validateWorkspaceFrontmatter(opts: ValidateOpts): FrontmatterValidationReport {
  const root = path.resolve(opts.root);
  const recursive = opts.recursive ?? true;
  const requireFrontmatter = opts.requireFrontmatter ?? false;
  const maxFiles = opts.maxFiles ?? 10000;
  const kind = isValidKind(opts.workspaceKind) ? opts.workspaceKind! : null;

  const gaps: FrontmatterGap[] = [];
  let totalFiles = 0;
  let filesWithFrontmatter = 0;

  const walk = (dir: string): void => {
    if (totalFiles >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (totalFiles >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        // Skip noise dirs that aren't canon: node_modules, .git, .worktrees,
        // dist/build artifacts. Authors writing canon don't put these here.
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".worktrees" ||
          entry.name === "dist" ||
          entry.name === "build"
        ) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      totalFiles++;
      const result = validateFile(full, root, kind, requireFrontmatter);
      if (result.hasFrontmatter) filesWithFrontmatter++;
      gaps.push(...result.gaps);
    }
  };
  walk(root);

  return {
    root,
    workspaceKind: kind,
    totalFiles,
    filesWithFrontmatter,
    gapCount: gaps.length,
    gaps,
  };
}

function isValidKind(k: WorkspaceKind | undefined): k is WorkspaceKind {
  return typeof k === "string" && (WORKSPACE_KINDS as readonly string[]).includes(k);
}

interface FileValidation {
  hasFrontmatter: boolean;
  gaps: FrontmatterGap[];
}

function validateFile(
  filePath: string,
  root: string,
  kind: WorkspaceKind | null,
  requireFrontmatter: boolean,
): FileValidation {
  const relativePath = path.relative(root, filePath);
  const out: FileValidation = { hasFrontmatter: false, gaps: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return out;
  }

  const fm = extractFrontmatter(raw);
  if (!fm.found) {
    if (requireFrontmatter) {
      out.gaps.push({
        filePath,
        relativePath,
        kind: "missing-frontmatter",
        field: null,
        message: "no frontmatter delimiter (---) found at start of file",
        workspaceKind: kind,
      });
    }
    return out;
  }
  out.hasFrontmatter = true;

  let parsed: Record<string, unknown> | null;
  try {
    parsed = parseYaml(fm.body) as Record<string, unknown> | null;
  } catch (err) {
    out.gaps.push({
      filePath,
      relativePath,
      kind: "parse-error",
      field: null,
      message: err instanceof Error ? err.message : "YAML parse error",
      workspaceKind: kind,
    });
    return out;
  }
  if (!parsed || typeof parsed !== "object") {
    out.gaps.push({
      filePath,
      relativePath,
      kind: "parse-error",
      field: null,
      message: "frontmatter is not a YAML object",
      workspaceKind: kind,
    });
    return out;
  }

  if (kind) {
    const required = REQUIRED_FIELDS_BY_KIND[kind];
    for (const field of required) {
      if (!(field in parsed) || parsed[field] === null || parsed[field] === undefined || parsed[field] === "") {
        out.gaps.push({
          filePath,
          relativePath,
          kind: "missing-required-field",
          field,
          message: `${kind} canon requires "${field}" frontmatter field`,
          workspaceKind: kind,
        });
      }
    }
    // status enum check (only when status is present + a string)
    if (typeof parsed["status"] === "string" && !VALID_STATUS_VALUES.has(parsed["status"] as string)) {
      out.gaps.push({
        filePath,
        relativePath,
        kind: "unrecognized-status-value",
        field: "status",
        message: `status "${parsed["status"]}" is not one of: ${[...VALID_STATUS_VALUES].join(", ")}`,
        workspaceKind: kind,
      });
    }
  }
  return out;
}

interface FrontmatterExtraction {
  found: boolean;
  body: string;
}

/** Extract YAML frontmatter delimited by `---` lines. The opening `---`
 *  must be on the first line. Returns the frontmatter body (between the
 *  delimiters) when found. */
function extractFrontmatter(raw: string): FrontmatterExtraction {
  if (!raw.startsWith("---")) return { found: false, body: "" };
  // Find the closing delimiter, allowing both LF and CRLF line endings.
  const lines = raw.split(/\r?\n/);
  if (lines[0]!.trim() !== "---") return { found: false, body: "" };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      return { found: true, body: lines.slice(1, i).join("\n") };
    }
  }
  return { found: false, body: "" };
}
