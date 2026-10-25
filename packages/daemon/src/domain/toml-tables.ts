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

/** Whether line `at` opens a table in the document, rather than sitting inside a multi-line string (an example in a
 *  person's instructions, say): swapped for a probe header, the parsed document gains that table. */
export function opensTomlTable(lines: string[], at: number): boolean {
  const probe = `openrig-header-probe-${at}`;
  try { return Object.hasOwn(parseToml([...lines.slice(0, at), `[${probe}]`, ...lines.slice(at + 1)].join("\n")), probe); }
  catch { return false; }
}

/** The line that opens table `path`, in any key spelling, or -1. */
export function findTomlTable(lines: string[], path: string[]): number {
  return lines.findIndex((line, at) => isDeepStrictEqual(tomlTableHeaderPath(line), path) && opensTomlTable(lines, at));
}

/** Whether a readable document already defines `path` another way (an inline table, dotted keys). Appending a
 *  table for it would then be a duplicate key, and Codex refuses to start. */
export function tomlDefines(content: string, path: string[]): boolean {
  let node: unknown;
  try { node = parseToml(content); } catch { return false; }
  for (const key of path) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}
