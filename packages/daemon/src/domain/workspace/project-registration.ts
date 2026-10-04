import fs from "node:fs";
import nodePath from "node:path";
import { Document, isMap, isScalar, isSeq, parse as parseYaml, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

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
 * 2. An existing catalog is never rewritten: every byte already there stays.
 *    A new entry is appended as text in the file's own indentation and line
 *    endings, and a rig joins an entry by a one-line edit of its `rigs: [...]`.
 *    Each edit is checked by re-parsing. When neither applies (for example a
 *    flow-style list), nothing is written and the result gives the exact line
 *    to add. Only a catalog created from scratch is written whole.
 * 3. An entry with the same id and the same canonical root is the same
 *    project: the rig name is added once, so reinstalling changes nothing.
 * 4. If the id is taken by another root, the root is registered under another
 *    id, or the rig is already listed under another project, nothing is
 *    written for that part. The result says so, with the fix; it is reported,
 *    never thrown.
 */

export interface ProjectRegistrationInput {
  /** Extracted project folder from the bundle (holds project.yaml). */
  bundleProjectDir: string;
  projectId: string;
  rigName: string;
  /** workspace.projects_root: the project folder is materialized at <projectsRoot>/<id>. */
  projectsRoot: string;
  /** workspace.root: a catalog written from scratch keeps it as the default project. */
  workspaceRoot: string;
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

/** Replace the catalog in one step: a reader sees the old file or the new one, never a partial write. */
function writeCatalog(catalogPath: string, text: string): void {
  const temp = `${catalogPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text);
  // Keep an existing catalog's permission bits (ownership is the writing user's, as with any edit).
  if (fs.existsSync(catalogPath)) fs.chmodSync(temp, fs.statSync(catalogPath).mode & 0o7777);
  try {
    fs.renameSync(temp, catalogPath);
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

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

/**
 * A YAML scalar for a string value: plain only when it is a simple name or path that YAML reads back as
 * the same string (so not `false`, `null`, `123` and the like); otherwise double-quoted.
 */
function scalar(value: string): string {
  const simple = /^[A-Za-z0-9_/][A-Za-z0-9._/-]*$|^\.{1,2}(\/[A-Za-z0-9._/-]*)?$/.test(value);
  return simple && parseYaml(value) === value ? value : JSON.stringify(value);
}

/**
 * Append one entry to a block-style `projects:` list as text, matching the
 * file's indentation and line endings, so nothing already there changes.
 * Returns null when `projects:` is not the last top-level key in block style,
 * or when re-parsing does not give exactly the old list plus the new entry.
 */
function appendEntryText(source: string, entry: { id: string; root: string; rigs: string[] }): string | null {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^projects:\s*(#.*)?$/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  if (rest.some((line) => /^[^\s#]/.test(line))) return null;
  const firstItem = rest.map((line) => /^(\s*)-(\s+)\S/.exec(line)).find((m): m is RegExpExecArray => m !== null);
  if (!firstItem) return null;
  const dash = firstItem[1]!;
  const gap = firstItem[2]!;
  const inner = " ".repeat(dash.length + 1 + gap.length);
  const text = [
    `${dash}-${gap}id: ${scalar(entry.id)}`,
    `${inner}root: ${scalar(entry.root)}`,
    `${inner}rigs: [${entry.rigs.map(scalar).join(", ")}]`,
  ].join(eol) + eol;
  const appended = (/\r?\n$/.test(source) ? source : source + eol) + text;
  const before = (parseDocument(source).toJS() as { projects?: unknown[] } | null)?.projects;
  const after = parseDocument(appended);
  if (!Array.isArray(before) || after.errors.length > 0) return null;
  const afterProjects = (after.toJS() as { projects?: unknown[] } | null)?.projects;
  return JSON.stringify(afterProjects) === JSON.stringify([...before, entry]) ? appended : null;
}

/**
 * Add a rig to an entry's one-line `rigs: [...]` list as a text edit. Returns
 * null when the entry has no such line, or when re-parsing does not give the
 * old catalog with only that rig added.
 */
function addRigText(source: string, projectId: string, rigName: string): string | null {
  const lines = source.split(/(?<=\n)/);
  const escaped = projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idLine = lines.findIndex((line) => new RegExp(`^\\s*(-\\s+)?id:\\s*["']?${escaped}["']?\\s*(#.*)?\\r?\\n?$`).test(line));
  if (idLine < 0) return null;
  const itemColumn = lines[idLine]!.search(/\S/);
  let rigsLine = -1;
  for (let i = idLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S/.test(line) || (/^\s*-\s/.test(line) && line.search(/\S/) <= itemColumn)) break;
    if (/^\s*rigs:\s*\[[^\]]*\]\s*(#.*)?\r?\n?$/.test(line)) { rigsLine = i; break; }
  }
  if (rigsLine < 0) return null;
  lines[rigsLine] = lines[rigsLine]!.replace(/\[([^\]]*)\]/, (_m, inside: string) => `[${inside.trim() ? `${inside.trimEnd()}, ` : ""}${scalar(rigName)}]`);
  const edited = lines.join("");
  const before = (parseDocument(source).toJS() as { projects?: Array<Record<string, unknown>> } | null)?.projects;
  const after = parseDocument(edited);
  if (!Array.isArray(before) || after.errors.length > 0) return null;
  const expected = before.map((p) => (p["id"] === projectId ? { ...p, rigs: [...((p["rigs"] as unknown[]) ?? []), rigName] } : p));
  return JSON.stringify((after.toJS() as { projects?: unknown[] }).projects) === JSON.stringify(expected) ? edited : null;
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
  let existingText: string | undefined;
  if (fs.existsSync(input.catalogPath)) {
    existingText = fs.readFileSync(input.catalogPath, "utf-8");
    doc = parseDocument(existingText);
    if (doc.errors.length > 0) {
      return { ...base, status: "conflict", detail: `${input.catalogPath} does not parse (${doc.errors[0]!.message}); nothing was changed. Fix the file, then install the bundle again` };
    }
  } else {
    // A workspace with no catalog resolves every rig to the workspace root. Keep that for the user's
    // own rigs: a default entry for the workspace root stays the one unclaimed entry beside the
    // bundle's project. Its root is relative to the catalog, which need not sit in the workspace root.
    const defaultRoot = nodePath.relative(catalogDir, input.workspaceRoot).split(nodePath.sep).join("/") || ".";
    doc = parseDocument(`${CATALOG_HEADER}projects:\n  - id: default\n    root: ${scalar(defaultRoot)}\n`);
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

  if (sameRoot && entryString(sameRoot, "id") !== input.projectId) {
    return {
      ...base, status: "conflict",
      detail: `${projectRoot} is already registered in ${input.catalogPath} as project '${entryString(sameRoot, "id")}', but its project.yaml says '${input.projectId}'; nothing was changed. Make the two ids agree, then install the bundle again`,
    };
  }
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
    const edited = existingText !== undefined ? addRigText(existingText, targetId!, input.rigName) : null;
    if (edited === null) {
      return {
        ...base, projectId: targetId!, status: "conflict",
        detail: `could not add rig '${input.rigName}' to project '${targetId}' in ${input.catalogPath} without rewriting the file; nothing was changed. Add '${input.rigName}' to that entry's rigs list (rigs: [${input.rigName}]) by hand`,
      };
    }
    writeCatalog(input.catalogPath, edited);
    return { ...base, projectId: targetId!, status: "associated" };
  }

  const entry = { id: input.projectId, root: relativeRoot, rigs: [input.rigName] };
  if (existingText !== undefined) {
    const appended = appendEntryText(existingText, entry);
    if (appended === null) {
      return {
        ...base, status: "conflict",
        detail: `could not append project '${input.projectId}' to ${input.catalogPath} without rewriting the file; nothing was changed. Add this entry under projects by hand: { id: ${input.projectId}, root: ${relativeRoot}, rigs: [${input.rigName}] }`,
      };
    }
    writeCatalog(input.catalogPath, appended);
    return { ...base, status: "registered" };
  }
  (projects as YAMLSeq).add(doc.createNode(entry));
  fs.mkdirSync(catalogDir, { recursive: true });
  writeCatalog(input.catalogPath, doc.toString());
  return { ...base, status: "registered" };
}
