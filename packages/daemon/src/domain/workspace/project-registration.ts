import fs from "node:fs";
import nodePath from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

/**
 * Registers a bundle's project in the workspace catalog and records which rig
 * works in it, before that rig's first turn.
 *
 * The record is an optional `rigs` list on the catalog entry:
 *   projects: [{ id, root, rigs: [<rig name>] }]
 * `rig context work-install` reads it to resolve a seat's project from its rig.
 * The entry names a catalog id and a root; nothing else stores the path.
 *
 * Rules (agreed with the work-install selection order):
 * 1. The catalog is found through workspace.catalog_path, never a literal.
 * 2. The edit is additive and keeps the file's comments and layout.
 * 3. An entry with the same canonical root is the same project: its id is
 *    reused and the rig name is added once, so reinstalling changes nothing.
 * 4. If the id is taken by another root, or the rig is already listed under
 *    another project, nothing is written for that part. The result says so,
 *    with the fix; it is reported, never thrown.
 */

export interface ProjectRegistrationInput {
  /** Extracted project folder from the bundle (holds project.yaml). */
  bundleProjectDir: string;
  projectId: string;
  rigName: string;
  /** workspace.projects_root: the project folder is materialized at <projectsRoot>/<id>. */
  projectsRoot: string;
  /** workspace.catalog_path. */
  catalogPath: string;
}

export interface ProjectRegistrationResult {
  /** registered: entry added; associated: rig added to an existing entry; already_registered: nothing to change; conflict: nothing written for the catalog part. */
  status: "registered" | "associated" | "already_registered" | "conflict";
  projectId: string;
  projectRoot: string;
  catalogPath: string;
  rigName: string;
  /** The project folder already existed with different files; it was kept unchanged. */
  projectFolderKept?: boolean;
  detail?: string;
}

const CATALOG_HEADER = "schema: openrig.workspace/v0alpha1\n";

function canonical(p: string): string {
  try { return fs.realpathSync(p); } catch { return nodePath.resolve(p); }
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(nodePath.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Copy the bundle's project folder into place unless something is already there. Returns true when an existing, different folder was kept. */
function materializeProjectFolder(source: string, target: string): boolean {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    return false;
  }
  const identical = listFiles(source).every((rel) => {
    const installed = nodePath.join(target, rel);
    return fs.existsSync(installed) && fs.readFileSync(installed).equals(fs.readFileSync(nodePath.join(source, rel)));
  });
  return !identical;
}

function entryString(entry: YAMLMap, key: string): string | undefined {
  const value = entry.get(key);
  return typeof value === "string" ? value : undefined;
}

function entryRigs(entry: YAMLMap): string[] {
  const rigs = entry.get("rigs");
  return isSeq(rigs) ? rigs.items.map((item) => String(isScalar(item) ? item.value : item)) : [];
}

export function registerBundleProject(input: ProjectRegistrationInput): ProjectRegistrationResult {
  const projectRoot = nodePath.join(input.projectsRoot, input.projectId);
  const projectFolderKept = materializeProjectFolder(input.bundleProjectDir, projectRoot);
  const catalogDir = nodePath.dirname(input.catalogPath);
  const relativeRoot = nodePath.relative(catalogDir, projectRoot).split(nodePath.sep).join("/") || ".";
  const base = { projectId: input.projectId, projectRoot, catalogPath: input.catalogPath, rigName: input.rigName, ...(projectFolderKept ? { projectFolderKept } : {}) };

  let doc: Document;
  if (fs.existsSync(input.catalogPath)) {
    doc = parseDocument(fs.readFileSync(input.catalogPath, "utf-8"));
    if (doc.errors.length > 0) {
      return { ...base, status: "conflict", detail: `${input.catalogPath} does not parse (${doc.errors[0]!.message}); nothing was changed. Fix the file, then install the bundle again` };
    }
  } else {
    // A workspace with no catalog resolves every rig to the workspace root. Keep that for the user's
    // own rigs: the scaffold's default entry stays the one unclaimed entry beside the bundle's project.
    doc = parseDocument(`${CATALOG_HEADER}projects:\n  - id: default\n    root: .\n`);
  }

  let projects = doc.get("projects");
  if (!isSeq(projects)) {
    doc.set("projects", doc.createNode([]));
    projects = doc.get("projects");
  }
  const entries = (projects as YAMLSeq).items.filter((item): item is YAMLMap => isMap(item));

  const projectCanonical = canonical(projectRoot);
  const sameRoot = entries.find((entry) => {
    const root = entryString(entry, "root");
    return root !== undefined && canonical(nodePath.resolve(catalogDir, root)) === projectCanonical;
  });
  const sameId = entries.find((entry) => entryString(entry, "id") === input.projectId);
  const target = sameRoot ?? sameId;
  const targetId = target ? entryString(target, "id") : input.projectId;

  if (!sameRoot && sameId) {
    return {
      ...base, status: "conflict",
      detail: `project id '${input.projectId}' is already registered in ${input.catalogPath} with a different root (${entryString(sameId, "root")}); nothing was changed. Rename one of the two ids in ${input.catalogPath}, then install the bundle again`,
    };
  }
  const claimedElsewhere = entries.find((entry) => entry !== target && entryRigs(entry).includes(input.rigName));
  if (claimedElsewhere) {
    return {
      ...base, status: "conflict",
      detail: `rig '${input.rigName}' is already associated with project '${entryString(claimedElsewhere, "id")}' in ${input.catalogPath}; nothing was changed. Remove '${input.rigName}' from that entry's rigs to associate it with '${targetId}'`,
    };
  }

  if (target) {
    if (entryRigs(target).includes(input.rigName)) return { ...base, projectId: targetId!, status: "already_registered" };
    const rigs = target.get("rigs");
    if (isSeq(rigs)) rigs.add(doc.createNode(input.rigName));
    else target.set("rigs", doc.createNode([input.rigName]));
    fs.writeFileSync(input.catalogPath, doc.toString());
    return { ...base, projectId: targetId!, status: "associated" };
  }

  (projects as YAMLSeq).add(doc.createNode({ id: input.projectId, root: relativeRoot, rigs: [input.rigName] }));
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(input.catalogPath, doc.toString());
  return { ...base, status: "registered" };
}
