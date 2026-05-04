// UI Enhancement Pack v0 — lightweight markdown viewer (no deps).
//
// Per the audit: no markdown libraries are installed in the UI
// package. This component implements a small parser that handles the
// cases operators hit when reading canon docs:
//   - YAML frontmatter (rendered as a metadata header above the body)
//   - Headings (# / ## / ### / ####)
//   - Lists (- / * / nested by 2-space indent)
//   - Numbered lists (1. / 2. / ...)
//   - Code blocks (``` with language tag → SyntaxHighlight component)
//   - Inline code (`...`)
//   - Bold (**...**) / italic (*...*) — light support
//   - Links ([text](url)) and images (![alt](url))
//   - Tables (| col | col |)
//   - Mermaid code blocks → "[render mermaid]" placeholder per PRD
//     item 2 carve-out (no mermaid lib bundled at v0 — named v0+1
//     trigger applies if dogfood reports the click-to-render flow is
//     friction)
//
// Image src resolution: absolute URLs and `data:` URIs pass through;
// relative paths are resolved against the optional `assetBasePath`
// prop so the daemon's /api/files/asset endpoint or the slice's
// /api/slices/<name>/proof-asset/ endpoint can serve them.

import { useMemo, useState } from "react";
import { SyntaxHighlight } from "./SyntaxHighlight.js";

export interface MarkdownViewerProps {
  content: string;
  /** Used to resolve relative image src + link href. Optional. */
  assetBasePath?: string;
  /** Hide the YAML frontmatter metadata header (default false). */
  hideFrontmatter?: boolean;
  /** Operator Surface Reconciliation v0 item 4: hide the raw/rendered
   *  toggle for callers (e.g., the steering Priority Stack panel) where
   *  the toggle would visually compete with the surrounding shell. */
  hideRawToggle?: boolean;
}

export function MarkdownViewer({ content, assetBasePath, hideFrontmatter = false, hideRawToggle = false }: MarkdownViewerProps) {
  const parsed = useMemo(() => parseMarkdown(content), [content]);
  // Operator Surface Reconciliation v0 item 4: per-instance toggle
  // between rendered (default) and raw (monospace pre-rendered text +
  // visible Markdown source). Frontmatter metadata header still
  // renders in raw mode unless hideFrontmatter is set.
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  return (
    <article data-testid="markdown-viewer" data-mode={mode} className="prose-tactical max-w-none">
      {!hideRawToggle && (
        <div data-testid="markdown-viewer-mode-toggle" className="mb-2 flex items-center gap-1">
          <button
            type="button"
            data-testid="markdown-viewer-mode-rendered"
            data-active={mode === "rendered"}
            onClick={() => setMode("rendered")}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              mode === "rendered"
                ? "border-stone-700 bg-stone-700 text-white"
                : "border-stone-300 text-stone-700 hover:bg-stone-100"
            }`}
          >
            rendered
          </button>
          <button
            type="button"
            data-testid="markdown-viewer-mode-raw"
            data-active={mode === "raw"}
            onClick={() => setMode("raw")}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              mode === "raw"
                ? "border-stone-700 bg-stone-700 text-white"
                : "border-stone-300 text-stone-700 hover:bg-stone-100"
            }`}
          >
            raw
          </button>
        </div>
      )}
      {!hideFrontmatter && parsed.frontmatter && (
        <FrontmatterHeader frontmatter={parsed.frontmatter} />
      )}
      {mode === "raw" ? (
        <pre data-testid="markdown-viewer-raw" className="overflow-x-auto whitespace-pre-wrap break-words bg-stone-50 p-3 font-mono text-[10px] text-stone-800">
          {content}
        </pre>
      ) : (
        <div className="space-y-3" data-testid="markdown-viewer-rendered">
          {parsed.blocks.map((block, idx) => (
            <BlockRenderer key={idx} block={block} assetBasePath={assetBasePath} />
          ))}
        </div>
      )}
    </article>
  );
}

interface ParsedDocument {
  frontmatter: Record<string, string> | null;
  blocks: Block[];
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string | null; text: string; isMermaid: boolean }
  | { type: "list"; ordered: boolean; items: Array<{ depth: number; text: string }> }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "blank" };

