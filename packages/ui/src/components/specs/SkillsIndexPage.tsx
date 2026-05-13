import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
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
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Library</SectionHeader>
        <div className="mt-1 flex items-baseline justify-between">
          <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900">
            Skills
          </h1>
          <span data-testid="skills-index-count" className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500">
            {isLoading ? "loading" : `${sorted.length} ${sorted.length === 1 ? "skill" : "skills"}`}
          </span>
        </div>
      </header>

      {isLoading && sorted.length === 0 ? (
        <div data-testid="skills-index-loading" className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500">
          Loading skills…
        </div>
      ) : sorted.length === 0 ? (
        <div
          data-testid="skills-index-empty"
          className="border border-outline-variant bg-white/25 px-4 py-6 font-mono text-xs leading-relaxed text-stone-700"
        >
          <p className="font-bold uppercase tracking-wide text-stone-900">No skills visible</p>
          <p className="mt-2">
            Skills live under <code className="font-mono text-stone-900">.openrig/skills/</code> in your
            workspace, plus the built-in set shipped with OpenRig. If this list is empty, the daemon
            could not see either source through configured file roots.
          </p>
        </div>
      ) : (
        <ul data-testid="skills-index-rows" className="border border-outline-variant bg-white/25 hard-shadow divide-y divide-outline-variant">
          {sorted.map((skill) => (
            <li key={skill.id}>
              <Link
                to="/specs/skills/$skillToken"
                params={{ skillToken: librarySkillToken(skill.id) }}
                data-testid={`skills-index-row-${skill.id}`}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 font-mono text-left hover:bg-stone-100/60 focus:outline-none focus:bg-stone-100/80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${skill.name} skill`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-stone-900">{skill.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
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
