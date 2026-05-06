// V1 attempt-3 Phase 4 — FileViewer per content-drawer.md L88–L108.
//
// Renders markdown / text / YAML / JSON / image / binary file refs.

import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";

export type FileKind = "markdown" | "text" | "yaml" | "json" | "image" | "binary";

export interface FileViewerData {
  path: string;
  kind?: FileKind;
  content?: string;
  imageUrl?: string;
}

function inferKind(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".svg")) return "image";
  if (lower.endsWith(".log") || lower.endsWith(".txt")) return "text";
  return "text";
}

export function FileViewer({ path, kind, content, imageUrl }: FileViewerData) {
  const resolvedKind = kind ?? inferKind(path);

  if (!content && !imageUrl && resolvedKind !== "binary") {
    return (
      <EmptyState
        label="NO CONTENT"
        description={`Loading ${path}...`}
        variant="card"
        testId="file-viewer-empty"
      />
    );
  }

  return (
    <div data-testid="file-viewer" data-file-kind={resolvedKind} className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-outline-variant">
        <SectionHeader tone="muted">File</SectionHeader>
        <h3 className="mt-1 font-mono text-xs text-stone-900 break-all">{path}</h3>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {resolvedKind === "markdown" && content ? (
          <div className="px-4 py-3">
            <MarkdownViewer content={content} />
          </div>
        ) : null}
        {resolvedKind === "yaml" || resolvedKind === "json" ? (
          <pre className="px-4 py-3 font-mono text-xs text-stone-900 whitespace-pre-wrap">
            {content}
          </pre>
        ) : null}
        {resolvedKind === "text" ? (
          <pre className="px-4 py-3 font-mono text-xs text-stone-900 whitespace-pre">
            {content}
          </pre>
        ) : null}
        {resolvedKind === "image" && imageUrl ? (
          <div className="px-4 py-3 flex justify-center">
            <img src={imageUrl} alt={path} className="max-w-full h-auto" />
          </div>
        ) : null}
        {resolvedKind === "binary" ? (
          <div className="px-4 py-6">
            <EmptyState
              label="BINARY"
              description="Cannot preview; download instead."
              variant="card"
              testId="file-viewer-binary"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
