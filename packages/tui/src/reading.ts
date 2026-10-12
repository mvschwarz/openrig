// One passive text/navigation contract for connected and selected local reading.
import { posix as path } from "node:path";
import { fieldLine, listItem, wrapDetailLines, type ContentLine } from "./detail.js";
import type { Action } from "./types.js";

export interface FileTarget { root: string; path: string; anchor?: string }
export interface FileRoot { name: string; path: string }
export interface FileRead {
  root: string; path: string; absolutePath: string; resolvedPath?: string;
  content: string; mtime: string; contentHash: string; size: number;
  truncated: boolean; truncatedAtBytes: number | null; totalBytes: number;
  binary?: boolean;
}
export type FileReadResult = FileRead | { error: string; message?: string };

/** Map only against explicitly served roots, never search another installation. */
export function fileTargetForPath(source: string, roots: FileRoot[]): FileTarget | null {
  const root = [...roots].sort((a, b) => b.path.length - a.path.length)
    .find((r) => source.startsWith(r.path.replace(/\/$/, "") + "/"));
  return root ? { root: root.name, path: source.slice(root.path.replace(/\/$/, "").length + 1) } : null;
}

export function referenceAction(origin: FileTarget, href: string): Action {
  if (/^https?:\/\//i.test(href)) return { type: "external-open", url: href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return { type: "error", message: "Unsupported reference scheme; no external program opened" };
  try {
    const hash = href.indexOf("#");
    const name = decodeURIComponent(hash < 0 ? href : href.slice(0, hash));
    const anchor = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
    // Resolve relative to this actual source. An escape remains ../ and is
    // refused by the existing reader; symlink containment remains server-owned.
    const resolved = name ? (name.startsWith("/") ? name : path.normalize(path.join(path.dirname(origin.path), name))) : origin.path;
    return { type: "file-open", target: { root: origin.root, path: resolved, ...(anchor ? { anchor } : {}) } };
  } catch { return { type: "error", message: "Invalid percent-encoding in reference" }; }
}

export function referenceLines(text: string, origin: FileTarget): ContentLine[] {
  const links: ContentLine[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)/g)) {
    const href = match[2]!;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push(listItem(`${match[1]} · ${/^https?:/i.test(href) ? "external URL" : href}`, referenceAction(origin, href)));
  }
  return links;
}

function headingSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
}

export function fileLines(result: FileReadResult | null | undefined, target: FileTarget, width = 80): ContentLine[] {
  const lines: ContentLine[] = [
    { text: `READ · ${target.root || "unmapped source"} / ${target.path}${target.anchor ? `#${target.anchor}` : ""}` },
    listItem("Back · Esc", { type: "back" }),
  ];
  if (!result) return wrapDetailLines([...lines, { text: "Current file read pending; no previous bytes shown." }], width);
  if ("error" in result) return wrapDetailLines([...lines, { text: `Cannot read: ${result.error}` }, { text: result.message ?? "Reader unavailable" }], width);
  lines.push(fieldLine({ label: "source", value: result.absolutePath }),
    { text: `Read from disk · modified ${result.mtime}` },
    { text: `${result.totalBytes} bytes · SHA-256 ${result.contentHash}` },
    { text: result.truncated ? `TRUNCATED at ${result.truncatedAtBytes} bytes of ${result.totalBytes}; incomplete content.` : "Complete file read · refresh reads disk again" });
  if (result.binary || /\x00/.test(result.content)) return wrapDetailLines([...lines, { text: "Binary / non-UTF-8 file; text is not displayed." }], width);
  const sourceRows = result.content.split(/\r\n|\r|\n/);
  let start = 0;
  if (target.anchor) {
    const slugs = new Map<string, number>();
    let fence: { marker: string; length: number } | null = null;
    const found = sourceRows.findIndex((row) => {
      const marker = row.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker) {
        const run = marker[1]!;
        const tail = marker[2]!;
        if (!fence) {
          if (run[0] !== "`" || !tail.includes("`")) fence = { marker: run[0]!, length: run.length };
        } else if (run[0] === fence.marker && run.length >= fence.length && /^[ \t]*$/.test(tail)) {
          fence = null;
        }
        return false;
      }
      const heading = !fence && row.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
      if (!heading) return false;
      const slug = headingSlug(heading[1]!);
      const n = slugs.get(slug) ?? 0; slugs.set(slug, n + 1);
      return (n ? `${slug}-${n}` : slug) === target.anchor;
    });
    if (found < 0) lines.push({ text: `Heading not found: #${target.anchor}${result.truncated ? " in the returned prefix" : ""}; showing from start.` });
    else { start = found; lines.push({ text: `Showing from #${target.anchor} · source line ${start + 1}` }); }
    lines.push(listItem("Read from start", { type: "file-open", target: { root: target.root, path: target.path } }));
  }
  const origin = { ...target, path: result.resolvedPath ?? result.path };
  lines.push({ text: "" });
  for (const row of sourceRows.slice(start)) {
    lines.push({ text: row }, ...referenceLines(row, origin));
  }
  return wrapDetailLines(lines, width);
}

export function externalLines(url: string, width: number): ContentLine[] {
  return wrapDetailLines([{ text: "EXTERNAL URL" }, { text: "No browser opened. Use v to select/copy this destination." }, { text: url }, listItem("Back · Esc", { type: "back" })], width);
}
