import nodePath from "node:path";

/** A shared root as GET /api/files/roots lists it, and a file as GET /api/files/read returns it. */
export type SharedRoot = { name: string; path: string };
export type FileRead = { root?: string; path?: string; content?: string; binary?: boolean; size?: number; mtime?: string; truncated?: boolean; truncatedAtBytes?: number | null; totalBytes?: number };

/** The shared root an absolute path falls under as written, and its path inside that root. The reference names a file
 *  where the daemon runs, which may be another machine, so it's never resolved through this machine's filesystem; the
 *  daemon still checks containment itself when the file is read. */
export function underSharedRoot(roots: SharedRoot[], absolute: string): { root: string; path: string } | null {
  for (const root of roots) {
    const inside = nodePath.relative(root.path, absolute);
    if (inside && inside !== ".." && !inside.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(inside)) return { root: root.name, path: inside };
  }
  return null;
}

/** Which file an item's evidenceRef names under the daemon's shared roots, or why none is read. `root` names the shared
 *  root a relative evidenceRef is under. Shared by rig_artifact_read and rig queue artifact. */
export function planItemArtifact(ref: unknown, roots: SharedRoot[], root?: string): { read: { root: string; path: string } } | { unavailable: string } {
  if (typeof ref !== "string" || !ref.trim()) return { unavailable: "This item names no artifact: it has no evidenceRef." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return { unavailable: "The evidenceRef is a link, not a file in a shared root: open it where it lives." };
  if (roots.length === 0) return { unavailable: "This daemon shares no roots (OPENRIG_FILES_ALLOWLIST is empty), so no artifact can be read through it." };
  if (!nodePath.isAbsolute(ref)) {
    return root ? { read: { root, path: ref } } : { unavailable: "The evidenceRef is a relative path: name the shared root it's under (root)." };
  }
  const shared = underSharedRoot(roots, ref);
  return shared ? { read: shared }
    : { unavailable: "The evidenceRef is outside every shared root as the daemon lists them, so it isn't read. If it reaches a root through a link, read the file with root and path." };
}

export const CODE_RESULT_KIND = "openrig.code-result/v1";

/** A code result's exact pair: the commit the work started from and the one it produced, in one repository. */
export interface CodeResult {
  repo: string;
  base: string;
  revision: string;
  paths: string[];
  /** Informational: a branch moves, so it's never the revision. */
  branch?: string;
  /** Where the revision can be fetched from when a local clone lacks it. */
  fetch?: { remote: string; ref: string };
}

// A full commit id, SHA-1 or SHA-256. A short id or a branch isn't exact.
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The code result in an artifact an assignee wrote as its evidenceRef: only from a whole text file of this kind whose
 *  base and revision are full commit ids. A file of the kind that doesn't qualify says why; any other file is no code
 *  result, and reads as before. */
export function codeResultOf(read: FileRead): { codeResult: CodeResult } | { codeResultIssue: string } | null {
  if (read.binary || read.truncated || typeof read.content !== "string") return null;
  let doc: unknown;
  try { doc = JSON.parse(read.content); } catch { return null; }
  if (!isRecord(doc) || doc.kind !== CODE_RESULT_KIND) return null;
  const issue = (why: string) => ({ codeResultIssue: `${CODE_RESULT_KIND}: ${why}` });
  if (typeof doc.repo !== "string" || !doc.repo.trim()) return issue("repo must name the repository, as an absolute path or a URL");
  for (const key of ["base", "revision"] as const) {
    const value = doc[key];
    if (typeof value !== "string" || !COMMIT.test(value)) return issue(`${key} must be a full commit id (40 or 64 lowercase hex), not a branch or a short id`);
  }
  const { paths, branch, fetch } = doc;
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.length > 0))) return issue("paths must be a list of repository paths");
  if (branch !== undefined && typeof branch !== "string") return issue("branch must be a string");
  if (fetch !== undefined && !(isRecord(fetch) && typeof fetch.remote === "string" && fetch.remote.trim() && typeof fetch.ref === "string" && fetch.ref.trim())) {
    return issue("fetch must name a remote and a ref");
  }
  return { codeResult: {
    repo: doc.repo, base: doc.base as string, revision: doc.revision as string, paths: (paths as string[] | undefined) ?? [],
    ...(typeof branch === "string" ? { branch } : {}),
    ...(isRecord(fetch) ? { fetch: { remote: fetch.remote as string, ref: fetch.ref as string } } : {}),
  } };
}
