// UI Enhancement Pack v0 — Files browser workspace.
//
// Top-level center-workspace surface for /files route. Two-pane shape:
//   - Left: allowlist root selector + directory tree of the selected root.
//   - Right: file content panel (markdown via MarkdownViewer, code via
//     SyntaxHighlight, images inline, other → "view as text" affordance).
//
// Item 4 (edit mode) is integrated: a header toggle flips the right
// pane into a `<textarea>` editor with Save/Cancel; Save does the
// daemon's atomic-write contract; 409 conflicts surface a refresh
// affordance per the PRD's recommendation. Per item 4's recommended
// landing posture: lightweight `<textarea>` (no CodeMirror).

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  fileAssetUrl,
  useFilesList,
  useFilesRead,
  useFilesRoots,
  useFilesWrite,
  type AllowlistRoot,
  type FileEntry,
  type FilesReadResponse,
  type FileWriteResult,
} from "../../hooks/useFiles.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SyntaxHighlight } from "../markdown/SyntaxHighlight.js";
import { useSpecReview } from "../../hooks/useSteering.js";

const TEXT_LIKE_EXTENSIONS = new Set([".md", ".txt", ".log", ".yaml", ".yml", ".json", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".sql", ".css", ".html"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const DOWNLOAD_ONLY_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".pdf", ".mp4", ".webm", ".mov"]);

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

