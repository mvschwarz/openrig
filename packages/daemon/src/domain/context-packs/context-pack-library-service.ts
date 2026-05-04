// Rig Context / Composable Context Injection v0 (PL-014) — library
// service.
//
// Walks the configured discovery roots, parses each pack's
// manifest.yaml, and emits ContextPackEntry records ready for the
// daemon HTTP routes + UI library + send mechanism. Workspace-surface
// reconciliation: the operator's filesystem edit always wins on next
// scan() (matches PL-004 Phase D's contract for workflow_specs).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseManifest } from "./manifest-parser.js";
import {
  ContextPackError,
  type ContextPackEntry,
  type ContextPackEntryFile,
  type ContextPackSourceType,
} from "./context-pack-types.js";

export interface ContextPackLibraryRoot {
  /** Absolute path to a directory whose immediate children are pack dirs. */
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
  private readonly roots: ContextPackLibraryRoot[];

  constructor(opts: ContextPackLibraryOpts) {
    this.roots = opts.roots;
  }

  /** Re-walk all roots, replace the in-memory index, return a count. */
  scan(): { count: number; errors: Array<{ source: string; error: string }> } {
    const next = new Map<string, ContextPackEntry>();
    const errors: Array<{ source: string; error: string }> = [];

    for (const root of this.roots) {
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = existsSync(root.path)
          ? readdirSync(root.path, { withFileTypes: true })
          : [];
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const packDir = join(root.path, dirent.name);
        const manifestPath = join(packDir, "manifest.yaml");
        if (!existsSync(manifestPath)) continue;
        try {
          const entry = this.readPackEntry(packDir, manifestPath, root);
          // Last-wins: workspace > user_file > builtin in the discovery
          // order configured by startup.
          next.set(entry.id, entry);
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
    return { count: next.size, errors };
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
