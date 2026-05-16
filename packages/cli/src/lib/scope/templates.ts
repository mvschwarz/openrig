// release-0.3.2 slice 12 — template loader. Templates live as
// markdown files alongside the source so they can be edited like any
// other doc. The build copies them to dist/ via tsconfig
// rootDir/files behavior — but since .md isn't a .ts file, we read
// them directly via fileURLToPath to remain robust across local dev
// and the published package layout.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MissionTemplateKind, SliceTemplateKind } from "./types.js";
import { ScopeCliError } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Candidate template roots, in order: source tree (dev), dist (built).
 *  We resolve at call time so the first existing directory wins. */
function candidateRoots(): string[] {
  return [
    // Dev: packages/cli/src/lib/scope/ → ../scope-templates
    path.resolve(here, "..", "scope-templates"),
    // Built: dist/lib/scope/ → ../../src/lib/scope-templates (one level up further if
    // dist lands at packages/cli/dist/lib/scope).
    path.resolve(here, "..", "..", "lib", "scope-templates"),
    // Fallback: source tree relative to compiled dist when source is co-shipped.
    path.resolve(here, "..", "..", "..", "src", "lib", "scope-templates"),
  ];
}

function resolveTemplate(filename: string): string {
  for (const root of candidateRoots()) {
    const candidate = path.join(root, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new ScopeCliError({
    fact: `Template ${filename} could not be located.`,
    consequence: "Cannot scaffold the new artifact.",
    action: "Reinstall @openrig/cli, or run from a checkout with packages/cli/src/lib/scope-templates/ present.",
  });
}

export interface RenderOpts {
  id: string;
  slice_number?: string;     // zero-padded; only for slice templates
  slug: string;
  mission: string;
  title: string;
  created_date: string;
  release_version?: string;
}

function applyPlaceholders(content: string, opts: RenderOpts): string {
  return content
    .replace(/\{\{id\}\}/g, opts.id)
    .replace(/\{\{slice_number\}\}/g, opts.slice_number ?? "")
    .replace(/\{\{slug\}\}/g, opts.slug)
    .replace(/\{\{mission\}\}/g, opts.mission)
    .replace(/\{\{title\}\}/g, opts.title)
    .replace(/\{\{created_date\}\}/g, opts.created_date)
    .replace(/\{\{release_version\}\}/g, opts.release_version ?? "");
}

export function renderSliceTemplate(kind: SliceTemplateKind, opts: RenderOpts): string {
  const filename = `${kind}.md`;
  const raw = fs.readFileSync(resolveTemplate(filename), "utf8");
  return applyPlaceholders(raw, opts);
}

export function renderMissionTemplate(kind: MissionTemplateKind, opts: RenderOpts): string {
  const filename = kind === "release" ? "mission-release.md" : "mission-placeholder.md";
  const raw = fs.readFileSync(resolveTemplate(filename), "utf8");
  return applyPlaceholders(raw, opts);
}

/** Convert a folder-slug to a title-cased display name. */
export function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
