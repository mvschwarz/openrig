// V1 attempt-3 Phase 4 — FileViewer per content-drawer.md L88–L108.
//
// Renders markdown / text / YAML / JSON / image / binary file refs.

import { useMemo } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import {
  fileAssetUrl,
  useFilesRead,
  useFilesRoots,
  type AllowlistRoot,
} from "../../hooks/useFiles.js";

export type FileKind = "markdown" | "text" | "yaml" | "json" | "image" | "binary";

export interface FileViewerData {
  /** Display path shown in the drawer. Also used as the relative read path when `root` is set. */
  path: string;
  kind?: FileKind;
  content?: string;
  imageUrl?: string;
  /** Existing /api/files allowlist root name. */
  root?: string;
  /** Optional explicit path under `root`; falls back to `path` when omitted. */
  readPath?: string;
  /** Absolute file path; resolved against /api/files/roots before reading. */
  absolutePath?: string | null;
}

interface ResolvedReadTarget {
  root: string;
  path: string;
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

function normalizeAbsolutePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function resolveFromAbsolutePath(
  roots: AllowlistRoot[] | undefined,
  absolutePath: string | null | undefined,
): ResolvedReadTarget | null {
  if (!roots || !absolutePath) return null;
  const normalizedFile = normalizeAbsolutePath(absolutePath);
  const sortedRoots = [...roots].sort((a, b) => b.path.length - a.path.length);
  for (const root of sortedRoots) {
    const normalizedRoot = normalizeAbsolutePath(root.path);
    if (normalizedFile === normalizedRoot) return null;
    const prefix = `${normalizedRoot}/`;
    if (!normalizedFile.startsWith(prefix)) continue;
    const relativePath = normalizedFile.slice(prefix.length);
    if (!relativePath || relativePath.includes("../")) return null;
    return { root: root.name, path: relativePath };
  }
  return null;
}

function useResolvedReadTarget(data: FileViewerData): {
  rootsLoading: boolean;
  target: ResolvedReadTarget | null;
  hasFetchIntent: boolean;
} {
  const explicitTarget = data.root
    ? { root: data.root, path: data.readPath ?? data.path }
    : null;
  const needsRootResolution = !explicitTarget && !!data.absolutePath;
  const roots = useFilesRoots();
  const absoluteTarget = useMemo(() => {
    if (!needsRootResolution) return null;
    const rootData = roots.data;
    if (!rootData || "unavailable" in rootData) return null;
    return resolveFromAbsolutePath(rootData.roots, data.absolutePath);
  }, [data.absolutePath, needsRootResolution, roots.data]);

  return {
    rootsLoading: needsRootResolution && roots.isLoading,
    target: explicitTarget ?? absoluteTarget,
    hasFetchIntent: !!explicitTarget || !!data.absolutePath,
  };
}

function FileViewerBody({
  path,
  resolvedKind,
  content,
  imageUrl,
  target,
}: {
  path: string;
  resolvedKind: FileKind;
  content?: string;
  imageUrl?: string;
  target?: ResolvedReadTarget | null;
}) {
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
        {target && (
          <div data-testid="file-viewer-root-path" className="mt-1 font-mono text-[9px] text-stone-500 break-all">
            {target.root}/{target.path}
          </div>
        )}
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

function FileViewerWithFetch(data: FileViewerData) {
  const { path, kind, content, imageUrl } = data;
  const resolvedKind = kind ?? inferKind(path);
  const { rootsLoading, target, hasFetchIntent } = useResolvedReadTarget(data);
  const read = useFilesRead(target?.root ?? null, target?.path ?? null);
  const fetchedContent = read.data?.content;
  const fetchedImageUrl = target && resolvedKind === "image"
    ? fileAssetUrl(target.root, target.path)
    : undefined;
  const resolvedContent = content ?? fetchedContent;
  const resolvedImageUrl = imageUrl ?? fetchedImageUrl;

  if (!content && !imageUrl && hasFetchIntent && (rootsLoading || read.isLoading)) {
    return (
      <EmptyState
        label="LOADING"
        description={`Loading ${path}...`}
        variant="card"
        testId="file-viewer-empty"
      />
    );
  }

  if (!content && !imageUrl && hasFetchIntent && !target) {
    return (
      <EmptyState
        label="FILE UNAVAILABLE"
        description={`No configured file root contains ${path}.`}
        variant="card"
        testId="file-viewer-error"
      />
    );
  }

  if (!content && !imageUrl && read.isError) {
    return (
      <EmptyState
        label="FILE UNAVAILABLE"
        description={(read.error as Error)?.message ?? `Could not load ${path}.`}
        variant="card"
        testId="file-viewer-error"
      />
    );
  }

  return (
    <FileViewerBody
      path={path}
      resolvedKind={resolvedKind}
      content={resolvedContent}
      imageUrl={resolvedImageUrl}
      target={target}
    />
  );
}

export function FileViewer(data: FileViewerData) {
  if (!data.root && !data.absolutePath) {
    return (
      <FileViewerBody
        path={data.path}
        resolvedKind={data.kind ?? inferKind(data.path)}
        content={data.content}
        imageUrl={data.imageUrl}
      />
    );
  }
  return <FileViewerWithFetch {...data} />;
}
