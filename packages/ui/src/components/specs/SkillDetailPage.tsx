import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SyntaxHighlight } from "../markdown/SyntaxHighlight.js";
import { useLibrarySkills } from "../../hooks/useLibrarySkills.js";
import { useSkillFilesList, useSkillFilesRead } from "../../hooks/useSkillFiles.js";
import {
  librarySkillFilePathFromToken,
  librarySkillIdFromToken,
} from "../../lib/library-skills-routing.js";

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

export function SkillDetailPage({
  skillToken,
  fileToken,
}: {
  skillToken: string;
  fileToken?: string | null;
}) {
  const { data: skills = [], isLoading } = useLibrarySkills();
  const skillId = librarySkillIdFromToken(skillToken);
  const skill = skillId ? skills.find((entry) => entry.id === skillId) ?? null : null;

  // Relative path within the skill folder. Empty string = skill root.
  const [currentPath, setCurrentPath] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [defaultPicked, setDefaultPicked] = useState(false);

  // Resolve fileToken into currentPath + selectedFile once the skill is
  // available. fileToken's encoded path is relative to skill root post-C4
  // (e.g., "SKILL.md" or "examples/basic.md").
  useEffect(() => {
    if (!fileToken || !skill) return;
    const requestedRelPath = librarySkillFilePathFromToken(fileToken);
    if (!requestedRelPath) return;
    setCurrentPath(parentPath(requestedRelPath));
    setSelectedFile(requestedRelPath);
    setDefaultPicked(true);
  }, [fileToken, skill]);

  // Daemon /api/skills/:id/files/list call (replaces /api/files/list).
  const list = useSkillFilesList(skill?.id ?? null, currentPath);

  // Auto-select SKILL.md at the skill root on first load (when no fileToken
  // resolution happened).
  useEffect(() => {
    if (defaultPicked) return;
    if (currentPath !== "") return;
    if (!list.data) return;
    const skillMd = list.data.entries.find(
      (e) => e.type === "file" && /^skill\.md$/i.test(e.name),
    );
    if (skillMd) setSelectedFile(skillMd.name);
    setDefaultPicked(true);
  }, [list.data, currentPath, defaultPicked]);

  if (isLoading) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="LOADING SKILL"
          description="Loading skill files from the daemon skill library."
          variant="card"
          testId="skill-detail-loading"
        />
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="SKILL NOT FOUND"
          description="The selected skill is not discoverable through the daemon skill library."
          variant="card"
          testId="skill-detail-not-found"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="skill-detail-page"
      className="h-full overflow-hidden bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-4">
        <SectionHeader tone="muted">Skill</SectionHeader>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="font-headline text-2xl font-bold tracking-tight text-stone-900">
            {skill.name}
          </h1>
          <span
            data-testid="skill-detail-source"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500"
          >
            {skill.source}
          </span>
        </div>
      </header>

      <div
        data-testid="skill-detail-docs-browser"
        className="flex h-[calc(100%-5rem)] flex-col border border-outline-variant bg-white/25 hard-shadow sm:flex-row"
      >
        <aside
          data-testid="skill-detail-tree"
          className="w-full max-h-48 shrink-0 overflow-y-auto border-b border-outline-variant bg-white/30 sm:w-64 sm:max-h-none sm:border-b-0 sm:border-r"
        >
          <Breadcrumbs
            testId="skill-detail-breadcrumbs"
            skillName={skill.name}
            path={currentPath}
            onNavigate={(rel) => { setCurrentPath(rel); setSelectedFile(null); }}
          />
          {list.isLoading ? (
            <div data-testid="skill-detail-tree-loading" className="p-3 font-mono text-[10px] text-stone-400">
              Loading…
            </div>
          ) : list.isError ? (
            <div data-testid="skill-detail-tree-error" className="p-3 font-mono text-[10px] text-red-600">
              {(list.error as Error)?.message ?? "Error loading directory."}
            </div>
          ) : !list.data || list.data.entries.length === 0 ? (
            <div data-testid="skill-detail-tree-empty" className="p-3 font-mono text-[10px] text-stone-400">
              Empty directory.
            </div>
          ) : (
            <ul className="p-1">
              {currentPath && (
                <li>
                  <button
                    type="button"
                    data-testid="skill-detail-tree-up"
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
                      data-testid={`skill-detail-tree-entry-${rel}`}
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

        <main data-testid="skill-detail-viewer" className="flex-1 min-w-0 overflow-y-auto bg-white">
          {!selectedFile ? (
            <div data-testid="skill-detail-viewer-no-selection" className="p-4 font-mono text-[10px] text-stone-400">
              Select a file from the tree.
            </div>
          ) : (
            <SkillFileContent skillId={skill.id} path={selectedFile} />
          )}
        </main>
      </div>
    </div>
  );
}

function Breadcrumbs({
  testId,
  skillName,
  path,
  onNavigate,
}: {
  testId: string;
  skillName: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <nav data-testid={testId} className="flex flex-wrap items-baseline gap-1 border-b border-outline-variant px-2 py-1 font-mono text-[10px] text-stone-700">
      <button type="button" onClick={() => onNavigate("")} className="font-bold hover:underline">
        {skillName}
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

function SkillFileContent({ skillId, path }: { skillId: string; path: string }) {
  const read = useSkillFilesRead(skillId, path);
  const ext = useMemo(() => pathExtension(path), [path]);

  if (read.isLoading) {
    return (
      <div data-testid="skill-detail-viewer-loading" className="p-4 font-mono text-[10px] text-stone-400">
        Loading…
      </div>
    );
  }
  if (read.isError) {
    return (
      <div data-testid="skill-detail-viewer-error" className="p-4 font-mono text-[10px] text-red-600">
        {(read.error as Error)?.message ?? "Error loading file."}
      </div>
    );
  }
  if (!read.data) return null;

  return (
    <div data-testid="skill-detail-viewer-content" className="flex h-full flex-col">
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2 font-mono text-[10px]">
        <div data-testid="skill-detail-viewer-path" className="text-stone-700">{path}</div>
        <div className="flex items-baseline gap-3 text-stone-500">
          <span>{read.data.size}b</span>
          <span>{read.data.mtime}</span>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.data.truncated && (
          <div
            data-testid="skill-detail-viewer-truncated"
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
          <pre data-testid="skill-detail-viewer-text-fallback" className="p-4 whitespace-pre-wrap break-words font-mono text-[10px] text-stone-800">
            {read.data.content}
          </pre>
        )}
      </div>
    </div>
  );
}
