// Fork Primitive + Starter Agent Images v0 (PL-016) — library service.
//
// Walks discovery roots, parses each image's manifest.yaml + stats.json,
// and emits AgentImageEntry records for daemon HTTP routes + UI library
// + CLI verb family. Mirrors ContextPackLibraryService (PL-014) in
// shape; differences:
//   - sourceResumeToken passes through to consumers (the instantiator
//     consumes it; the operator-facing surfaces redact it)
//   - stats.json is a separate file (mutable; updated atomically on
//     fork-count increment)
//   - .pinned sentinel file pins an image from prune
//
// Storage filesystem-canonical at ~/.openrig/agent-images/<name>/ +
// workspace-local .openrig/agent-images/<name>/. NO new SQLite tables.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { parseAgentImageManifest } from "./manifest-parser.js";
import {
  AgentImageError,
  type AgentImageEntry,
  type AgentImageEntryFile,
  type AgentImageManifest,
  type AgentImageSourceType,
  type AgentImageStats,
} from "./agent-image-types.js";

export interface AgentImageLibraryRoot {
  /** Absolute path to a directory whose immediate children are image dirs. */
  path: string;
  sourceType: AgentImageSourceType;
}

export interface AgentImageLibraryOpts {
  roots: AgentImageLibraryRoot[];
}

/** Stable id format: agent-image:<name>:<version> (parallel to context-pack:). */
export function agentImageId(name: string, version: string): string {
  return `agent-image:${name}:${version}`;
}

