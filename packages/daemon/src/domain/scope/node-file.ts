import fs from "node:fs";
import path from "node:path";

/**
 * The authored contract file at a work node, most-preferred first.
 *
 * `SPEC.md` is the current name; `README.md` is the legacy one and stays valid indefinitely — the
 * dormant missions and every historical proof receipt are README-backed and must keep resolving
 * with no migration and no warning. A node carrying both is not an error: SPEC.md wins, and audit
 * advises about the second file rather than blocking on it.
 *
 * THIS IS A DELIBERATE TWIN of the CLI's `lib/scope/scope-fs.ts` list, not an oversight. The daemon
 * cannot import packages/cli — there is no `@openrig/cli` dependency, stated in source in three
 * places — so the two scope implementations share a CONTRACT, never code. Change one and change the
 * other, or the product reads its own work tree two different ways.
 */
export const NODE_FILE_PRECEDENCE = ["SPEC.md", "README.md"] as const;

/** Current mission notes name followed by the indefinitely-readable legacy name. */
export const NOTES_FILE_PRECEDENCE = ["NOTES.md", "MISSION_NOTES.md"] as const;

export interface NotesFileResolution {
  path: string;
  name: (typeof NOTES_FILE_PRECEDENCE)[number];
}

/** Resolve the first readable mission notes file, preferring the current name. */
export function resolveNotesFile(absPath: string): NotesFileResolution | null {
  for (const name of NOTES_FILE_PRECEDENCE) {
    const candidate = path.join(absPath, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.R_OK);
      return { path: candidate, name };
    } catch {
      // Missing, unreadable, and non-file candidates all fall through to the next name.
    }
  }
  return null;
}

/**
 * Prepend the current node filename to a precedence list that already exists.
 *
 * Several readers here already searched multiple authored filenames in an order chosen for that
 * surface (`IMPLEMENTATION-PRD.md` ahead of `README.md` on slice bodies, for instance). Those
 * orders are load-bearing local decisions and this must not flatten them into one global ranking —
 * SPEC.md goes in front, everything else keeps the order it had.
 */
export function withSpecFirst(candidates: readonly string[]): string[] {
  return ["SPEC.md", ...candidates.filter((c) => c !== "SPEC.md")];
}

/** Resolve a work node's authored contract file, or null when the directory declares no node. */
export function resolveNodeFile(absPath: string): string | null {
  for (const name of NODE_FILE_PRECEDENCE) {
    const candidate = path.join(absPath, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolver for callers that read through an injected reader rather than `fs` directly (the review
 * gatherers, which are tested against in-memory trees). Returns the first candidate the reader
 * answers for, with its path — null when the node declares no authored file.
 */
export function resolveNodeFileVia(
  dir: string,
  read: (p: string) => string | null,
): { path: string; content: string } | null {
  for (const name of NODE_FILE_PRECEDENCE) {
    const candidate = path.join(dir, name);
    const content = read(candidate);
    if (content !== null && content !== undefined) return { path: candidate, content };
  }
  return null;
}

/** True when the filename is any authored node file — SPEC.md or the legacy README.md. */
export function isNodeFile(fileName: string): boolean {
  return (NODE_FILE_PRECEDENCE as readonly string[]).includes(fileName);
}
