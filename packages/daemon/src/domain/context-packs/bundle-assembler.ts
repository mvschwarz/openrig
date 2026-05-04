// Rig Context / Composable Context Injection v0 (PL-014) — bundle
// assembler.
//
// Concatenates a context_pack's included files into a single coherent
// paste-ready string. Each file gets a `## File: <path> (role: <role>)`
// header so the destination seat can recognize the bundle structure.
// The full bundle leads with a one-line manifest summary so the
// destination has at-a-glance context.
//
// One coherent paste, NOT N separate sends — matches PRD § Item 5: "the
// seat receives the pack as a single coherent priming injection."

import { readFileSync } from "node:fs";
import { ContextPackError, type ContextPackEntry } from "./context-pack-types.js";
import { estimateTokensFromBytes } from "./context-pack-library-service.js";

export interface AssembledBundle {
  /** Concatenated bundle string ready for SessionTransport.send. */
  text: string;
  /** Total length in bytes of the assembled string (UTF-8 encoded). */
  bytes: number;
  /** Daemon-derived estimate (chars / 4 rounded). */
  estimatedTokens: number;
  /** Per-file metadata threaded through assembly for the dry-run preview. */
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  /** Files that were referenced in the manifest but missing on disk;
   *  surfaced as a warning in the preview rather than a hard fail so
   *  operator can repair. */
  missingFiles: Array<{ path: string; role: string }>;
}

export interface AssembleOpts {
  packEntry: ContextPackEntry;
  /** Defaults to readFileSync; injected for tests. */
  readFile?: (absPath: string) => string;
}

const PACK_HEADER_PREFIX = "# OpenRig Context Pack:";
const FILE_HEADER_PREFIX = "## File:";

/**
 * Assembles a context pack into a single paste-ready string.
 *
 * Frame:
 *   # OpenRig Context Pack: <name> v<version>
 *   <purpose, if any>
 *
 *   ## File: <path> (role: <role>)
 *   <file contents>
 *
 *   ## File: <path> (role: <role>)
 *   <file contents>
 *
 *   ...
 *
 * Each file is separated by a blank line so adjacent contents don't
 * accidentally merge into a contiguous markdown block. Missing files
 * are skipped (operator sees them in `missingFiles` for repair).
 */
export function assembleBundle(opts: AssembleOpts): AssembledBundle {
  const { packEntry } = opts;
  const reader = opts.readFile ?? ((p: string) => readFileSync(p, "utf-8"));

  const sections: string[] = [];
  sections.push(`${PACK_HEADER_PREFIX} ${packEntry.name} v${packEntry.version}`);
  if (packEntry.purpose) {
    sections.push(packEntry.purpose.trim());
  }

  const files: AssembledBundle["files"] = [];
  const missingFiles: AssembledBundle["missingFiles"] = [];

  for (const f of packEntry.files) {
    if (f.absolutePath === null) {
      missingFiles.push({ path: f.path, role: f.role });
      continue;
    }
    let content: string;
    try {
      content = reader(f.absolutePath);
    } catch (err) {
      throw new ContextPackError(
        "file_read_failed",
        `failed to read pack file ${f.absolutePath}: ${(err as Error).message}`,
        { packId: packEntry.id, path: f.path },
      );
    }
    const headerLine = f.summary
      ? `${FILE_HEADER_PREFIX} ${f.path} (role: ${f.role}) — ${f.summary}`
      : `${FILE_HEADER_PREFIX} ${f.path} (role: ${f.role})`;
    sections.push(headerLine);
    sections.push(content.trimEnd());
    const bytes = Buffer.byteLength(content, "utf-8");
    files.push({
      path: f.path,
      role: f.role,
      bytes,
      estimatedTokens: estimateTokensFromBytes(bytes),
    });
  }

  const text = sections.join("\n\n") + "\n";
  const bytes = Buffer.byteLength(text, "utf-8");
  return {
    text,
    bytes,
    estimatedTokens: estimateTokensFromBytes(bytes),
    files,
    missingFiles,
  };
}