export function parseAgentImageId(id: string): { name: string; version: string } | null {
  if (!id.startsWith("agent-image:")) return null;
  const rest = id.slice("agent-image:".length);
  const last = rest.lastIndexOf(":");
  if (last === -1) return null;
  return { name: rest.slice(0, last), version: rest.slice(last + 1) };
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

const PINNED_SENTINEL = ".pinned";
const STATS_FILENAME = "stats.json";

const DEFAULT_STATS: AgentImageStats = {
  forkCount: 0,
  lastUsedAt: null,
  estimatedSizeBytes: 0,
  lineage: [],
};

export class AgentImageLibraryService {
  private entries = new Map<string, AgentImageEntry>();
  private readonly roots: AgentImageLibraryRoot[];

  constructor(opts: AgentImageLibraryOpts) {
    this.roots = opts.roots;
  }

  getRoots(): readonly AgentImageLibraryRoot[] {
    return this.roots;
  }

  scan(): { count: number; errors: Array<{ source: string; error: string }> } {
    const next = new Map<string, AgentImageEntry>();
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
        const imageDir = join(root.path, dirent.name);
        const manifestPath = join(imageDir, "manifest.yaml");
        if (!existsSync(manifestPath)) continue;
        try {
          const entry = this.readImageEntry(imageDir, manifestPath, root);
          // Last-wins on collision (workspace > user_file > builtin in
          // discovery order configured at startup).
          next.set(entry.id, entry);
        } catch (err) {
          errors.push({
            source: imageDir,
            error: err instanceof AgentImageError ? `${err.code}: ${err.message}` : (err as Error).message,
          });
        }
      }
    }
    this.entries = next;
    return { count: next.size, errors };
  }

  list(): AgentImageEntry[] {
    return Array.from(this.entries.values()).sort((a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );
  }

  get(id: string): AgentImageEntry | null {
    return this.entries.get(id) ?? null;
  }

  getByNameVersion(name: string, version: string): AgentImageEntry | null {
    return this.entries.get(agentImageId(name, version)) ?? null;
  }

  /**
   * Atomically increment the fork count + bump lastUsedAt on stats.json.
   * Used by the instantiator when an image is consumed via session_source:
   * mode: agent_image AND by the rig fork verb when forking from an image.
   * Best-effort: a stat-write failure surfaces as an AgentImageError but
   * does NOT abort the consumer (the image consumption path itself does
   * not depend on stats; the operator just loses fork-count visibility
   * on this consumption).
   */
  recordConsumption(id: string, now: () => Date = () => new Date()): void {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new AgentImageError("image_not_found", `agent image '${id}' not found in library`);
    }
    const statsPath = join(entry.sourcePath, STATS_FILENAME);
    let current: AgentImageStats = { ...entry.stats };
    try {
      if (existsSync(statsPath)) {
        const raw = readFileSync(statsPath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<AgentImageStats>;
        current = { ...current, ...parsed };
      }
    } catch {
      // Malformed stats.json — fall through with the in-memory copy.
    }
    const next: AgentImageStats = {
      forkCount: (current.forkCount ?? 0) + 1,
      lastUsedAt: now().toISOString(),
      estimatedSizeBytes: current.estimatedSizeBytes ?? entry.stats.estimatedSizeBytes,
      lineage: current.lineage ?? entry.stats.lineage,
    };
    try {
      writeFileSync(statsPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
    } catch (err) {
      throw new AgentImageError(
        "stats_write_failed",
        `failed to update stats.json for ${id}: ${(err as Error).message}`,
        { id, statsPath },
      );
    }
    // Mirror the new stats into the in-memory entry so subsequent reads
    // see the bumped fork-count without re-walking the filesystem.
    entry.stats = next;
  }

  /** Pin an image — creates a `.pinned` sentinel file inside the image directory. */
  pin(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new AgentImageError("image_not_found", `agent image '${id}' not found`);
    const sentinelPath = join(entry.sourcePath, PINNED_SENTINEL);
    writeFileSync(sentinelPath, new Date().toISOString() + "\n", "utf-8");
    entry.pinned = true;
  }

  /** Unpin — removes the `.pinned` sentinel. */
  unpin(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new AgentImageError("image_not_found", `agent image '${id}' not found`);
    const sentinelPath = join(entry.sourcePath, PINNED_SENTINEL);
    try {
      unlinkSync(sentinelPath);
    } catch {
      // Already absent — no-op.
    }
    entry.pinned = false;
  }

  private readImageEntry(
    imageDir: string,
    manifestPath: string,
    root: AgentImageLibraryRoot,
  ): AgentImageEntry {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = parseAgentImageManifest(raw, manifestPath);

    let mostRecentMtime = 0;
    let totalBytes = 0;
    try {
      const st = statSync(manifestPath);
      mostRecentMtime = st.mtimeMs;
      totalBytes += st.size;
    } catch { /* unreadable — fall through */ }

    const files: AgentImageEntryFile[] = manifest.files.map((mf) => {
      const abs = join(imageDir, mf.path);
      let bytes: number | null = null;
      let mtime = 0;
      try {
        const st = statSync(abs);
        bytes = st.size;
        mtime = st.mtimeMs;
        totalBytes += bytes;
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

    // Read stats.json if present; default to empty stats.
    const statsPath = join(imageDir, STATS_FILENAME);
    let stats: AgentImageStats = { ...DEFAULT_STATS };
    if (existsSync(statsPath)) {
      try {
        const statRaw = readFileSync(statsPath, "utf-8");
        const parsed = JSON.parse(statRaw) as Partial<AgentImageStats>;
        stats = {
          forkCount: typeof parsed.forkCount === "number" ? parsed.forkCount : 0,
          lastUsedAt: typeof parsed.lastUsedAt === "string" ? parsed.lastUsedAt : null,
          estimatedSizeBytes: typeof parsed.estimatedSizeBytes === "number" ? parsed.estimatedSizeBytes : totalBytes,
          lineage: Array.isArray(parsed.lineage) ? parsed.lineage.filter((l): l is string => typeof l === "string") : [],
        };
        const statStat = statSync(statsPath).mtimeMs;
        if (statStat > mostRecentMtime) mostRecentMtime = statStat;
      } catch {
        // Malformed stats — surface zero values; the daemon refresh
        // overwrites on next consumption.
      }
    }
    if (stats.estimatedSizeBytes === 0) stats.estimatedSizeBytes = totalBytes;
    if (stats.lineage.length === 0 && manifest.lineage) stats.lineage = [...manifest.lineage];

    const pinned = existsSync(join(imageDir, PINNED_SENTINEL));

    return {
      id: agentImageId(manifest.name, manifest.version),
      kind: "agent-image",
      name: manifest.name,
      version: manifest.version,
      runtime: manifest.runtime,
      sourceSeat: manifest.sourceSeat,
      sourceSessionId: manifest.sourceSessionId,
      sourceResumeToken: manifest.sourceResumeToken,
      notes: manifest.notes ?? null,
      createdAt: manifest.createdAt,
      sourceType: root.sourceType,
      sourcePath: imageDir,
      relativePath: relative(root.path, imageDir) || ".",
      updatedAt: new Date(mostRecentMtime || Date.now()).toISOString(),
      manifestEstimatedTokens: typeof manifest.estimatedTokens === "number" ? manifest.estimatedTokens : null,
      derivedEstimatedTokens,
      files,
      stats,
      lineage: stats.lineage,
      pinned,
    };
  }

  /** Write a fresh manifest + empty stats.json + cwd-deltas (if any) to a new image directory. */
  install(
    targetRootPath: string,
    manifest: AgentImageManifest,
    fileContents: Map<string, string>,
  ): string {
    const targetDir = join(targetRootPath, manifest.name);
    if (existsSync(targetDir)) {
      throw new AgentImageError(
        "image_referenced",
        `agent image directory already exists at ${targetDir}; choose a different name or remove the existing dir`,
        { name: manifest.name, targetDir },
      );
    }
    mkdirSync(targetDir, { recursive: true });
    // Emit manifest as YAML — write camelCase keys mapped to snake_case
    // for forward-compat with operator hand-edits.
    const yamlLines = [
      `name: ${manifest.name}`,
      `version: ${manifest.version}`,
      `runtime: ${manifest.runtime}`,
      `source_seat: ${quoteIfNeeded(manifest.sourceSeat)}`,
      `source_session_id: ${quoteIfNeeded(manifest.sourceSessionId)}`,
      `source_resume_token: ${quoteIfNeeded(manifest.sourceResumeToken)}`,
      `created_at: ${quoteIfNeeded(manifest.createdAt)}`,
    ];
    if (manifest.notes) {
      yamlLines.push(`notes: |`);
      for (const line of manifest.notes.split("\n")) yamlLines.push(`  ${line}`);
    }
    if (typeof manifest.estimatedTokens === "number") yamlLines.push(`estimated_tokens: ${manifest.estimatedTokens}`);
    if (manifest.lineage && manifest.lineage.length > 0) {
      yamlLines.push("lineage:");
      for (const l of manifest.lineage) yamlLines.push(`  - ${quoteIfNeeded(l)}`);
    }
    yamlLines.push("files:");
    for (const f of manifest.files) {
      yamlLines.push(`  - path: ${quoteIfNeeded(f.path)}`);
      yamlLines.push(`    role: ${quoteIfNeeded(f.role)}`);
      if (f.summary) yamlLines.push(`    summary: ${quoteIfNeeded(f.summary)}`);
    }
    writeFileSync(join(targetDir, "manifest.yaml"), yamlLines.join("\n") + "\n", "utf-8");
    // Empty stats — fork count starts at 0; lineage from manifest.
    const stats: AgentImageStats = {
      forkCount: 0,
      lastUsedAt: null,
      estimatedSizeBytes: 0,
      lineage: manifest.lineage ? [...manifest.lineage] : [],
    };
    writeFileSync(join(targetDir, STATS_FILENAME), JSON.stringify(stats, null, 2) + "\n", "utf-8");
    for (const [relPath, content] of fileContents) {
      if (relPath.includes("..") || relPath.startsWith("/")) {
        throw new AgentImageError(
          "manifest_invalid",
          `install file path '${relPath}' must be relative inside the image (no '..', no leading '/')`,
        );
      }
      const abs = join(targetDir, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
    return targetDir;
  }
}

function quoteIfNeeded(s: string): string {
  if (s === "" || /[:#\n@\\\s]/.test(s) || /^[!&*<>%`?,|\[\]{}'"]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}
