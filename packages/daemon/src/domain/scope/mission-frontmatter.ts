// The writer edits YAML nodes so comments, quoting, block scalars and nested fields survive. Writer readback,
// the mission route and the slice sidecar share this parse (LOCKSTEP); invalid headers read no status and edits
// fail untouched, with no lenient fallback. The shared span finder keeps the existing delimiter grammar.
import fs from "node:fs";
import { isMap, parseDocument, type Document } from "yaml";
import { findFrontmatterBlock } from "../frontmatter.js";
import { resolveNodeFile } from "./node-file.js";

/** Parse only the YAML header; the Markdown body never goes through a YAML serializer. */
export function legacyFrontmatter(text: string): { doc: Document; end: number } | null {
  const block = findFrontmatterBlock(text);
  if (!block) {
    if (/^---\r?\n/.test(text)) throw new Error("the YAML frontmatter has no closing delimiter");
    return null;
  }
  const doc = parseDocument(block.yaml);
  if (doc.errors.length) throw new Error(`it can't be parsed (${doc.errors[0]!.message})`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error("the YAML frontmatter is not a mapping");
  return { doc, end: block.bodyStart };
}

/** The top-level authored word, with YAML quoting, comments and nesting interpreted as the writer does. */
export function readLegacyMissionStatus(missionPath: string): string | null {
  const nodePath = resolveNodeFile(missionPath);
  if (!nodePath) return null;
  try {
    const value = legacyFrontmatter(fs.readFileSync(nodePath, "utf8"))?.doc.get("status");
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch { return null; }
}
