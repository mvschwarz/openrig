// Rig Context / Composable Context Injection v0 (PL-014) — typed primitive
// shared types.
//
// A context_pack is a directory containing `manifest.yaml` + included
// markdown / yaml / txt files. Operator-authored, library-discoverable,
// reviewable, sendable. Parallel to skills + workflow_specs in shape.
//
// MVP single-host context: storage filesystem-canonical at
// ~/.openrig/context-packs/<name>/ (host) + workspace-local
// .openrig/context-packs/<name>/. NO new SQLite tables; library cache
// is in-memory at the daemon scope.

export interface ContextPackManifestFile {
  /** Relative path within the pack directory. */
  path: string;
  /** Free-form operator-defined role (e.g., "prd", "proof-packet",
   *  "architecture-brief"); closed enum at v1+ if patterns emerge. */
  role: string;
  /** One-line description rendered in the review pane and bundle frame. */
  summary?: string;
}

export interface ContextPackManifest {
  name: string;
  version: string;
  purpose?: string;
  files: ContextPackManifestFile[];
  /** Operator-supplied estimate (used as a hint when no per-file
   *  estimate is available); the library service computes a derived
   *  `derivedEstimatedTokens` from actual file sizes for display. */
  estimatedTokens?: number;
}

export type ContextPackSourceType = "builtin" | "user_file" | "workspace";

/** Library-shaped record emitted by ContextPackLibraryService. */
export interface ContextPackEntry {
  /** Stable identifier for routes / UI navigation:
   *  `context-pack:<name>:<version>`. */
  id: string;
  kind: "context-pack";
  name: string;
  version: string;
  purpose: string | null;
  sourceType: ContextPackSourceType;
  /** Absolute path to the pack directory. */
  sourcePath: string;
  /** Path relative to the discovery root that found this pack. */
  relativePath: string;
  /** ISO timestamp of the most recent mtime under the pack dir
   *  (manifest.yaml or any included file — whichever is newer). */
  updatedAt: string;
  /** Operator-supplied estimate from the manifest, or null. */
  manifestEstimatedTokens: number | null;
  /** Daemon-derived estimate from actual file sizes (chars / 4
   *  rounded — matches the existing context-usage convention). */
  derivedEstimatedTokens: number;
  /** Per-file metadata projected from the manifest + on-disk reads. */
  files: ContextPackEntryFile[];
}

export interface ContextPackEntryFile {
  path: string;
  role: string;
  summary: string | null;
  /** Absolute path to the file on disk; null when manifest references
   *  a file that doesn't exist (the entry surfaces honestly with
   *  bytes=null instead of refusing to index). */
  absolutePath: string | null;
  /** File size in bytes; null when missing or unreadable. */
  bytes: number | null;
  /** Daemon-derived per-file token estimate (chars / 4 rounded). */
  estimatedTokens: number | null;
}

export class ContextPackError extends Error {
  constructor(
    public readonly code:
      | "manifest_missing"
      | "manifest_parse_error"
      | "manifest_invalid"
      | "pack_not_found"
      | "file_outside_pack"
      | "file_read_failed",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContextPackError";
  }
}
