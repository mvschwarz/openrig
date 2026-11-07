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

import { useEffect, useMemo, useRef, useState } from "react";
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
import { useWorkspace } from "../../hooks/useWorkspace.js";
import { WorkspaceKindBadge, resolveKindForPath } from "../WorkspaceKindBadge.js";
import { PageHeader } from "../ui/page-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { StatusBadge } from "../ui/status-badge.js";
import { Button } from "../ui/button.js";

const TEXT_LIKE_EXTENSIONS = new Set([".md", ".txt", ".log", ".yaml", ".yml", ".json", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".sql", ".css", ".html"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const DOWNLOAD_ONLY_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".pdf", ".mp4", ".webm", ".mov"]);

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

export function FilesWorkspace() {
  const roots = useFilesRoots();
  const workspace = useWorkspace();
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
      <div className="border-b border-outline-variant bg-background px-4 py-3">
        <PageHeader
          title="Files"
          description="Browse allowlisted workspace files, preview their contents, and edit text files in place."
        />
      </div>
      {/* Slice 20 mobile: at narrow viewports the two-pane
          shape stacks vertically so the document panel claims full width
          on a phone. Tree pane caps at max-h-48 on mobile so the user
          can scroll past it to the content. Desktop (sm:) layout
          unchanged — horizontal flex + 288px tree column. */}
      <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
        <aside data-testid="files-tree-pane" className="w-full max-h-48 shrink-0 overflow-y-auto border-b border-outline-variant bg-background sm:w-72 sm:max-h-none sm:border-b-0 sm:border-r">
          <RootSelector roots={roots.data} isLoading={roots.isLoading} selectedRoot={selectedRoot} onSelect={setSelectedRoot} workspace={workspace.data ?? null} />
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
        <main data-testid="files-content-pane" className="flex-1 min-w-0 overflow-y-auto bg-surface-lowest">
          {!selectedRoot && (
            <EmptyState
              label="No root selected"
              title="Select a root to browse"
              description="Pick an allowlist root from the tree to browse its files."
              testId="files-no-root"
            />
          )}
          {selectedRoot && !selectedFile && (
            <div className="p-4" data-testid="files-no-selection">
              <EmptyState
                label="No file selected"
                title="Select a file"
                description="Choose a file from the tree to preview its contents."
              />
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
  workspace,
}: {
  roots: ReturnType<typeof useFilesRoots>["data"] | undefined;
  isLoading: boolean;
  selectedRoot: string | null;
  onSelect: (name: string) => void;
  workspace: import("../../hooks/useWorkspace.js").WhoamiWorkspaceUI | null;
}) {
  if (isLoading) return <div className="p-3 text-xs text-on-surface-variant">Loading roots…</div>;
  if (!roots) return null;
  if (isUnavailable(roots)) {
    return (
      <div data-testid="files-roots-unavailable" className="p-3 text-xs text-on-surface-variant">
        <div>Files routes unavailable.</div>
        {roots.hint && <div className="mt-1 text-xs text-on-surface-variant">{roots.hint}</div>}
      </div>
    );
  }
  if (roots.roots.length === 0) {
    return (
      <EmptyState
        label="No allowlist roots"
        title="No allowlist roots configured"
        description="Ask the operator to configure allowlisted workspace roots before browsing files."
        testId="files-roots-empty"
      />
    );
  }
  return (
    <div data-testid="files-root-selector" className="border-b border-outline-variant p-2">
      <div className="mb-1 text-xs text-on-surface-variant">Roots</div>
      <ul>
        {roots.roots.map((r: AllowlistRoot) => {
          const kind = resolveKindForPath(r.path, workspace);
          return (
            <li key={r.name}>
              <button
                type="button"
                data-testid={`files-root-${r.name}`}
                data-active={selectedRoot === r.name}
                onClick={() => onSelect(r.name)}
                className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs ${
                  selectedRoot === r.name ? "bg-surface-mid text-on-surface" : "text-on-surface hover:bg-surface-low"
                }`}
                title={r.path}
              >
                <span className="truncate">{r.name}</span>
                {kind && <WorkspaceKindBadge kind={kind} compact />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Breadcrumbs({ root, path, onNavigate }: { root: string; path: string; onNavigate: (path: string) => void }) {
  const segments = path ? path.split("/") : [];
  return (
    <nav data-testid="files-breadcrumbs" aria-label="File path" className="flex flex-wrap items-baseline gap-1 border-b border-outline-variant px-2 py-1 text-xs text-on-surface">
      <button type="button" onClick={() => onNavigate("")} className="font-medium hover:underline"><span className="font-mono">{root}</span></button>
      {segments.map((seg, idx) => {
        const accumulated = segments.slice(0, idx + 1).join("/");
        return (
          <span key={accumulated}>
            <span className="mx-0.5 text-on-surface-variant">/</span>
            <button type="button" onClick={() => onNavigate(accumulated)} className="hover:underline font-mono">
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
  if (list.isLoading) return <div className="p-3 text-xs text-on-surface-variant">Loading…</div>;
  if (list.isError) return <div data-testid="files-list-error" className="p-3 text-xs text-destructive">{(list.error as Error)?.message ?? "Error loading directory."}</div>;
  if (!list.data || list.data.entries.length === 0) {
    return (
      <EmptyState
        label="Empty directory"
        title="This folder is empty"
        description="This directory has no files or subfolders yet."
      />
    );
  }
  return (
    <ul data-testid="files-directory-tree" className="p-1">
      {path && (
        <li>
          <button
            type="button"
            data-testid="files-up"
            onClick={() => onEnterDir(parentPath(path))}
            className="block w-full px-2 py-1 text-left text-xs text-on-surface-variant hover:bg-surface-low"
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
              className={`block w-full px-2 py-1 text-left text-xs font-mono ${
                entry.type === "other"
                  ? "text-on-surface-variant"
                  : `hover:bg-surface-low ${isSelected ? "bg-surface-mid text-on-surface" : "text-on-surface"}`
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
      <header className="flex items-center justify-between border-b border-outline-variant bg-background px-3 py-2">
        <div className="text-on-surface text-xs" data-testid="files-content-path"><span className="font-mono">{root}/{path}</span></div>
        <div className="flex items-center gap-3 text-on-surface-variant text-xs">
          {read.data && (
            <>
              <span className="font-mono" data-testid="files-content-size">{read.data.size}b</span>
              <span className="font-mono" data-testid="files-content-mtime">{read.data.mtime}</span>
            </>
          )}
          <button
            type="button"
            data-testid="files-edit-toggle"
            data-active={editMode}
            onClick={onToggleEditMode}
            className={`rounded-md border px-2 py-0.5 text-xs ${
              editMode
                ? "border-amber-400 bg-amber-50 text-amber-900"
                : "border-outline-variant text-on-surface hover:bg-surface-low"
            }`}
          >
            {editMode ? "Editing" : "Edit"}
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.isLoading && <div className="p-4 text-xs text-on-surface-variant">Loading…</div>}
        {read.isError && <div data-testid="files-read-error" className="p-4 text-xs text-destructive">{(read.error as Error)?.message ?? "Error loading file."}</div>}
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
        <img src={fileAssetUrl(root, path)} alt={path} className="max-w-full border border-outline-variant" />
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
      <div data-testid="files-download-only" className="p-4 text-xs text-on-surface">
        <a href={fileAssetUrl(root, path)} download className="text-brand underline">
          Download <span className="font-mono">{path}</span>
        </a>
      </div>
    );
  }
  return (
    <div data-testid="files-text-fallback" className="p-4">
      <TruncationMarker read={read} />
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-on-surface">{read.content}</pre>
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
      className="mb-3 rounded-lg border border-outline-variant bg-surface-low px-3 py-2 text-xs text-on-surface"
    >
      Truncated by file viewer at <span className="font-mono">{Math.round((read.truncatedAtBytes ?? 0) / 1024)} KB</span> —
      file is <span className="font-mono">{totalKb} KB</span> total. Use an external editor for full content.
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
      <div data-testid="files-spec-validation-loading" className="mb-3 rounded-lg border border-outline-variant bg-surface-low px-3 py-2 text-xs text-on-surface-variant">
        Validating <span className="font-mono">{kind}.yaml</span>…
      </div>
    );
  }
  if (review.isError) {
    return (
      <div data-testid="files-spec-validation-error" className="mb-3 rounded-lg border border-outline-variant bg-surface-low px-3 py-2 text-xs text-destructive">
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
      className="mb-3 rounded-lg border bg-surface-lowest px-3 py-2"
    >
      <div className="mb-1">
        {isValid
          ? <StatusBadge status="done" label={`Valid ${kind === "rig" ? "rig spec" : "agent spec"}`} />
          : <StatusBadge status="failed" label={`${kind === "rig" ? "Rig spec" : "Agent spec"} validation errors`} />}
      </div>
      {errors.length > 0 && (
        <ul className="space-y-1 text-xs">
          {errors.map((err, idx) => (
            <li
              key={idx}
              data-testid={`files-spec-validation-error-${idx}`}
              className="text-xs"
            >
              {err.field && <span className="font-semibold">{err.field}: </span>}
              {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileEditor({ root, path, read }: { root: string; path: string; read: FilesReadResponse }) {
  const [{ draft, base }, setEditor] = useState({ draft: read.content, base: read });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentMtime: string; currentContentHash: string } | null>(null);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const write = useFilesWrite();
  const writePending = useRef(write.isPending);
  writePending.current = write.isPending;
  const qc = useQueryClient();

  // A background read may advance while the operator is editing. Keep both
  // the draft and the revision it was based on until save, cancel or Refresh.
  useEffect(() => {
    const pending = writePending.current;
    setEditor((current) => pending || current.draft !== current.base.content
      ? current : { draft: read.content, base: read });
  }, [read.contentHash, read.mtime, read.content]);

  const dirty = useMemo(() => draft !== base.content, [draft, base.content]);

  return (
    <div data-testid="files-editor" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-outline-variant bg-surface-low px-3 py-1.5 text-xs">
        <span className="font-semibold text-on-surface" data-testid="files-editor-status">
          {dirty ? "Draft (unsaved)" : "No changes"}
        </span>
        <div className="flex items-center justify-between gap-2 flex-1">
          <Button
            variant="ghost"
            size="sm"
            data-testid="files-editor-cancel"
            onClick={() => { setEditor({ draft: read.content, base: read }); setSaveError(null); setConflict(null); }}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
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
                  expectedMtime: base.mtime,
                  expectedContentHash: base.contentHash,
                  actor: "ui-files-edit-mode",
                },
                {
                  onSuccess: (result: FileWriteResult) => {
                    if ("conflict" in result) {
                      setConflict({ currentMtime: result.currentMtime, currentContentHash: result.currentContentHash });
                    } else {
                      setEditor((current) => ({ ...current, base: {
                        ...base, content: draft, mtime: result.newMtime, contentHash: result.newContentHash,
                      } }));
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
          >
            Save
          </Button>
        </div>
        {savedIndicator && (
          <span data-testid="files-editor-saved" className="ml-auto text-xs text-on-surface-variant">Saved</span>
        )}
      </div>
      {conflict && (
        <div data-testid="files-editor-conflict" className="flex items-center gap-2 border-b border-outline-variant bg-surface-low px-3 py-2 text-xs text-on-surface">
          <span className="flex-1">
            File changed externally. Local mtime <code className="font-mono">{base.mtime}</code> ≠ server <code className="font-mono">{conflict.currentMtime}</code>. Click Refresh to re-read the file (your draft will be replaced with the new server content; copy it elsewhere first if you need to re-apply).
          </span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="files-editor-refresh"
            onClick={async () => {
              const queryKey = ["files", "read", root, path];
              try {
                await qc.refetchQueries({ queryKey, exact: true }, { throwOnError: true });
                const fresh = qc.getQueryData<FilesReadResponse>(queryKey);
                if (fresh) {
                  setEditor({ draft: fresh.content, base: fresh });
                  setConflict(null);
                  setSaveError(null);
                }
              } catch (err) {
                setSaveError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Refresh
          </Button>
        </div>
      )}
      {saveError && (
        <div data-testid="files-editor-error" className="border-b border-outline-variant bg-surface-low px-3 py-2 text-xs text-destructive">
          Save failed: {saveError}
        </div>
      )}
      <textarea
        data-testid="files-editor-textarea"
        value={draft}
        onChange={(e) => { const value = e.target.value; setEditor((current) => ({ ...current, draft: value })); }}
        className="flex-1 min-h-0 resize-none border-0 bg-background p-3 font-mono text-xs leading-relaxed text-on-surface outline-none"
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
