import { EmptyState } from "../ui/empty-state.js";
import { FileViewer } from "../drawer-viewers/FileViewer.js";
import { useLibrarySkills } from "../../hooks/useLibrarySkills.js";
import {
  librarySkillFilePathFromToken,
  librarySkillIdFromToken,
} from "../../lib/library-skills-routing.js";

function preferredSkillFile(files: Array<{ name: string; path: string }>) {
  return files.find((file) => file.name.toLowerCase() === "skill.md") ?? null;
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

  if (!selectedFile) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label={requestedFilePath ? "FILE NOT FOUND" : "SKILL.md NOT FOUND"}
          description={
            requestedFilePath
              ? "That file is not present in this skill folder."
              : "This skill does not include a SKILL.md file. Pick another file from the Library explorer."
          }
          variant="card"
          testId="skill-detail-file-missing"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="skill-detail-page"
      className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <div className="h-full border border-outline-variant bg-white/25 hard-shadow">
        <FileViewer
          path={`${skill.name}/${selectedFile.name}`}
          root={skill.root}
          readPath={selectedFile.path}
          kind="markdown"
        />
      </div>
    </div>
  );
}
