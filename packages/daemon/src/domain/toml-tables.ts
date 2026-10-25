import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";

/** The key path a TOML table header line opens (`[projects.'/p']`, `[projects."/p"]`, `[ a . b ]`, with a comment…),
 *  read by the TOML parser; null for any other line. Codex saves its own tables with literal-quoted keys, so a
 *  writer finds a table by its key, not its text. */
export function tomlTableHeaderPath(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) return null;
  let node: unknown;
  try { node = parseToml(trimmed); } catch { return null; }
  const path: string[] = [];
  while (node !== null && typeof node === "object" && !Array.isArray(node)) {
    const keys = Object.keys(node);
    if (keys.length !== 1) return keys.length === 0 && path.length > 0 ? path : null;
    path.push(keys[0]!);
    node = (node as Record<string, unknown>)[keys[0]!];
  }
  return null;
}

/** The key path an array-of-tables header line opens (`[[hooks.Stop]]`, `[[hooks."Stop".hooks]]`…), read by the TOML
 *  parser; null for any other line. */
export function tomlArrayTableHeaderPath(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[[")) return null;
  let node: unknown;
  try { node = parseToml(trimmed); } catch { return null; }
  const path: string[] = [];
  while (node !== null && typeof node === "object" && !Array.isArray(node)) {
    const keys = Object.keys(node);
    if (keys.length !== 1) return null;
    path.push(keys[0]!);
    node = (node as Record<string, unknown>)[keys[0]!];
  }
  return Array.isArray(node) && node.length === 1 && Object.keys(node[0] as object).length === 0 ? path : null;
}

/** The document's parsed root, or null when it doesn't parse. */
export function parseTomlRoot(lines: string[]): Record<string, unknown> | null {
  try { return parseToml(lines.join("\n")); } catch { return null; }
}

/** Whether line `at` opens a table in the document, rather than sitting inside a multi-line string (an example in a
 *  person's instructions, say): swapped for a probe header the document doesn't already have, the parsed document gains
 *  that table. An unreadable document proves nothing, so its writers leave it as it is. */
export function opensTomlTable(lines: string[], at: number, root = parseTomlRoot(lines)): boolean {
  if (!root) return false;
  let probe = `openrig-header-probe-${at}`;
  while (Object.hasOwn(root, probe)) probe += "-";
  try { return Object.hasOwn(parseToml([...lines.slice(0, at), `[${probe}]`, ...lines.slice(at + 1)].join("\n")), probe); }
  catch { return false; }
}

/** The line that opens table `path`, in any key spelling, or -1. */
export function findTomlTable(lines: string[], path: string[]): number {
  const candidates = lines.flatMap((line, at) => isDeepStrictEqual(tomlTableHeaderPath(line), path) ? [at] : []);
  if (candidates.length === 0) return -1;
  const root = parseTomlRoot(lines);
  return candidates.find((at) => opensTomlTable(lines, at, root)) ?? -1;
}

/** Whether a document already defines `path` another way (an inline table, dotted keys). Appending a table for it would
 *  then be a duplicate key, and Codex refuses to start. An unreadable document counts as defined: it's left as it is,
 *  since an append can't make it readable and would stack another table on every launch. */
export function tomlDefines(content: string, path: string[]): boolean {
  let node: unknown;
  try { node = parseToml(content); } catch { return true; }
  for (const key of path) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}
