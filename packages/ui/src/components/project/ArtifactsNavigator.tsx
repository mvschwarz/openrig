// OPR.0.4.1.21 — Artifacts tab: altitude-scoped file navigator.
//
// Read-only PROJECTION over the EXISTING /api/files/* endpoints — a folder TREE
// (left, lazy per-folder /list on expand) + the selected folder's FILE LIST
// (right; type badge from extension + size + mtime straight from /list). File
// BODIES load only on open (FileLink -> SharedDetailDrawer -> /read or /asset).
// No new endpoint, no new write/security surface — it inherits the daemon's
// allowlist + path-traversal guards on the existing routes.
//
// THE LAZY-LOAD BOUNDARY (the slice-17 over-fetch lesson — see
// feedback_new_default_tab_flips_every_active_neq_guard): on landing fetch only
// /roots + /list(base); on folder EXPAND fetch /list(that folder); on file OPEN
// fetch /read|/asset. A collapsed folder passes root=null to useFilesList so the
// query is DISABLED (enabled:!!root) — never pre-walk the tree, never eager-fetch
// any file body on landing or tree render.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFilesRoots, useFilesList } from "../../hooks/useFiles.js";
import { resolveScopePathToAllowlist } from "../../hooks/useScopeMarkdown.js";
import { FileLink } from "../ui/FileLink.js";
import { EmptyState } from "../ui/empty-state.js";

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

/** Type badge from the file extension (UI-derived; mockup shows MD / DIFF / PNG). */
function fileBadge(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "···";
  return name.slice(idx + 1).toUpperCase();
}

