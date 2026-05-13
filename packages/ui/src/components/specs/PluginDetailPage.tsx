import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SyntaxHighlight } from "../markdown/SyntaxHighlight.js";
import { usePlugin, usePluginUsedBy } from "../../hooks/usePlugins.js";
import { usePluginFilesList, usePluginFilesRead } from "../../hooks/usePluginFiles.js";
import type { FileEntry } from "../../hooks/useFiles.js";

interface PluginDetailPageProps {
  pluginId: string;
}

const TEXT_LIKE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".log",
  ".yaml", ".yml", ".json",
  ".js", ".jsx", ".ts", ".tsx",
  ".py", ".sh", ".bash",
  ".css", ".html",
]);

function pathExtension(p: string): string {
  const idx = p.lastIndexOf(".");
  if (idx === -1) return "";
  return p.slice(idx).toLowerCase();
}

function parentPath(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function isMarkdownFile(name: string): boolean {
  const ext = pathExtension(name);
  return ext === ".md" || ext === ".mdx";
}

// Auto-selection priority for the root-level default file: README.md
// at the plugin root if present. Falls back to any other markdown,
// then nothing.
function pickDefaultRootFile(entries: FileEntry[]): string | null {
  const readme = entries.find((e) => e.type === "file" && /^readme\.(md|mdx)$/i.test(e.name));
  if (readme) return readme.name;
  const anyMd = entries.find((e) => e.type === "file" && isMarkdownFile(e.name));
  if (anyMd) return anyMd.name;
  return null;
}

export function PluginDetailPage({ pluginId }: PluginDetailPageProps) {
  const { data: detail, isLoading: detailLoading, error: detailError } = usePlugin(pluginId);
  const { data: usedBy = [] } = usePluginUsedBy(pluginId);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [defaultPicked, setDefaultPicked] = useState(false);
  const list = usePluginFilesList(pluginId, currentPath);

  // Auto-select README.md (or any markdown) at the plugin root on first load.
  useEffect(() => {
    if (defaultPicked) return;
    if (currentPath !== "") return;
    if (!list.data) return;
    const pick = pickDefaultRootFile(list.data.entries);
    if (pick) setSelectedFile(pick);
    setDefaultPicked(true);
  }, [list.data, currentPath, defaultPicked]);

  if (detailLoading) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="LOADING PLUGIN"
          description="Loading plugin manifest from discovery service."
          variant="card"
          testId="plugin-detail-loading"
        />
      </div>
    );
  }

  if (detailError || !detail) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="PLUGIN NOT FOUND"
          description="The selected plugin is not visible through any configured discovery source."
          variant="card"
          testId="plugin-detail-not-found"
        />
      </div>
    );
  }

  const entry = detail.entry;
  const skillCount = entry.skillCount;
  const usedByCount = usedBy.length;

  return (
    <div
      data-testid="plugin-detail-page"
      className="h-full overflow-hidden bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-4">
        <SectionHeader tone="muted">Plugin</SectionHeader>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="font-headline text-2xl font-bold tracking-tight text-stone-900">
            {entry.name}
          </h1>
          <span className="font-mono text-sm text-stone-600">v{entry.version}</span>
          {entry.runtimes.map((rt) => (
            <span
              key={rt}
              data-testid={`plugin-detail-runtime-${rt}`}
              className="inline-block border border-outline-variant bg-white/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-700"
            >
              {rt}
            </span>
          ))}
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500"
            title={entry.path}
          >
            {entry.sourceLabel}
          </span>
          <span
            data-testid="plugin-detail-skill-count"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500"
          >
            {skillCount} {skillCount === 1 ? "skill" : "skills"}
          </span>
          <span
            data-testid="plugin-detail-used-by-count"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500"
          >
            used by {usedByCount} {usedByCount === 1 ? "agent" : "agents"}
          </span>
        </div>
        {entry.description && (
          <p className="mt-2 max-w-3xl text-sm text-stone-600">{entry.description}</p>
        )}
      </header>

      <div
        data-testid="plugin-detail-docs-browser"
        className="flex h-[calc(100%-7rem)] flex-col border border-outline-variant bg-white/25 hard-shadow sm:flex-row"
      >
        <aside
          data-testid="plugin-detail-tree"
          className="w-full max-h-64 shrink-0 overflow-y-auto border-b border-outline-variant bg-white/30 sm:w-72 sm:max-h-none sm:border-b-0 sm:border-r"
        >
          <Breadcrumbs
            testId="plugin-detail-breadcrumbs"
            pluginName={entry.name}
            path={currentPath}
            onNavigate={(rel) => { setCurrentPath(rel); setSelectedFile(null); }}
          />
          {list.isLoading ? (
            <div data-testid="plugin-detail-tree-loading" className="p-3 font-mono text-[10px] text-stone-400">
              Loading…
            </div>
          ) : list.isError ? (
            <div data-testid="plugin-detail-tree-error" className="p-3 font-mono text-[10px] text-red-600">
              {(list.error as Error)?.message ?? "Error loading directory."}
            </div>
          ) : !list.data || list.data.entries.length === 0 ? (
            <div data-testid="plugin-detail-tree-empty" className="p-3 font-mono text-[10px] text-stone-400">
              Empty directory.
            </div>
          ) : (
            <ul className="p-1">
              {currentPath && (
                <li>
                  <button
                    type="button"
                    data-testid="plugin-detail-tree-up"
                    onClick={() => { setCurrentPath(parentPath(currentPath)); setSelectedFile(null); }}
                    className="block w-full px-2 py-1 text-left font-mono text-[10px] text-stone-500 hover:bg-stone-100"
                  >
                    ..
                  </button>
                </li>
              )}
              {list.data.entries.map((fileEntry) => {
                const rel = joinPath(currentPath, fileEntry.name);
                const isFile = fileEntry.type === "file";
                const isSelected = selectedFile === rel;
                return (
                  <li key={rel}>
                    <button
                      type="button"
                      data-testid={`plugin-detail-tree-entry-${rel}`}
                      data-type={fileEntry.type}
                      data-active={isSelected}
                      onClick={() => {
                        if (isFile) setSelectedFile(rel);
                        else if (fileEntry.type === "dir") { setCurrentPath(rel); setSelectedFile(null); }
                      }}
                      disabled={fileEntry.type === "other"}
                      className={`block w-full px-2 py-1 text-left font-mono text-[10px] ${
                        fileEntry.type === "other"
                          ? "text-stone-400"
                          : `hover:bg-stone-100 ${isSelected ? "bg-stone-200/80 text-stone-900" : "text-stone-700"}`
                      }`}
                    >
                      {fileEntry.type === "dir" ? `▸ ${fileEntry.name}` : fileEntry.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main data-testid="plugin-detail-viewer" className="flex-1 min-w-0 overflow-y-auto bg-white">
          {!selectedFile ? (
            <div data-testid="plugin-detail-viewer-no-selection" className="p-4 font-mono text-[10px] text-stone-400">
              Select a file from the tree.
            </div>
          ) : (
            <PluginFileContent pluginId={pluginId} path={selectedFile} />
          )}
        </main>
      </div>
    </div>
  );
}

function Breadcrumbs({
  testId,
  pluginName,
  path,
  onNavigate,
}: {
  testId: string;
  pluginName: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <nav data-testid={testId} className="flex flex-wrap items-baseline gap-1 border-b border-outline-variant px-2 py-1 font-mono text-[10px] text-stone-700">
      <button type="button" onClick={() => onNavigate("")} className="font-bold hover:underline">
        {pluginName}
      </button>
      {segments.map((seg, idx) => {
        const accumulated = segments.slice(0, idx + 1).join("/");
        return (
          <span key={accumulated}>
            <span className="mx-0.5 text-stone-400">/</span>
            <button type="button" onClick={() => onNavigate(accumulated)} className="hover:underline">
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function PluginFileContent({ pluginId, path }: { pluginId: string; path: string }) {
  const read = usePluginFilesRead(pluginId, path);
  const ext = useMemo(() => pathExtension(path), [path]);

  if (read.isLoading) {
    return (
      <div data-testid="plugin-detail-viewer-loading" className="p-4 font-mono text-[10px] text-stone-400">
        Loading…
      </div>
    );
  }
  if (read.isError) {
    return (
      <div data-testid="plugin-detail-viewer-error" className="p-4 font-mono text-[10px] text-red-600">
        {(read.error as Error)?.message ?? "Error loading file."}
      </div>
    );
  }
  if (!read.data) return null;

  return (
    <div data-testid="plugin-detail-viewer-content" className="flex h-full flex-col">
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2 font-mono text-[10px]">
        <div data-testid="plugin-detail-viewer-path" className="text-stone-700">{path}</div>
        <div className="flex items-baseline gap-3 text-stone-500">
          <span>{read.data.size}b</span>
          <span>{read.data.mtime}</span>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.data.truncated && (
          <div
            data-testid="plugin-detail-viewer-truncated"
            className="mb-3 mx-4 mt-4 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] text-amber-900"
          >
            ⚠ Truncated at {Math.round((read.data.truncatedAtBytes ?? 0) / 1024)} KB — file is{" "}
            {Math.round((read.data.totalBytes ?? read.data.size) / 1024)} KB total.
          </div>
        )}
        {ext === ".md" || ext === ".mdx" ? (
          <div className="p-4">
            <MarkdownViewer content={read.data.content} />
          </div>
        ) : TEXT_LIKE_EXTENSIONS.has(ext) ? (
          <div className="p-4">
            <SyntaxHighlight code={read.data.content} language={ext.slice(1)} />
          </div>
        ) : (
          <pre data-testid="plugin-detail-viewer-text-fallback" className="p-4 whitespace-pre-wrap break-words font-mono text-[10px] text-stone-800">
            {read.data.content}
          </pre>
        )}
      </div>
    </div>
  );
}
