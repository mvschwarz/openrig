// Rig Context / Composable Context Injection v0 (PL-014) — library
// service.
//
// Walks the configured discovery roots, parses each pack's
// manifest.yaml, and emits ContextPackEntry records ready for the
// daemon HTTP routes + UI library + send mechanism. Workspace-surface
// reconciliation: the operator's filesystem edit always wins on next
// scan() (matches PL-004 Phase D's contract for workflow_specs).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assertSafePackRef } from "./ref-safety.js";
import { parseManifest } from "./manifest-parser.js";
import {
  ContextPackError,
  type ContextPackEntry,
  type ContextPackEntryFile,
  type ContextPackSourceType,
} from "./context-pack-types.js";

export interface ContextPackLibraryRoot {
  /** Absolute path to a discovery root. Slice-03 Atom 2: a pack is any
   *  NESTED directory containing manifest.yaml; its ref is the relative
   *  path from this root (spec §2 path-like refs, e.g.
   *  `packs/compaction-restore`). */
  path: string;
  sourceType: ContextPackSourceType;
}

export interface ContextPackLibraryOpts {
  roots: ContextPackLibraryRoot[];
}

/** Stable id format: context-pack:<name>:<version>. */
export function contextPackId(name: string, version: string): string {
  return `context-pack:${name}:${version}`;
}

export function parseContextPackId(id: string): { name: string; version: string } | null {
  if (!id.startsWith("context-pack:")) return null;
  const rest = id.slice("context-pack:".length);
  const last = rest.lastIndexOf(":");
  if (last === -1) return null;
  return { name: rest.slice(0, last), version: rest.slice(last + 1) };
}