/** Size straight from the /list entry (bytes -> human KB). */
function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** mtime straight from the /list entry (ISO -> "MM-DD HH:mm"). */
function formatMtime(mtime: string | null): string {
  if (!mtime) return "—";
  const d = new Date(mtime);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// LEFT — one folder node; lazily lists its children only when expanded.
function FolderNode({
  root,
  path,
  label,
  depth,
  selectedFolder,
  onSelectFolder,
  defaultExpanded = false,
}: {
  root: string;
  path: string;
  label: string;
  depth: number;
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Lazy boundary: pass root only when expanded so useFilesList is DISABLED
  // (enabled:!!root) while collapsed — a collapsed folder fetches nothing.
  const list = useFilesList(expanded ? root : null, path);
  const entries = list.data?.entries ?? [];
  const isSelected = selectedFolder === path;
  const indent = (d: number) => ({ paddingLeft: `${d * 12 + 4}px` });

  return (
    <li data-testid={`artifacts-tree-node-${path}`}>
      <div
        className={`flex items-center gap-1 font-mono text-[11px] ${
          isSelected ? "bg-surface-high/80 text-on-surface" : "text-on-surface hover:bg-surface-low"
        }`}
        style={indent(depth)}
      >
        <button
          type="button"
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          data-testid={`artifacts-tree-toggle-${path}`}
          onClick={() => setExpanded((e) => !e)}
          className="flex h-4 w-4 shrink-0 items-center justify-center"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <button
          type="button"
          data-testid={`artifacts-tree-folder-${path}`}
          data-selected={isSelected}
          onClick={() => {
            setExpanded(true);
            onSelectFolder(path);
          }}
          className="flex-1 truncate py-0.5 text-left"
        >
          {label}/
        </button>
      </div>
      {expanded ? (
        list.isLoading ? (
          <div style={indent(depth + 1)} className="py-0.5 font-mono text-[10px] text-on-surface-variant">
            Loading…
          </div>
        ) : list.isError ? (
          <div
            data-testid={`artifacts-tree-error-${path}`}
            style={indent(depth + 1)}
            className="py-0.5 font-mono text-[10px] text-red-600"
          >
            Error loading folder.
          </div>
        ) : (
          <ul>
            {entries
              .filter((e) => e.type === "dir")
              .map((e) => (
                <FolderNode
                  key={e.name}
                  root={root}
                  path={joinPath(path, e.name)}
                  label={e.name}
                  depth={depth + 1}
                  selectedFolder={selectedFolder}
                  onSelectFolder={onSelectFolder}
                />
              ))}
            {entries
              .filter((e) => e.type === "file")
              .map((e) => (
                <li key={e.name} style={indent(depth + 1)}>
                  <FileLink
                    root={root}
                    path={joinPath(path, e.name)}
                    testId={`artifacts-tree-file-${joinPath(path, e.name)}`}
                    className="block w-full truncate py-0.5 pl-5 text-left font-mono text-[11px] text-on-surface-variant hover:text-on-surface hover:underline"
                  >
                    {e.name}
                  </FileLink>
                </li>
              ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

// RIGHT — the selected folder's file list (metadata, not content).
function FolderFileList({ root, path }: { root: string; path: string }) {
  const list = useFilesList(root, path);
  const files = (list.data?.entries ?? []).filter((e) => e.type === "file");
  const header = `${(path || root).toUpperCase()} · ${files.length} FILE${files.length === 1 ? "" : "S"}`;

  return (
    <div data-testid="artifacts-file-list" className="min-w-0 flex-1">
      <div
        data-testid="artifacts-file-list-header"
        className="border-b border-outline-variant px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
      >
        {header}
      </div>
      {list.isLoading ? (
        <div className="px-3 py-2 font-mono text-[10px] text-on-surface-variant">Loading…</div>
      ) : list.isError ? (
        <div data-testid="artifacts-file-list-error" className="px-3 py-2 font-mono text-[10px] text-red-600">
          Error loading folder.
        </div>
      ) : files.length === 0 ? (
        <div data-testid="artifacts-file-list-empty" className="px-3 py-2 font-mono text-[10px] text-on-surface-variant">
          No files in this folder.
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/60">
          {files.map((f) => (
            <li
              key={f.name}
              data-testid={`artifacts-file-row-${f.name}`}
              className="flex items-center gap-3 px-3 py-1.5 font-mono text-[11px]"
            >
              <span
                data-testid={`artifacts-file-badge-${f.name}`}
                className="w-10 shrink-0 border border-outline-variant px-1 py-0.5 text-center text-[8px] uppercase tracking-[0.08em] text-on-surface-variant"
              >
                {fileBadge(f.name)}
              </span>
              <FileLink
                root={root}
                path={joinPath(path, f.name)}
                testId={`artifacts-file-open-${f.name}`}
                className="min-w-0 flex-1 truncate text-left text-on-surface hover:underline"
              >
                {f.name}
              </FileLink>
              <span data-testid={`artifacts-file-size-${f.name}`} className="shrink-0 text-on-surface-variant">
                {formatSize(f.size)}
              </span>
              <span className="shrink-0 text-on-surface-variant">·</span>
              <span data-testid={`artifacts-file-mtime-${f.name}`} className="shrink-0 text-on-surface-variant">
                {formatMtime(f.mtime)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Altitude-scoped Artifacts file navigator.
 * @param scopePath absolute filesystem path of the altitude folder (mission dir
 *   at mission altitude, slice dir at slice altitude); resolved to an allowlist
 *   (root, relPath) via the same resolver useScopeMarkdown uses.
 * @param scopeLabel the tree-root label (e.g. the mission or slice name).
 */
export function ArtifactsNavigator({ scopePath, scopeLabel, remoteGated }: { scopePath: string | null; scopeLabel: string; remoteGated?: boolean }) {
  // OPR.0.4.6.MH2 guard-B1 — under a remote host selection the scope path
  // belongs to the REMOTE filesystem and must never resolve against LOCAL
  // allowlist roots: remoteGated issues ZERO file requests and renders the
  // honest note. The local null-path flow is byte-preserved (roots fetched,
  // OUT OF SCOPE rendered) — the gate is the explicit prop, not null-ness.
  const rootsQuery = useFilesRoots({ enabled: remoteGated !== true });
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

  if (remoteGated) {
    return (
      <EmptyState
        label="LOCAL FILES NOT SHOWN"
        description={`Artifacts for ${scopeLabel} live on the selected host's filesystem, which the remote read view does not browse. Select the local host to browse local artifacts.`}
        variant="card"
        testId="artifacts-navigator-remote-gated"
      />
    );
  }

  if (rootsQuery.isLoading) {
    return (
      <div data-testid="artifacts-navigator-loading" className="font-mono text-[11px] text-on-surface-variant">
        Loading…
      </div>
    );
  }
  // "No allowlist configured" surfaces TWO ways from /api/files/roots: a 503
  // `unavailable` sentinel, OR a 200 with { roots: [], hint } (files.ts returns
  // the latter when OPENRIG_FILES_ALLOWLIST is unset). BOTH must render the same
  // setup hint — a user with no allowlist needs the instruction, not a misleading
  // "no artifacts / out of scope" (AC-5; rev1-r2 catch).
  if (!rootsQuery.data || isUnavailable(rootsQuery.data) || rootsQuery.data.roots.length === 0) {
    return (
      <EmptyState
        label="FILES UNAVAILABLE"
        description={
          rootsQuery.data?.hint ||
          "No allowlist files root is configured, so the artifact navigator can't list files. Configure a workspace files root to browse artifacts."
        }
        variant="card"
        testId="artifacts-navigator-unavailable"
      />
    );
  }

  const resolved = scopePath ? resolveScopePathToAllowlist(rootsQuery.data.roots, scopePath) : null;
  if (!resolved) {
    return (
      <EmptyState
        label="ARTIFACTS OUT OF SCOPE"
        description="This scope's folder is not under any configured files root, so its artifacts can't be listed."
        variant="card"
        testId="artifacts-navigator-no-scope"
      />
    );
  }

  const root = resolved.rootName;
  const basePath = resolved.relPath;
  // Default selection = the altitude base folder (so the landing fetches only
  // /roots + /list(base) — the tree root and the right-pane listing share the
  // same query key and dedupe).
  const activeFolder = selectedFolder ?? basePath;

  return (
    <div
      data-testid="artifacts-navigator"
      className="flex min-h-[20rem] border border-outline-variant bg-surface-lowest/20"
    >
      <aside
        data-testid="artifacts-tree"
        className="w-64 shrink-0 overflow-y-auto border-r border-outline-variant py-1"
      >
        <ul>
          <FolderNode
            root={root}
            path={basePath}
            label={scopeLabel || baseName(basePath) || root}
            depth={0}
            selectedFolder={activeFolder}
            onSelectFolder={setSelectedFolder}
            defaultExpanded
          />
        </ul>
      </aside>
      <FolderFileList root={root} path={activeFolder} />
    </div>
  );
}
