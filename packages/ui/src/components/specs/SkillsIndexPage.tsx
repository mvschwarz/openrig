import { Link } from "@tanstack/react-router";
import { PageHeader } from "../ui/page-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { useLibrarySkills, type LibrarySkillEntry } from "../../hooks/useLibrarySkills.js";
import { librarySkillToken } from "../../lib/library-skills-routing.js";

function formatSkillSource(source: LibrarySkillEntry["source"]): string {
  if (source === "workspace") return "Workspace";
  if (source === "openrig-managed") return "OpenRig managed";
  return source;
}

export function SkillsIndexPage() {
  const { data: skills = [], isLoading } = useLibrarySkills();
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      data-testid="skills-index-page"
      className="mx-auto w-full max-w-[960px] px-6 py-8 text-sm"
    >
      <PageHeader
        title="Skills"
        description="Reusable skills your agents can load. Open one to browse its files."
        meta={
          <span data-testid="skills-index-count" className="text-xs text-on-surface-variant">
            {isLoading ? "Loading" : `${sorted.length} ${sorted.length === 1 ? "skill" : "skills"}`}
          </span>
        }
      />

      {isLoading && sorted.length === 0 ? (
        <div data-testid="skills-index-loading" className="text-xs text-on-surface-variant">
          Loading skills…
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No skills visible"
          label="No skills visible"
          description="Skills live under .openrig/skills/ in your workspace, plus the built-in set shipped with OpenRig. If this list is empty, the daemon could not see either source through configured file roots."
          variant="card"
          testId="skills-index-empty"
        />
      ) : (
        <ul data-testid="skills-index-rows" className="divide-y divide-outline-variant rounded-lg border bg-surface-lowest shadow-sm">
          {sorted.map((skill) => (
            <li key={skill.id}>
              <Link
                to="/specs/skills/$skillToken"
                params={{ skillToken: librarySkillToken(skill.id) }}
                data-testid={`skills-index-row-${skill.id}`}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-low/60 focus:outline-none focus:bg-surface-low/80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${skill.name} skill`} size="xs" decorative />
                  <span className="truncate font-medium text-on-surface">{skill.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-on-surface-variant">
                  <span data-testid={`skills-index-row-${skill.id}-source`}>{formatSkillSource(skill.source)}</span>
                  <span data-testid={`skills-index-row-${skill.id}-filecount`}>
                    {skill.files.length} {skill.files.length === 1 ? "file" : "files"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
