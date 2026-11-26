// #3616 — one writer for the planned fields a rig sets on its mission and slice manifests: a slice's planned owners
// and execution edges, and a mission's waves and status. Each edit parses the file as a YAML document, changes only the
// fields it names, and writes the document back, so unrelated keys, comments, order and extensions survive.

import * as fs from "node:fs";
import * as path from "node:path";
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { resolveNodeFile } from "./node-file.js";
import { readMissionReadiness } from "../proof/judgments.js";

export type ManifestEditOutcome = "written" | "unchanged";

/** A manifest that couldn't be edited. Nothing was written: the file is as it was. */
export class ManifestEditError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`${file}: ${reason}; it was left as it is`);
    this.name = "ManifestEditError";
  }
}

/** Written as authored, as far as the yaml package allows: a long line isn't folded, and flow collections are padded
 *  (`{ a: 1 }`) or not (`[a]`) as most of the file's own are, since it writes them all one way. */
function asAuthored(text: string) {
  const padded = (text.match(/[[{] \S/g) ?? []).length;
  const tight = (text.match(/[[{][^\s\]}]/g) ?? []).length;
  return { flowCollectionPadding: padded >= tight, lineWidth: 0 };
}

/** Applies `edit` to the manifest at `file` and writes it atomically. An edit that changes nothing writes nothing
 *  (`unchanged`), so a rerun leaves the file's bytes alone. */
export function editManifest(file: string, edit: (doc: Document) => void): ManifestEditOutcome {
  const text = fs.readFileSync(file, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ManifestEditError(file, `it can't be parsed (${doc.errors[0]!.message})`);
  const style = asAuthored(text);
  const before = doc.toString(style);
  try {
    edit(doc);
  } catch (err) {
    throw new ManifestEditError(file, err instanceof Error ? err.message : String(err));
  }
  const after = doc.toString(style);
  if (after === before) return "unchanged";
  writeAtomically(file, after);
  return "written";
}

function writeAtomically(file: string, text: string): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.openrig-${process.pid}.tmp`);
  fs.writeFileSync(temporary, text, "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

/** The list at `at`, added when absent. */
function listAt(doc: Document, at: string[]): YAMLSeq {
  const found = doc.getIn(at, true);
  if (found === undefined || found === null) {
    const created = doc.createNode([]) as YAMLSeq;
    doc.setIn(at, created);
    return created;
  }
  if (!isSeq(found)) throw new Error(`${at.join(".")} is not a list`);
  return found;
}

function idList(doc: Document, ids: readonly string[]): YAMLSeq {
  const node = doc.createNode([...ids]) as YAMLSeq;
  node.flow = true;
  return node;
}

function entryWithId(list: YAMLSeq, id: string): YAMLMap | undefined {
  return list.items.find((item): item is YAMLMap => isMap(item) && item.get("id") === id);
}

/** slice.yaml `sdlc.components[]`: sets the planned owner of the component whose `id` this is, adding the component
 *  when absent. Planned metadata for the execution view, not a queue assignment. */
export function setPlannedOwner(doc: Document, component: string, owner: string): void {
  const components = listAt(doc, ["sdlc", "components"]);
  const entry = entryWithId(components, component);
  if (entry) entry.set("owner", owner);
  else components.add(doc.createNode({ id: component, owner }));
}

/** Removes only `owner` from the component whose `id` this is. False when it had none. */
export function clearPlannedOwner(doc: Document, component: string): boolean {
  const components = doc.getIn(["sdlc", "components"], true);
  if (!isSeq(components)) return false;
  return entryWithId(components, component)?.delete("owner") ?? false;
}

/** slice.yaml `execution.depends_on`, the build-order edges proof readiness reads; `null` removes the list (and an
 *  `execution` mapping left empty). Validate the ids first (#3618's rule). */
export function setExecutionDependsOn(doc: Document, ids: readonly string[] | null): void {
  if (ids) {
    doc.setIn(["execution", "depends_on"], idList(doc, ids));
    return;
  }
  const execution = doc.get("execution", true);
  if (!isMap(execution)) return;
  execution.delete("depends_on");
  if (execution.items.length === 0) doc.delete("execution");
}

/** mission.yaml `arrangement.waves[]`: sets the slices of the wave whose `id` this is, adding the wave when absent and
 *  keeping its other keys and the other waves. A wave is one shape: its own `slices` list, or `lanes` of lists. `lane`
 *  writes one lane of a lane-shaped wave. A write that would change a wave's shape returns why and changes nothing,
 *  since a `slices` list beside `lanes` would hide the lanes. Composition only: a wave isn't dispatch. */
export function setWave(doc: Document, id: string, slices: readonly string[], lane?: string): { shapeConflict?: string } {
  const waves = listAt(doc, ["arrangement", "waves"]);
  const wave = entryWithId(waves, id);
  if (!wave) {
    waves.add(doc.createNode(lane ? { id, lanes: { [lane]: idList(doc, slices) } } : { id, slices: idList(doc, slices) }));
    return {};
  }
  const lanes = wave.get("lanes", true);
  if (lane) {
    if (wave.has("slices")) return { shapeConflict: `Wave ${id} lists its slices directly, not in lanes.` };
    if (lanes === undefined || lanes === null) wave.set("lanes", doc.createNode({ [lane]: idList(doc, slices) }));
    else if (isMap(lanes)) lanes.set(lane, idList(doc, slices));
    else return { shapeConflict: `Wave ${id}'s lanes are not a mapping of lane names to lists.` };
    return {};
  }
  if (wave.has("lanes")) {
    if (!isMap(lanes)) return { shapeConflict: `Wave ${id}'s lanes are not a mapping of lane names to lists.` };
    const names = lanes.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key));
    return { shapeConflict: `Wave ${id} is lane-shaped (lanes: ${names.join(", ") || "none"}), and a slices list beside them would hide them.` };
  }
  wave.set("slices", idList(doc, slices));
  return {};
}