export function FilesWorkspace() {
  const roots = useFilesRoots();
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<boolean>(false);

  // Default-select the first root once roots arrive.
  useEffect(() => {
    if (selectedRoot) return;
    if (!roots.data || isUnavailable(roots.data)) return;
    const first = roots.data.roots[0];
    if (first) setSelectedRoot(first.name);
  }, [roots.data, selectedRoot]);

  // Reset path + selected file when root changes.
  useEffect(() => {
    setCurrentPath("");
    setSelectedFile(null);
    setEditMode(false);
  }, [selectedRoot]);

  return (
    <div data-testid="files-workspace" className="flex h-full flex-col lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
      <header className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">Workspace</div>
        <h1 className="font-headline text-xl font-bold tracking-tight text-stone-900">Files</h1>
      </header>
      <div className="flex flex-1 min-h-0">
        <aside data-testid="files-tree-pane" className="w-72 shrink-0 overflow-y-auto border-r border-stone-200 bg-stone-50">
          <RootSelector roots={roots.data} isLoading={roots.isLoading} selectedRoot={selectedRoot} onSelect={setSelectedRoot} />
          {selectedRoot && (
            <>
              <Breadcrumbs root={selectedRoot} path={currentPath} onNavigate={setCurrentPath} />
              <DirectoryTree
                root={selectedRoot}
                path={currentPath}
                onEnterDir={(rel) => { setCurrentPath(rel); setSelectedFile(null); }}
                onSelectFile={(rel) => { setSelectedFile(rel); setEditMode(false); }}
                selectedFile={selectedFile}
              />
            </>
          )}
        </aside>
        <main data-testid="files-content-pane" className="flex-1 min-w-0 overflow-y-auto bg-white">
          {!selectedRoot && (
            <div className="m-auto p-4 font-mono text-[10px] text-stone-400">
              Select an allowlist root to browse.
            </div>
          )}
          {selectedRoot && !selectedFile && (
            <div className="p-4 font-mono text-[10px] text-stone-400" data-testid="files-no-selection">
              Select a file from the tree.
            </div>
          )}
          {selectedRoot && selectedFile && (
            <FileContentPanel
              root={selectedRoot}
              path={selectedFile}
              editMode={editMode}
              onToggleEditMode={() => setEditMode((v) => !v)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function RootSelector({
  roots,
  isLoading,
  selectedRoot,
  onSelect,
}: {
  roots: ReturnType<typeof useFilesRoots>["data"] | undefined;
  isLoading: boolean;
  selectedRoot: string | null;
  onSelect: (name: string) => void;
}) {
  if (isLoading) return <div className="p-3 font-mono text-[10px] text-stone-400">Loading roots…</div>;
  if (!roots) return null;
  if (isUnavailable(roots)) {
    return (
      <div data-testid="files-roots-unavailable" className="p-3 font-mono text-[10px] text-stone-500">
        <div>Files routes unavailable.</div>
        {roots.hint && <div className="mt-1 text-stone-400">{roots.hint}</div>}
      </div>
    );
  }
  if (roots.roots.length === 0) {
    return (
      <div data-testid="files-roots-empty" className="p-3 font-mono text-[10px] text-stone-500">
        <div>No allowlist roots configured.</div>
        {roots.hint && <div className="mt-1 text-stone-400">{roots.hint}</div>}
      </div>
    );
  }
  return (
    <div data-testid="files-root-selector" className="border-b border-stone-200 p-2">
      <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.18em] text-stone-500">Roots</div>
      <ul>
        {roots.roots.map((r: AllowlistRoot) => (
          <li key={r.name}>
            <button
              type="button"
              data-testid={`files-root-${r.name}`}
              data-active={selectedRoot === r.name}
              onClick={() => onSelect(r.name)}
              className={`block w-full px-2 py-1 text-left font-mono text-[10px] hover:bg-stone-100 ${
                selectedRoot === r.name ? "bg-stone-200/80 text-stone-900" : "text-stone-700"
              }`}
              title={r.path}
            >
              {r.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Breadcrumbs({ root, path, onNavigate }: { root: string; path: string; onNavigate: (path: string) => void }) {
  const segments = path ? path.split("/") : [];
  return (
    <nav data-testid="files-breadcrumbs" className="flex flex-wrap items-baseline gap-1 border-b border-stone-200 px-2 py-1 font-mono text-[10px] text-stone-700">
      <button type="button" onClick={() => onNavigate("")} className="font-bold hover:underline">{root}</button>
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

function DirectoryTree({
  root,
  path,
  onEnterDir,
  onSelectFile,
  selectedFile,
}: {
  root: string;
  path: string;
  onEnterDir: (rel: string) => void;
  onSelectFile: (rel: string) => void;
  selectedFile: string | null;
}) {
  const list = useFilesList(root, path);
  if (list.isLoading) return <div className="p-3 font-mono text-[10px] text-stone-400">Loading…</div>;
  if (list.isError) return <div data-testid="files-list-error" className="p-3 font-mono text-[10px] text-red-600">{(list.error as Error)?.message ?? "Error loading directory."}</div>;
  if (!list.data || list.data.entries.length === 0) {
    return <div className="p-3 font-mono text-[10px] text-stone-400">Empty directory.</div>;
  }
  return (
    <ul data-testid="files-directory-tree" className="p-1">
      {path && (
        <li>
          <button
            type="button"
            data-testid="files-up"
            onClick={() => onEnterDir(parentPath(path))}
            className="block w-full px-2 py-1 text-left font-mono text-[10px] text-stone-500 hover:bg-stone-100"
          >
            ..
          </button>
        </li>
      )}
      {list.data.entries.map((entry: FileEntry) => {
        const rel = path ? `${path}/${entry.name}` : entry.name;
        const isFile = entry.type === "file";
        const isSelected = selectedFile === rel;
        return (
          <li key={rel}>
            <button
              type="button"
              data-testid={`files-entry-${rel}`}
              data-type={entry.type}
              onClick={() => isFile ? onSelectFile(rel) : entry.type === "dir" ? onEnterDir(rel) : undefined}
              disabled={entry.type === "other"}
              className={`block w-full px-2 py-1 text-left font-mono text-[10px] ${
                entry.type === "other"
                  ? "text-stone-400"
                  : `hover:bg-stone-100 ${isSelected ? "bg-stone-200/80 text-stone-900" : "text-stone-700"}`
              }`}
            >
              {entry.type === "dir" ? `▸ ${entry.name}` : entry.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FileContentPanel({
  root,
  path,
  editMode,
  onToggleEditMode,
}: {
  root: string;
  path: string;
  editMode: boolean;
  onToggleEditMode: () => void;
}) {
  const read = useFilesRead(root, path);
  return (
    <div data-testid="files-content-panel" className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[10px]">
        <div className="text-stone-700" data-testid="files-content-path">{root}/{path}</div>
        <div className="flex items-center gap-3 text-stone-500">
          {read.data && (
            <>
              <span data-testid="files-content-size">{read.data.size}b</span>
              <span data-testid="files-content-mtime">{read.data.mtime}</span>
            </>
          )}
          <button
            type="button"
            data-testid="files-edit-toggle"
            data-active={editMode}
            onClick={onToggleEditMode}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              editMode
                ? "border-amber-400 bg-amber-50 text-amber-900"
                : "border-stone-300 text-stone-700 hover:bg-stone-100"
            }`}
          >
            {editMode ? "editing" : "edit"}
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.isLoading && <div className="p-4 font-mono text-[10px] text-stone-400">Loading…</div>}
        {read.isError && <div data-testid="files-read-error" className="p-4 font-mono text-[10px] text-red-600">{(read.error as Error)?.message ?? "Error loading file."}</div>}
        {read.data && (
          editMode
            ? <FileEditor root={root} path={path} read={read.data} />
            : <FileViewer root={root} path={path} read={read.data} />
        )}
      </div>
    </div>
  );
}

function FileViewer({ root, path, read }: { root: string; path: string; read: FilesReadResponse }) {
  const ext = pathExtension(path);
  // OSR v0 item 3: detect spec-kind YAML files for inline validation.
  const specKind = detectSpecKind(path);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-image-view" className="p-4">
        <TruncationMarker read={read} />
        <img src={fileAssetUrl(root, path)} alt={path} className="max-w-full border border-stone-200" />
      </div>
    );
  }
  if (ext === ".md") {
    return (
      <div className="p-4">
        <TruncationMarker read={read} />
        <MarkdownViewer content={read.content} />
      </div>
    );
  }
  if (TEXT_LIKE_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-code-view" className="p-4">
        <TruncationMarker read={read} />
        {specKind && <SpecValidationPanel kind={specKind} yaml={read.content} />}
        <SyntaxHighlight code={read.content} language={ext.slice(1)} />
      </div>
    );
  }
  if (DOWNLOAD_ONLY_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-download-only" className="p-4 font-mono text-[10px] text-stone-700">
        <a href={fileAssetUrl(root, path)} download className="text-blue-700 underline">
          Download {path}
        </a>
      </div>
    );
  }
  return (
    <div data-testid="files-text-fallback" className="p-4">
      <TruncationMarker read={read} />
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-stone-800">{read.content}</pre>
    </div>
  );
}

// Operator Surface Reconciliation v0 item 5: explicit truncation marker
// rendered above the file body when the daemon capped the read at
// FILE_READ_TRUNCATION_BYTES (1 MB). Honest about the limit so the
// operator knows to use an external editor for full content.
function TruncationMarker({ read }: { read: FilesReadResponse }) {
  if (!read.truncated) return null;
  const totalKb = Math.round((read.totalBytes ?? read.size) / 1024);
  return (
    <div
      data-testid="files-truncation-marker"
      data-truncated-at-bytes={read.truncatedAtBytes ?? ""}
      data-total-bytes={read.totalBytes ?? ""}
      className="mb-3 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] text-amber-900"
    >
      ⚠ Truncated by file viewer at {Math.round((read.truncatedAtBytes ?? 0) / 1024)} KB —
      file is {totalKb} KB total. Use an external editor for full content.
    </div>
  );
}

// OSR v0 item 3: RigSpec / AgentSpec validation panel. Detects spec
// kind by filename and invokes the existing /api/specs/review/{rig|agent}
// endpoint via the useSpecReview hook. Errors / warnings render inline
// alongside the YAML view; non-spec YAML files don't surface this
// panel at all.
function detectSpecKind(filePath: string): "rig" | "agent" | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("/rig.yaml") || lower === "rig.yaml" || lower.endsWith("/rig.yml") || lower === "rig.yml") return "rig";
  if (lower.endsWith("/agent.yaml") || lower === "agent.yaml" || lower.endsWith("/agent.yml") || lower === "agent.yml") return "agent";
  // Spec library entries: <pkg>/specs/<spec-name>/{rig,agent}.yaml shape;
  // we already match those above via the basename. Driver picks
  // additional heuristics here in v0+1 if false-positive avoidance
  // becomes a friction (e.g., "config.yaml" inside an unrelated
  // workspace tree should NOT trigger spec validation).
  return null;
}

function SpecValidationPanel({ kind, yaml }: { kind: "rig" | "agent"; yaml: string }) {
  const review = useSpecReview(kind, yaml);
  if (review.isLoading) {
    return (
      <div data-testid="files-spec-validation-loading" className="mb-3 border border-stone-300 bg-stone-50 px-3 py-2 font-mono text-[10px] text-stone-500">
        Validating {kind}.yaml…
      </div>
    );
  }
  if (review.isError) {
    return (
      <div data-testid="files-spec-validation-error" className="mb-3 border border-red-400 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
        Validation failed to run: {(review.error as Error)?.message ?? "unknown error"}
      </div>
    );
  }
  if (!review.data) return null;
  const errors = review.data.errors ?? [];
  const isValid = errors.length === 0;
  return (
    <div
      data-testid="files-spec-validation-panel"
      data-spec-kind={kind}
      data-valid={isValid}
      className={`mb-3 border px-3 py-2 font-mono text-[10px] ${
        isValid
          ? "border-emerald-400 bg-emerald-50 text-emerald-900"
          : "border-red-400 bg-red-50 text-red-900"
      }`}
    >
      <div className="mb-1 font-bold uppercase tracking-[0.10em]">
        {isValid ? `✓ Valid ${kind === "rig" ? "RigSpec" : "AgentSpec"}` : `✗ ${kind === "rig" ? "RigSpec" : "AgentSpec"} validation errors`}
      </div>
      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((err, idx) => (
            <li
              key={idx}
              data-testid={`files-spec-validation-error-${idx}`}
              className="text-[10px]"
            >
              {err.field && <span className="font-bold">{err.field}: </span>}
              {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileEditor({ root, path, read }: { root: string; path: string; read: FilesReadResponse }) {
  const [draft, setDraft] = useState(read.content);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentMtime: string; currentContentHash: string } | null>(null);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const write = useFilesWrite();
  const qc = useQueryClient();

  // When a fresh read comes in (after Refresh on conflict, or after a
  // successful save), reset the draft to the new content. Note: useFilesWrite
  // intentionally does NOT invalidate the read query on a 409 conflict,
  // so a conflict-state read stays stable until the operator clicks
  // Refresh (which triggers the invalidation explicitly).
  useEffect(() => {
    setDraft(read.content);
    setConflict(null);
  }, [read.contentHash, read.mtime, read.content]);

  const dirty = useMemo(() => draft !== read.content, [draft, read.content]);

  return (
    <div data-testid="files-editor" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-stone-200 bg-amber-50 px-3 py-1.5 font-mono text-[9px]">
        <span className="font-bold text-amber-900" data-testid="files-editor-status">
          {dirty ? "draft (unsaved)" : "no changes"}
        </span>
        <button
          type="button"
          data-testid="files-editor-save"
          disabled={!dirty || write.isPending}
          onClick={() => {
            setSaveError(null);
            setConflict(null);
            setSavedIndicator(false);
            write.mutate(
              {
                root,
                path,
                content: draft,
                expectedMtime: read.mtime,
                expectedContentHash: read.contentHash,
                actor: "ui-files-edit-mode",
              },
              {
                onSuccess: (result: FileWriteResult) => {
                  if ("conflict" in result) {
                    setConflict({ currentMtime: result.currentMtime, currentContentHash: result.currentContentHash });
                  } else {
                    setSavedIndicator(true);
                    setTimeout(() => setSavedIndicator(false), 2000);
                  }
                },
                onError: (err) => {
                  setSaveError(err instanceof Error ? err.message : String(err));
                },
              },
            );
          }}
          className="border border-emerald-500 bg-emerald-50 px-2 py-0.5 uppercase tracking-[0.10em] text-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          save
        </button>
        <button
          type="button"
          data-testid="files-editor-cancel"
          onClick={() => { setDraft(read.content); setSaveError(null); setConflict(null); }}
          className="border border-stone-400 bg-white px-2 py-0.5 uppercase tracking-[0.10em] text-stone-700"
        >
          cancel
        </button>
        {savedIndicator && (
          <span data-testid="files-editor-saved" className="ml-auto text-emerald-700">saved</span>
        )}
      </div>
      {conflict && (
        <div data-testid="files-editor-conflict" className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
          <span className="flex-1">
            File changed externally. Local mtime <code>{read.mtime}</code> ≠ server <code>{conflict.currentMtime}</code>. Click Refresh to re-read the file (your draft will be replaced with the new server content; copy it elsewhere first if you need to re-apply).
          </span>
          <button
            type="button"
            data-testid="files-editor-refresh"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["files", "read", root, path] });
            }}
            className="border border-red-500 bg-white px-2 py-0.5 uppercase tracking-[0.10em] text-red-900"
          >
            refresh
          </button>
        </div>
      )}
      {saveError && (
        <div data-testid="files-editor-error" className="border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
          Save failed: {saveError}
        </div>
      )}
      <textarea
        data-testid="files-editor-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="flex-1 min-h-0 resize-none border-0 bg-stone-50 p-3 font-mono text-[11px] leading-relaxed text-stone-900 outline-none"
        spellCheck={false}
      />
    </div>
  );
}

function pathExtension(p: string): string {
  const idx = p.lastIndexOf(".");
  if (idx === -1) return "";
  return p.slice(idx).toLowerCase();
}

function parentPath(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}