function parseMarkdown(content: string): ParsedDocument {
  const { frontmatter, body } = stripFrontmatter(content);
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const language = fence[1] || null;
      const isMermaid = language?.toLowerCase() === "mermaid";
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end]!.match(/^```\s*$/)) end++;
      const text = lines.slice(start, end).join("\n");
      blocks.push({ type: "code", language, text, isMermaid });
      i = end + 1;
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4, text: heading[2]! });
      i++;
      continue;
    }

    // List (bulleted or ordered).
    if (line.match(/^\s*([-*]|\d+\.)\s+/)) {
      const items: Array<{ depth: number; text: string }> = [];
      const ordered = !!line.match(/^\s*\d+\./);
      while (i < lines.length && lines[i]!.match(/^\s*([-*]|\d+\.)\s+/)) {
        const m = lines[i]!.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
        if (!m) break;
        const depth = Math.floor((m[1]?.length ?? 0) / 2);
        items.push({ depth, text: m[3]! });
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Table (header + separator + body rows).
    if (line.match(/^\s*\|.*\|\s*$/) && i + 1 < lines.length && lines[i + 1]!.match(/^\s*\|[\s\-:|]+\|\s*$/)) {
      const headers = parseTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.match(/^\s*\|.*\|\s*$/)) {
        rows.push(parseTableRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-blank, non-special lines).
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "") break;
      if (next.match(/^```/) || next.match(/^#{1,4}\s/) || next.match(/^\s*([-*]|\d+\.)\s/) || next.match(/^\s*\|.*\|\s*$/)) break;
      paragraph.push(next);
      i++;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return { frontmatter, blocks };
}

