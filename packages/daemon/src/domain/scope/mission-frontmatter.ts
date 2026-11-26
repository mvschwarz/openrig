import fs from "node:fs";
import { isMap, parseDocument, type Document } from "yaml";
import { resolveNodeFile } from "./node-file.js";

/** Parse only the YAML header; the Markdown body never goes through a YAML serializer. */
export function legacyFrontmatter(text: string): { doc: Document; end: number } | null {
  const match = text.match(/^---\r?\n((?:[\s\S]*?\r?\n)?)---(?=\r?\n|$)/);
  if (!match) {
    if (/^---\r?\n/.test(text)) throw new Error("the YAML frontmatter has no closing delimiter");
    return null;
  }
  const doc = parseDocument(match[1]!);
  if (doc.errors.length) throw new Error(`it can't be parsed (${doc.errors[0]!.message})`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error("the YAML frontmatter is not a mapping");
  return { doc, end: match[0].length };
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
