import { Link } from "@tanstack/react-router";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { FileViewer } from "../drawer-viewers/FileViewer.js";
import { useLibrarySkills, type LibrarySkillFile } from "../../hooks/useLibrarySkills.js";
import {
  librarySkillFilePathFromToken,
  librarySkillFileToken,
  librarySkillIdFromToken,
  librarySkillToken,
} from "../../lib/library-skills-routing.js";

function preferredSkillFile(files: LibrarySkillFile[]): LibrarySkillFile | null {
  return files.find((file) => file.name.toLowerCase() === "skill.md") ?? files[0] ?? null;
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
  const requestedFilePath = fileToken ? librarySkillFilePathFromToken(fileToken) : null;
  const skill = skillId ? skills.find((entry) => entry.id === skillId) ?? null : null;
  const defaultFile = skill ? preferredSkillFile(skill.files) : null;
  const selectedFile = skill
    ? skill.files.find((file) => file.path === requestedFilePath) ?? (requestedFilePath ? null : defaultFile)
    : null;

  if (isLoading) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="LOADING SKILL"
          description="Loading skill files from configured library roots."
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
          description="The selected skill is not visible through the configured library roots."
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
            title={skill.directoryPath}
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
          <div className="border-b border-outline-variant px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
            Files
          </div>
          {skill.files.length === 0 ? (
            <div data-testid="skill-detail-tree-empty" className="p-3 font-mono text-[10px] text-stone-400">
              No files in this skill folder.
            </div>
          ) : (
            <ul className="p-1">
              {skill.files.map((file) => {
                const isActive = selectedFile?.path === file.path;
                return (
                  <li key={file.path}>
                    <Link
                      to="/specs/skills/$skillToken/file/$fileToken"
                      params={{
                        skillToken: librarySkillToken(skill.id),
                        fileToken: librarySkillFileToken(file.path),
                      }}
                      data-testid={`skill-detail-tree-file-${file.name}`}
                      data-active={isActive}
                      className={`flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-[10px] hover:bg-stone-100 ${
                        isActive ? "bg-stone-200/80 text-stone-900" : "text-stone-700"
                      }`}
                    >
                      <ToolMark tool={file.name} size="xs" title={file.name} decorative />
                      <span className="truncate">{file.name}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main data-testid="skill-detail-viewer" className="flex-1 min-w-0 overflow-y-auto bg-white">
          {!selectedFile ? (
            <div data-testid="skill-detail-file-missing" className="p-4">
              <EmptyState
                label={requestedFilePath ? "FILE NOT FOUND" : "SKILL.md NOT FOUND"}
                description={
                  requestedFilePath
                    ? "That file is not present in this skill folder."
                    : "This skill does not include a SKILL.md file. Pick another file from the tree."
                }
                variant="card"
                testId="skill-detail-file-missing-empty-state"
              />
            </div>
          ) : (
            <FileViewer
              path={`${skill.name}/${selectedFile.name}`}
              root={skill.root}
              readPath={selectedFile.path}
              kind="markdown"
            />
          )}
        </main>
      </div>
    </div>
  );
}