function stripFrontmatter(content: string): { frontmatter: Record<string, string> | null; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: null, body: content };
  }
  const rest = content.slice(content.indexOf("\n") + 1);
  const endMatch = rest.match(/(^|\n)---(\n|$)/);
  if (!endMatch || endMatch.index === undefined) return { frontmatter: null, body: content };
  const fmText = rest.slice(0, endMatch.index);
  const body = rest.slice(endMatch.index + endMatch[0].length);
  const frontmatter: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([\w.-]+):\s*(.+?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      frontmatter[m[1]!] = v;
    }
  }
  return { frontmatter, body };
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function FrontmatterHeader({ frontmatter }: { frontmatter: Record<string, string> }) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;
  return (
    <section
      data-testid="markdown-frontmatter"
      className="mb-4 border border-stone-300 bg-stone-50 p-3"
    >
      <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-stone-500">
        Frontmatter
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="font-mono text-[10px] font-bold text-stone-700">{k}</dt>
            <dd className="font-mono text-[10px] text-stone-800 break-all">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function BlockRenderer({ block, assetBasePath }: { block: Block; assetBasePath?: string }) {
  if (block.type === "blank") return null;
  if (block.type === "heading") {
    const sizes = { 1: "text-lg font-bold", 2: "text-base font-bold", 3: "text-sm font-bold", 4: "text-xs font-bold" } as const;
    const Tag = (`h${block.level}` as "h1" | "h2" | "h3" | "h4");
    return <Tag data-testid={`md-heading-${block.level}`} className={`${sizes[block.level]} mt-4 text-stone-900`}>{renderInline(block.text, assetBasePath)}</Tag>;
  }
  if (block.type === "paragraph") {
    return <p data-testid="md-paragraph" className="text-[12px] leading-relaxed text-stone-800">{renderInline(block.text, assetBasePath)}</p>;
  }
  if (block.type === "code") {
    if (block.isMermaid) {
      return (
        <div data-testid="md-mermaid-placeholder" className="border border-amber-300 bg-amber-50 p-3">
          <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-amber-700">
            mermaid diagram (v0+1 trigger: render-on-click flow)
          </div>
          <pre className="overflow-x-auto bg-stone-900 p-2 font-mono text-[10px] text-stone-100">
            <code>{block.text}</code>
          </pre>
          <button
            type="button"
            data-testid="md-mermaid-render-btn"
            disabled
            title="Mermaid rendering not bundled at v0 (named v0+1 trigger). Inspect the source above."
            className="mt-2 cursor-not-allowed border border-amber-400 bg-amber-100 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.10em] text-amber-800"
          >
            [render mermaid] (v0+1)
          </button>
        </div>
      );
    }
    return <SyntaxHighlight code={block.text} language={block.language} />;
  }
  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag data-testid={`md-list-${block.ordered ? "ol" : "ul"}`} className={`${block.ordered ? "list-decimal" : "list-disc"} ml-5 space-y-1 text-[12px] text-stone-800`}>
        {block.items.map((item, idx) => (
          <li key={idx} style={{ marginLeft: `${item.depth * 1}rem` }}>
            {renderInline(item.text, assetBasePath)}
          </li>
        ))}
      </ListTag>
    );
  }
  if (block.type === "table") {
    return (
      <div data-testid="md-table-wrapper" className="overflow-x-auto">
        <table className="w-full border-collapse border border-stone-300 text-[10px]">
          <thead className="bg-stone-100">
            <tr>{block.headers.map((h, i) => <th key={i} className="border border-stone-300 px-2 py-1 text-left font-bold text-stone-900">{renderInline(h, assetBasePath)}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-stone-50"}>
                {row.map((cell, ci) => <td key={ci} className="border border-stone-300 px-2 py-1 text-stone-800">{renderInline(cell, assetBasePath)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

// Light inline parser: handles `code`, **bold**, *italic*, [text](url), ![alt](url).
function renderInline(text: string, assetBasePath?: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const flushPlain = (start: number, end: number) => {
    if (end > start) nodes.push(text.slice(start, end));
  };
  let plainStart = 0;
  while (i < text.length) {
    const remaining = text.slice(i);
    // Image: ![alt](src)
    const imgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      flushPlain(plainStart, i);
      const src = resolveAssetUrl(imgMatch[2]!, assetBasePath);
      nodes.push(
        <img
          key={key++}
          data-testid="md-inline-image"
          src={src}
          alt={imgMatch[1] ?? ""}
          loading="lazy"
          className="my-2 inline-block max-w-full border border-stone-200"
        />,
      );
      i += imgMatch[0].length;
      plainStart = i;
      continue;
    }
    // Link: [text](href)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      flushPlain(plainStart, i);
      nodes.push(
        <a
          key={key++}
          data-testid="md-inline-link"
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-700 underline hover:text-blue-900"
        >
          {linkMatch[1]}
        </a>,
      );
      i += linkMatch[0].length;
      plainStart = i;
      continue;
    }
    // Inline code: `...`
    if (remaining.startsWith("`")) {
      const close = remaining.indexOf("`", 1);
      if (close !== -1) {
        flushPlain(plainStart, i);
        nodes.push(
          <code
            key={key++}
            data-testid="md-inline-code"
            className="bg-stone-100 px-1 font-mono text-[10px] text-stone-900"
          >
            {remaining.slice(1, close)}
          </code>,
        );
        i += close + 1;
        plainStart = i;
        continue;
      }
    }
    // Bold: **...**
    if (remaining.startsWith("**")) {
      const close = remaining.indexOf("**", 2);
      if (close !== -1) {
        flushPlain(plainStart, i);
        nodes.push(<strong key={key++} className="font-bold">{remaining.slice(2, close)}</strong>);
        i += close + 2;
        plainStart = i;
        continue;
      }
    }
    // Italic: *...*
    if (remaining.startsWith("*") && !remaining.startsWith("**")) {
      const close = remaining.indexOf("*", 1);
      if (close !== -1 && close > 1) {
        flushPlain(plainStart, i);
        nodes.push(<em key={key++} className="italic">{remaining.slice(1, close)}</em>);
        i += close + 1;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flushPlain(plainStart, text.length);
  return nodes;
}

function resolveAssetUrl(src: string, assetBasePath?: string): string {
  if (!src) return src;
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:") || src.startsWith("/")) return src;
  if (!assetBasePath) return src;
  // Treat assetBasePath as a URL prefix; combine carefully so we don't
  // double-slash or strip the path's relative segment.
  const sep = assetBasePath.endsWith("/") ? "" : "/";
  return `${assetBasePath}${sep}${src}`;
}

// Minimal Fragment-equivalent without importing react/jsx-runtime
// directly — react-19 supplies Fragment via the named export.
import { Fragment } from "react";