/** Sets a mission's authored status: `mission.yaml` `metadata.status`, or a legacy mission's node-file frontmatter
 *  `status`. A label for planning and the readiness rollup, not proof of completion. */
export function writeMissionStatus(missionPath: string, status: string): ManifestEditOutcome {
  const manifestPath = path.join(missionPath, "mission.yaml");
  if (fs.existsSync(manifestPath)) {
    return editManifest(manifestPath, (doc) => {
      const node = doc.getIn(["metadata", "status"], true);
      if (isScalar(node)) node.value = status;
      else doc.setIn(["metadata", "status"], status);
    });
  }
  // Mutate the node file the mission actually has; only a mission with neither gets a new one, and a new one is
  // authored under the current name.
  const resolved = resolveNodeFile(missionPath);
  const nodePath = resolved ?? path.join(missionPath, "SPEC.md");
  const original = resolved ? fs.readFileSync(resolved, "utf-8") : "";
  let body = original;
  try {
    const frontmatter = legacyFrontmatter(original);
    const doc = frontmatter?.doc ?? parseDocument("");
    const style = { ...asAuthored(original), blockQuote: false as const };
    const before = doc.toString(style);
    // Keep the one-line quoting of the status writer, including document separators such as `---`.
    const statusNode = parseDocument(stringify(status, { lineWidth: 0, blockQuote: false })).contents;
    const node = doc.get("status", true);
    if (isScalar(node) && node.value === status) return "unchanged";
    if (isScalar(node) && isScalar(statusNode)) { node.value = status; node.type = statusNode.type; }
    else doc.set("status", statusNode);
    const after = doc.toString(style);
    if (frontmatter && after === before) return "unchanged";
    body = `---\n${after.trimEnd()}\n---${frontmatter ? original.slice(frontmatter.end) : `\n${original}`}`;
  } catch (err) {
    throw new ManifestEditError(nodePath, err instanceof Error ? err.message : String(err));
  }
  if (resolved && body === original) return "unchanged";
  writeAtomically(nodePath, body);
  return "written";
}

/** Parse only the YAML header; the Markdown body never goes through a YAML serializer. */
function legacyFrontmatter(text: string): { doc: Document; end: number } | null {
  const match = text.match(/^---\r?\n((?:[\s\S]*?\r?\n)?)---(?=\r?\n|$)/);
  if (!match) {
    if (/^---\r?\n/.test(text)) throw new Error("the YAML frontmatter has no closing delimiter");
    return null;
  }
  const doc = parseDocument(match[1]!);
  if (doc.errors.length) throw new Error(`it can't be parsed (${doc.errors[0]!.message})`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error("the YAML frontmatter is not a mapping");
  return { doc, end: match[0].length };
}

/** The top-level authored word, with YAML quoting, comments and nesting interpreted as the writer does. */
export function readLegacyMissionStatus(missionPath: string): string | null {
  const nodePath = resolveNodeFile(missionPath);
  if (!nodePath) return null;
  try {
    const value = legacyFrontmatter(fs.readFileSync(nodePath, "utf8"))?.doc.get("status");
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch { return null; }
}

/** The status a mission's readers now serve: `metadata.status` as project readiness reads it, else (a legacy mission)
 *  its node file's `status`, which is what `GET /api/missions/:missionId` returns. */
export function servedMissionStatus(missionPath: string): { status: string | null; countsTowardReadiness: boolean } {
  const fromManifest = readMissionReadiness(missionPath).historicalStatus;
  if (fromManifest !== null) return { status: fromManifest, countsTowardReadiness: ["active", "release-candidate"].includes(fromManifest) };
  return { status: readLegacyMissionStatus(missionPath), countsTowardReadiness: false };
}
