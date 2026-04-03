import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { SpecReviewService, SpecReviewError, type SourceState } from "./spec-review-service.js";

export interface SpecLibraryEntry {
  id: string;
  kind: "rig" | "agent";
  name: string;
  version: string;
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
}

export interface SpecLibraryOpts {
  roots: Array<{ path: string; sourceType: "builtin" | "user_file" }>;
  specReviewService: SpecReviewService;
}

function makeId(sourceType: string, relativePath: string): string {
  return createHash("sha256")
    .update(`${sourceType}:${relativePath}`)
    .digest("hex")
    .slice(0, 16);
}

function isYamlFile(filename: string): boolean {
  return filename.endsWith(".yaml") || filename.endsWith(".yml");
}

export class SpecLibraryService {
  private entries = new Map<string, SpecLibraryEntry>();
  private readonly roots: SpecLibraryOpts["roots"];
  private readonly specReviewService: SpecReviewService;

  constructor(opts: SpecLibraryOpts) {
    this.roots = opts.roots;
    this.specReviewService = opts.specReviewService;
  }

  scan(): void {
    const newEntries = new Map<string, SpecLibraryEntry>();

    for (const root of this.roots) {
      let files: string[];
      try {
        files = readdirSync(root.path).filter(isYamlFile);
      } catch {
        // Root doesn't exist or isn't readable — skip
        continue;
      }

      const sourceState: SourceState = root.sourceType === "builtin" ? "library_item" : "library_item";

      for (const filename of files) {
        const absPath = join(root.path, filename);
        const relPath = relative(root.path, absPath);

        let yaml: string;
        try {
          yaml = readFileSync(absPath, "utf-8");
        } catch {
          continue; // Can't read — skip
        }

        let stat: { mtimeMs: number };
        try {
          stat = statSync(absPath);
        } catch {
          continue;
        }

        const entry = this.classifySpec(yaml, root.sourceType, absPath, relPath, stat.mtimeMs);
        if (entry) {
          newEntries.set(entry.id, entry);
        }
      }
    }

    this.entries = newEntries;
  }

  list(filter?: { kind?: "rig" | "agent" }): SpecLibraryEntry[] {
    const entries = Array.from(this.entries.values());
    if (filter?.kind) {
      return entries.filter((e) => e.kind === filter.kind);
    }
    return entries;
  }

  get(id: string): { entry: SpecLibraryEntry; yaml: string } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    try {
      const yaml = readFileSync(entry.sourcePath, "utf-8");
      return { entry, yaml };
    } catch {
      return null;
    }
  }

  private classifySpec(
    yaml: string,
    sourceType: "builtin" | "user_file",
    absPath: string,
    relPath: string,
    mtimeMs: number,
  ): SpecLibraryEntry | null {
    // Try rig first
    try {
      const review = this.specReviewService.reviewRigSpec(yaml, "library_item");
      return {
        id: makeId(sourceType, relPath),
        kind: "rig",
        name: review.name,
        version: review.version,
        sourceType,
        sourcePath: absPath,
        relativePath: relPath,
        updatedAt: new Date(mtimeMs).toISOString(),
        summary: review.summary,
      };
    } catch {
      // Not a valid rig spec
    }

    // Try agent
    try {
      const review = this.specReviewService.reviewAgentSpec(yaml, "library_item");
      return {
        id: makeId(sourceType, relPath),
        kind: "agent",
        name: review.name,
        version: review.version,
        sourceType,
        sourcePath: absPath,
        relativePath: relPath,
        updatedAt: new Date(mtimeMs).toISOString(),
        summary: review.description,
      };
    } catch {
      // Not a valid agent spec either — skip
    }

    return null;
  }
}