/** Daemon-derived per-file token estimate. Same heuristic the existing
 *  context-usage-store uses (≈4 chars/token); cheap, stable, no
 *  dependency on a tokenizer library. */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export class ContextPackLibraryService {
  private entries = new Map<string, ContextPackEntry>();
  /** Slice-03 Atom 2: path-like ref → colon id, maintained by scan() with the
   *  same last-wins root precedence as the id index. Refs are ADDED alongside
   *  colon ids; the id strip is explicitly a later atom. */
  private refIndex = new Map<string, string>();
  private readonly roots: ContextPackLibraryRoot[];

  constructor(opts: ContextPackLibraryOpts) {
    this.roots = opts.roots;
  }

  /** Slice-03 Atom 2 — recursive path-addressed discovery: walk a root and
   *  return every NESTED dir containing manifest.yaml, with its path-like
   *  ref. Packs are LEAVES: a manifest-bearing dir's subtree belongs to that
   *  pack, so discovery does not descend below it (a nested manifest would
   *  make the outer pack's files ambiguous). Symlinked dirs are never
   *  traversed (dirent.isDirectory() is lstat-shaped — the pre-Atom-2
   *  semantics, carried into the recursion). */
  private discoverPackDirs(rootPath: string): Array<{ packDir: string; ref: string }> {
    const found: Array<{ packDir: string; ref: string }> = [];
    const walk = (dir: string): void => {
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const child = join(dir, dirent.name);
        if (existsSync(join(child, "manifest.yaml"))) {
          found.push({ packDir: child, ref: relative(rootPath, child).split(sep).join("/") });
        } else {
          walk(child);
        }
      }
    };
    if (existsSync(rootPath)) walk(rootPath);
    return found;
  }

  /** Re-walk all roots, replace the in-memory index, return a count. */
  scan(): { count: number; errors: Array<{ source: string; error: string }> } {
    const next = new Map<string, ContextPackEntry>();
    const nextRefs = new Map<string, string>();
    const errors: Array<{ source: string; error: string }> = [];

    for (const root of this.roots) {
      for (const { packDir, ref } of this.discoverPackDirs(root.path)) {
        // DISCOVERY trust boundary (Atom 2): every discovered ref passes the
        // sealed per-segment contract; an unsafe on-disk ref is a STRUCTURED,
        // FAIL-VISIBLE error and the pack is skipped — never indexed.
        try {
          assertSafePackRef(ref);
        } catch (err) {
          errors.push({ source: packDir, error: (err as Error).message });
          continue;
        }
        try {
          const entry = this.readPackEntry(packDir, join(packDir, "manifest.yaml"), root);
          // Last-wins: workspace > user_file > builtin in the discovery
          // order configured by startup — for BOTH indexes.
          next.set(entry.id, entry);
          nextRefs.set(entry.relativePath, entry.id);
        } catch (err) {
          errors.push({
            source: packDir,
            error: err instanceof ContextPackError
              ? `${err.code}: ${err.message}`
              : (err as Error).message,
          });
        }
      }
    }
    this.entries = next;
    this.refIndex = nextRefs;
    return { count: next.size, errors };
  }

  /** Slice-03 Atom 2 — RESOLVE trust boundary: get a pack by its path-like
   *  ref. An unsafe ref is a structured, fail-visible error BEFORE any
   *  lookup; a safe-but-absent ref is an honest null. */
  getByRef(ref: string): ContextPackEntry | null {
    try {
      assertSafePackRef(ref);
    } catch (err) {
      throw new ContextPackError("unsafe_ref", (err as Error).message, { ref });
    }
    const id = this.refIndex.get(ref);
    return id ? this.entries.get(id) ?? null : null;
  }

  list(): ContextPackEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  }

  get(id: string): ContextPackEntry | null {
    return this.entries.get(id) ?? null;
  }

  getByNameVersion(name: string, version: string): ContextPackEntry | null {
    return this.entries.get(contextPackId(name, version)) ?? null;
  }

  /** Resolve the absolute file path for a pack entry's file, with a
   *  containment check that prevents path-traversal escaping the pack
   *  directory. */
  resolveFileWithinPack(packEntry: ContextPackEntry, relPath: string): string {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      throw new ContextPackError(
        "file_outside_pack",
        `relative path '${relPath}' must be inside the pack directory (no '..', no leading '/')`,
        { packId: packEntry.id, relPath },
      );
    }
    const abs = join(packEntry.sourcePath, relPath);
    if (!abs.startsWith(packEntry.sourcePath + "/") && abs !== packEntry.sourcePath) {
      throw new ContextPackError(
        "file_outside_pack",
        `resolved path '${abs}' falls outside pack '${packEntry.sourcePath}'`,
        { packId: packEntry.id, relPath, resolved: abs },
      );
    }
    return abs;
  }

  private readPackEntry(
    packDir: string,
    manifestPath: string,
    root: ContextPackLibraryRoot,
  ): ContextPackEntry {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = parseManifest(raw, manifestPath);

    let mostRecentMtime = 0;
    try {
      mostRecentMtime = statSync(manifestPath).mtimeMs;
    } catch { /* unreadable manifest stat → fall back to 0 */ }

    const files: ContextPackEntryFile[] = manifest.files.map((mf) => {
      const abs = join(packDir, mf.path);
      let bytes: number | null = null;
      let mtime = 0;
      try {
        const st = statSync(abs);
        bytes = st.size;
        mtime = st.mtimeMs;
      } catch {
        bytes = null;
      }
      if (mtime > mostRecentMtime) mostRecentMtime = mtime;
      return {
        path: mf.path,
        role: mf.role,
        summary: mf.summary ?? null,
        absolutePath: bytes === null ? null : abs,
        bytes,
        estimatedTokens: bytes === null ? null : estimateTokensFromBytes(bytes),
      };
    });

    const derivedEstimatedTokens = files.reduce((acc, f) => acc + (f.estimatedTokens ?? 0), 0);

    return {
      id: contextPackId(manifest.name, manifest.version),
      kind: "context-pack",
      name: manifest.name,
      version: manifest.version,
      purpose: manifest.purpose ?? null,
      sourceType: root.sourceType,
      sourcePath: packDir,
      relativePath: relative(root.path, packDir) || ".",
      updatedAt: new Date(mostRecentMtime || Date.now()).toISOString(),
      manifestEstimatedTokens: typeof manifest.estimatedTokens === "number" ? manifest.estimatedTokens : null,
      derivedEstimatedTokens,
      files,
    };
  }
}
