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
  /** Authored purpose. Defaults to title for backwards-compatible callers. */
  intent?: string;
  /** Advisory build-order edges to sibling work-node dot-IDs. */
  depends_on?: string[];
  release_version?: string;
  intent_visual_image_path?: string;
  intent_visual_diff_path?: string;
  intent_visual_build_command?: string;
}

/** Interpolate only template tokens, without interpreting or rescanning values. */
function replacePlaceholders(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{([A-Za-z_]+)\}\}/g, (placeholder: string, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : placeholder);
}

function applyPlaceholders(content: string, opts: RenderOpts): string {
  return replacePlaceholders(content, {
    id: opts.id,
    slice_number: opts.slice_number ?? "",
    slug: opts.slug,
    mission: opts.mission,
    title: opts.title,
    created_date: opts.created_date,
    intent_yaml: JSON.stringify(opts.intent ?? opts.title),
    intent: opts.intent ?? opts.title,
    depends_on: JSON.stringify(opts.depends_on ?? []),
    release_version: opts.release_version ?? "",
    intent_visual_image_path: opts.intent_visual_image_path ?? "./intent.png",
    intent_visual_diff_path: opts.intent_visual_diff_path ?? "./change.diff",
    intent_visual_build_command: opts.intent_visual_build_command ?? "TWIN_ROUTE=<route> npm run twin:build",
  });
}

export function renderSliceTemplate(kind: SliceTemplateKind, opts: RenderOpts): string {
  const filename = `${kind}.md`;
  const raw = fs.readFileSync(resolveTemplate(filename), "utf8");
  return applyPlaceholders(raw, opts);
}

/** Legacy renderer retained for callers reading or repairing pre-convention
 * trees. New scope scaffolds never call it. */
export function renderImplementationPrdTemplate(opts: RenderOpts): string {
  const raw = fs.readFileSync(resolveTemplate("implementation-prd.md"), "utf8");
  return applyPlaceholders(raw, opts);
}

export function renderMissionTemplate(kind: MissionTemplateKind, opts: RenderOpts): string {
  const filename = kind === "release" ? "mission-release.md" : "mission-placeholder.md";
  const raw = fs.readFileSync(resolveTemplate(filename), "utf8");
  return applyPlaceholders(raw, opts);
}

export function renderCapabilityDeltaTemplate(opts: RenderOpts): string {
  const raw = fs.readFileSync(resolveTemplate("capability-delta.md"), "utf8");
  return applyPlaceholders(raw, opts);
}

export interface NotesRenderOpts {
  mission_id: string;
  mission_name: string;
  created_date: string;
}

function applyNotesPlaceholders(content: string, opts: NotesRenderOpts): string {
  return replacePlaceholders(content, {
    mission_id: opts.mission_id,
    mission_name_yaml: JSON.stringify(opts.mission_name),
    mission_name: opts.mission_name,
    created_date: opts.created_date,
  });
}

export type NotesTemplateSource = "env" | "legacy-env" | "built-in";

/** Resolve the current NOTES.md template. The retired environment name stays
 * readable as a fallback and is surfaced to callers as `legacy-env`. */
export function resolveNotesTemplatePath(envValue?: string): { absPath: string; resolvedFrom: NotesTemplateSource } {
  const current = envValue ?? process.env.OPENRIG_NOTES_TEMPLATE_PATH;
  const legacy = envValue === undefined ? process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH : undefined;
  const selected = current?.trim() ? current : legacy?.trim() ? legacy : null;
  const resolvedFrom: NotesTemplateSource = current?.trim()
    ? "env"
    : legacy?.trim()
      ? "legacy-env"
      : "built-in";
  if (selected) {
    const absPath = path.resolve(selected);
    if (!fs.existsSync(absPath)) {
      const variable = resolvedFrom === "legacy-env"
        ? "OPENRIG_MISSION_NOTES_TEMPLATE_PATH"
        : "OPENRIG_NOTES_TEMPLATE_PATH";
      throw new ScopeCliError({
        fact: `${variable} points at "${selected}", which does not exist.`,
        consequence: "NOTES.md not scaffolded.",
        action: `Set OPENRIG_NOTES_TEMPLATE_PATH to an absolute readable template, or unset ${variable} to use the built-in fallback.`,
      });
    }
    return { absPath, resolvedFrom };
  }
  return { absPath: resolveTemplate("notes.md"), resolvedFrom };
}

export function renderNotesTemplate(
  opts: NotesRenderOpts,
  envValue?: string,
): { rendered: string; resolvedFrom: NotesTemplateSource; absPath: string } {
  const resolved = resolveNotesTemplatePath(envValue);
  return {
    rendered: applyNotesPlaceholders(fs.readFileSync(resolved.absPath, "utf8"), opts),
    ...resolved,
  };
}

export function renderMissionProgressTemplate(missionName: string): string {
  const raw = fs.readFileSync(resolveTemplate("mission-progress.md"), "utf8");
  return replacePlaceholders(raw, { missionName });
}

export function renderSliceProgressTemplate(sliceName: string): string {
  const raw = fs.readFileSync(resolveTemplate("slice-progress.md"), "utf8");
  return replacePlaceholders(raw, { sliceName });
}

export interface SliceProofRenderOpts {
  id: string;
  title: string;
}

export function renderSliceProofTemplate(opts: SliceProofRenderOpts): string {
  const raw = fs.readFileSync(resolveTemplate("proof.md"), "utf8");
  return replacePlaceholders(raw, { id: opts.id, title: opts.title });
}

/** Convert a folder-slug to a title-cased display name. */
export function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
