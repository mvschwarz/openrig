// Slice 18 — Skills top-level Library index.
//
// Mounts at /specs/skills (added in routes.tsx). Reads useLibrarySkills,
// groups by source ("workspace" = user-defined; "openrig-managed" =
// built-ins), navigates to the existing /specs/skills/$skillToken detail
// route on row click.

import { useNavigate } from "@tanstack/react-router";
import { LibraryTopLevelEntry } from "./LibraryTopLevelEntry.js";
import { useLibrarySkills, type LibrarySkillEntry } from "../../hooks/useLibrarySkills.js";
import { librarySkillToken } from "../../lib/library-skills-routing.js";

function formatSkillFolder(source: unknown): string {
  if (source === "workspace") return "User-defined (workspace)";
  if (source === "openrig-managed") return "OpenRig managed";
  return String(source ?? "Other");
}

function SkillsEmptyState() {
  return (
    <div
      data-testid="skills-empty-state"
      className="border border-outline-variant bg-white/25 px-4 py-6 font-mono text-xs leading-relaxed text-stone-700"
    >
      <p className="font-bold uppercase tracking-wide text-stone-900">No skills visible</p>
      <p className="mt-2">
        Skills live under <code className="font-mono text-stone-900">.openrig/skills/</code> in your
        workspace, plus the built-in set shipped with OpenRig. If this list is empty, the daemon
        could not see either source through configured file roots.
      </p>
      <p className="mt-2">
        Drop a <code className="font-mono text-stone-900">SKILL.md</code> into a
        <code className="font-mono text-stone-900"> .openrig/skills/&lt;skill-name&gt;/</code>
        directory and refresh.
      </p>
    </div>
  );
}

export function SkillsIndexPage() {
  const { data: skills = [], isLoading } = useLibrarySkills();
  const navigate = useNavigate();

  const handleSkillClick = (skill: LibrarySkillEntry) => {
    navigate({ to: "/specs/skills/$skillToken", params: { skillToken: librarySkillToken(skill.id) } });
  };

  return (
    <LibraryTopLevelEntry<LibrarySkillEntry>
      slug="skills"
      displayName="Skills"
      iconKind="skill"
      items={skills}
      folderField="source"
      formatFolderLabel={formatSkillFolder}
      emptyState={<SkillsEmptyState />}
      onItemClick={handleSkillClick}
      isLoading={isLoading}
      isUserDefined={(skill) => skill.source === "workspace"}
    />
  );
}
