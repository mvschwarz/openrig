import fs from "node:fs";
import nodePath from "node:path";
import { parse as parseYaml } from "yaml";
import { assertShippableSubstance } from "./agent-resolver.js";
import type { BundleProjectReference } from "./bundle-types.js";

/** The folder a carried project occupies inside a bundle. */
export const BUNDLE_PROJECT_DIR = "project";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The id a project.yaml declares, read the way `rig context work-install` reads it. */
export function projectManifestId(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const m = manifest as Record<string, unknown>;
  if (typeof m["id"] === "string") return m["id"];
  const metadata = m["metadata"];
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const id = (metadata as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return null;
}

/**
 * Vendor a project folder (project.yaml plus the files beside it, such as its
 * SPEC.md) into a bundle being built, for `rig bundle create --project-dir`.
 * Every file must resolve inside the folder. Returns the manifest's `project`
 * reference.
 */
export function vendorProjectDir(projectDir: string, staging: string): BundleProjectReference {
  let projectReal: string;
  try {
    projectReal = fs.realpathSync(projectDir);
  } catch {
    throw new Error(`project directory '${projectDir}' does not exist`);
  }
  const manifestPath = nodePath.join(projectReal, "project.yaml");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`project directory '${projectDir}' has no project.yaml`);
  }
  const id = projectManifestId(parseYaml(fs.readFileSync(manifestPath, "utf-8")));
  if (!id) throw new Error(`project.yaml in '${projectDir}' declares no id; add 'id: <name>'`);
  if (!PROJECT_ID.test(id)) throw new Error(`project id '${id}' must be a simple name (letters, digits, '.', '_', '-')`);

  const sources: Array<{ relativePath: string; path: string; bytes: Buffer }> = [];
  const collect = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = nodePath.join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const real = fs.realpathSync(absolute);
      if (!real.startsWith(projectReal + nodePath.sep)) {
        throw new Error(`project '${id}' entry '${relativePath}' resolves outside the project directory; rejected`);
      }
      const stat = fs.statSync(real);
      if (stat.isDirectory()) collect(real, relativePath);
      else if (stat.isFile()) sources.push({ relativePath, path: `${BUNDLE_PROJECT_DIR}/${relativePath}`, bytes: fs.readFileSync(real) });
    }
  };
  collect(projectReal, "");
  assertShippableSubstance(sources);

  for (const source of sources) {
    const target = nodePath.join(staging, BUNDLE_PROJECT_DIR, source.relativePath);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.bytes);
  }
  return { id, path: BUNDLE_PROJECT_DIR };
}
