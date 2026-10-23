import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { getOpenRigHome } from "../openrig-compat.js";
import type { ReconcileSkillLoadoutResult, SkillLoadout, SkillLoadoutLocation, SkillRuntime } from "./skill-catalog.js";
import { parseSkillFrontmatter } from "./skill-discovery.js";
import { MANAGED_BLOCK_APPEND_SEPARATOR, hasEditedManagedBlock, managedBlockText } from "./managed-blocks.js";

// OPR.0.7.0.13 — where a team seat's skills live: storage OpenRig owns, outside the person's project and their own
// skill folders, so a person's own agent opened in the project sees none of the team's skills.
//
//   <openrig home>/state/seats/<rig id>/<logical seat>/<runtime>/
//     plugin/.claude-plugin/plugin.json   the generated plugin "openrig" (Claude shows its skills as openrig:<id>)
//     plugin/skills/<id>/                 the seat's complete skill trees, helpers included
//     skill-loadout.json                  the loadout OpenRig wrote here: each skill's source, files and their hashes
//     skill-projections.json              every other skill file OpenRig wrote here: its hash and its source
//
// The key is the rig and the logical seat, never a session name: a native resume, a restore, a handover successor and
// an in-place restart are the same seat and find the same storage, while a fork is a new seat in a new rig with its own.
// Two seats never share one manifest (a rig's logical seats are unique). Every launch path derives the pointer to this
// storage from the node record, so a path that doesn't re-project skills still hands the seat its storage.
//
// Adapted from #1008's claude-seat-material.ts (Adam Dmitruczuk): the generated plugin, its name and manifest, and the
// skills-under-the-plugin layout. That design keyed the directory by session name and also moved settings, MCP and
// guidance; this keeps skills only, keyed by seat.

/** The generated plugin's name. Claude Code shows its skills as `openrig:<id>`. */
export const SEAT_SKILL_PLUGIN_NAME = "openrig";

export interface SeatSkillKey {
  rigId: string;
  logicalId: string;
  runtime: string;
}

export interface SeatSkillPaths {
  root: string;
  pluginDir: string;
  pluginManifestPath: string;
  skillsRoot: string;
  manifestPath: string;
  projectionsPath: string;
  /** Codex: the seat's derived skill catalog, delivered to the seat through its per-seat startup text. */
  catalogPath: string;
}

const segment = (value: string): string => value.replace(/[^A-Za-z0-9@._-]/g, "_");

export function seatSkillPaths(key: SeatSkillKey, openrigHome: string = getOpenRigHome()): SeatSkillPaths {
  const root = nodePath.join(nodePath.resolve(openrigHome), "state", "seats", segment(key.rigId), segment(key.logicalId), segment(key.runtime));
  const pluginDir = nodePath.join(root, "plugin");
  return {
    root,
    pluginDir,
    pluginManifestPath: nodePath.join(pluginDir, ".claude-plugin", "plugin.json"),
    // Claude reads skills through the generated plugin; a Codex seat's trees sit beside its catalog (no plugin).
    skillsRoot: key.runtime === "codex" ? nodePath.join(root, "skills") : nodePath.join(pluginDir, "skills"),
    manifestPath: nodePath.join(root, "skill-loadout.json"),
    projectionsPath: nodePath.join(root, "skill-projections.json"),
    catalogPath: nodePath.join(root, "catalog.md"),
  };
}

/** The name Claude Code gives a skill delivered through the seat plugin. */
export function seatSkillName(skillId: string): string {
  return `${SEAT_SKILL_PLUGIN_NAME}:${skillId}`;
}

/** Where the skill loadout reconciler keeps this seat's skills, and the name each is recorded with. */
export function seatSkillLocation(paths: SeatSkillPaths, runtime: string = "claude-code"): SkillLoadoutLocation {
  // A Codex seat reads its skills by path from its catalog, so they keep their own names.
  return { targetRoot: paths.skillsRoot, manifestPath: paths.manifestPath, qualifiedName: runtime === "codex" ? (id) => id : seatSkillName,
    // The reconciler stages beside the skills folder and writes its manifest at the seat's root, both on the skills
    // folder's anchored path, so this one check covers every write and removal it makes there.
    refuseMutation: () => anchored(seatsAnchor(paths.root), paths.skillsRoot, "folder") && anchored(seatsAnchor(paths.root), paths.manifestPath, "file")
      ? undefined
      : `${paths.skillsRoot} is not inside this seat's storage (a link on the way from ${seatsAnchor(paths.root)}); the loadout changed nothing there` };
}

const PLUGIN_MANIFEST = `${JSON.stringify({
  name: SEAT_SKILL_PLUGIN_NAME,
  version: "0.0.0",
  description: "Skills OpenRig keeps for this seat only.",
}, null, 2)}\n`;

/**
 * Write the generated plugin's manifest, unless it's already there as written. A manifest that differs from the one
 * OpenRig generates is someone's edit: it is kept and named (returned), never overwritten.
 */
export function ensureSeatSkillPlugin(paths: SeatSkillPaths): string[] {
  const file = paths.pluginManifestPath;
  if (!insideSeatStorage(paths.root, file)) return [`seat_plugin_kept: ${file} is not inside this seat's storage (a link on the way); not written`];
  if (lexists(file)) {
    let current: string | undefined;
    try { current = fs.readFileSync(file, "utf8"); } catch {}
    return current === PLUGIN_MANIFEST ? [] : [`seat_plugin_kept: ${file} differs from the manifest OpenRig generates; kept as it is`];
  }
  writeInsideSeatStorage(paths.root, file, PLUGIN_MANIFEST);
  return [];
}

// --- Where OpenRig may write or remove in a seat's storage --------------------------------------------------------
// What these checks establish: just before cleanup or repair acts on a path, every component from the anchor down was
// a real folder (no link), and a file, if present, a regular file. The anchor is `<home>/state/seats`, the folder
// OpenRig makes for every seat; it is checked too. (The OpenRig home and its `state` folder above the anchor are the
// operator's layout, and may be links.) The check and the filesystem call are separate operations (Node has no
// openat), so a namespace entry replaced by another process between them is outside what is established here; that
// window hasn't been measured.

const lexists = (file: string): boolean => { try { fs.lstatSync(file); return true; } catch { return false; } };

/** `<home>/state/seats` for a seat root `<home>/state/seats/<rig>/<seat>/<runtime>`. */
const seatsAnchor = (root: string): string => nodePath.dirname(nodePath.dirname(nodePath.dirname(nodePath.resolve(root))));

/**
 * Whether `target` is the anchor or below it with no link anywhere from the anchor down, the anchor included. A missing
 * component ends the walk as contained (nothing below it exists to follow). `kind` is what the target must be if present.
 */
function anchored(anchor: string, target: string, kind: "file" | "folder"): boolean {
  const base = nodePath.resolve(anchor);
  const resolved = nodePath.resolve(target);
  const relative = nodePath.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) return false;
  const parts = relative === "" ? [] : relative.split(nodePath.sep);
  const chain = [base, ...parts.map((_, i) => nodePath.join(base, ...parts.slice(0, i + 1)))];
  for (let i = 0; i < chain.length; i++) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(chain[i]!); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
    if (stat.isSymbolicLink()) return false;
    const last = i === chain.length - 1;
    if (!last || kind === "folder" ? !stat.isDirectory() : !stat.isFile()) return false;
  }
  return true;
}

/** Whether folder `dir` is inside the seat storage at `root`, with no link on the way, itself included. */
export function insideSeatStorageFolder(root: string, dir: string): boolean {
  const seatRoot = nodePath.resolve(root);
  if (!nodePath.resolve(dir).startsWith(seatRoot + nodePath.sep)) return false;
  return anchored(seatsAnchor(seatRoot), dir, "folder");
}

/** Whether `file` is inside the seat storage at `root`, with no link on the way from the anchor all seats share. */
export function insideSeatStorage(root: string, file: string): boolean {
  const seatRoot = nodePath.resolve(root);
  if (!nodePath.resolve(file).startsWith(seatRoot + nodePath.sep)) return false;
  return anchored(seatsAnchor(seatRoot), file, "file");
}

/**
 * Write a file inside the seat's storage without following a link: folders are made one at a time, a new file is
 * created exclusively, and an existing one is replaced by a rename (which replaces the entry itself). Throws when the
 * path isn't inside the seat's storage.
 */
export function writeInsideSeatStorage(root: string, file: string, bytes: string | Buffer, mode?: number): void {
  if (!insideSeatStorage(root, file)) throw new Error(`${file} is not inside this seat's storage`);
  const base = seatsAnchor(root);
  fs.mkdirSync(base, { recursive: true }); // the folder every seat shares, in the OpenRig home
  if (!anchored(base, base, "folder")) throw new Error(`${base} is not a folder OpenRig can write seat storage in`);
  let current = base;
  for (const part of nodePath.relative(base, nodePath.dirname(nodePath.resolve(file))).split(nodePath.sep)) {
    current = nodePath.join(current, part);
    try { fs.mkdirSync(current); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    if (!fs.lstatSync(current).isDirectory()) throw new Error(`${current} is not a folder inside this seat's storage`);
  }
  const temp = `${file}.openrig-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, bytes, { flag: "wx", ...(mode !== undefined ? { mode } : {}) });
  try {
    if (mode !== undefined) fs.chmodSync(temp, mode);
    if (lexists(file)) fs.renameSync(temp, file);
    else fs.linkSync(temp, file); // fails rather than replace anything that appeared since the check
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

/** Remove a file inside the seat's storage, only while it's still there with no link on the way. */
function removeInsideSeatStorage(root: string, file: string): boolean {
  if (!insideSeatStorage(root, file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** The seat's root, from the skills root an adapter is handed: `<root>/plugin/skills` (Claude) or `<root>/skills`. */
export function seatRootOfSkills(skillsRoot: string): string {
  const parent = nodePath.dirname(nodePath.resolve(skillsRoot));
  return nodePath.basename(parent) === "plugin" ? nodePath.dirname(parent) : parent;
}

/**
 * After an adapter copied a skill into a seat's storage: true when every file went in. When any destination was
 * refused, the skill is reported incomplete (the caller lists it as skipped, not projected) and the files not delivered
 * are named; those files were neither written nor recorded, and whatever was at them is left as it was.
 */
export function seatProjectionComplete(id: string, notProjected: readonly string[], warnings: string[]): boolean {
  if (notProjected.length === 0) return true;
  warnings.push(`${id}: incomplete in this seat's storage: ${notProjected.length} file(s) not projected (${notProjected.join(", ")}); the skill is not fully delivered`);
  return false;
}

/** Whether an adapter may write this file into a seat's skills: only inside the seat's storage, with no link on the way. */
export function seatSkillWriteRefusal(skillsRoot: string, dest: string): string | undefined {
  return insideSeatStorage(seatRootOfSkills(skillsRoot), dest) ? undefined : `${dest} is not inside this seat's storage (a link on the way); not written`;
}

/**
 * A selected plugin's bundled skills, left out of the project's copy because a seat with storage gets them there: when
 * that storage is refused (`refusal`, the reason the seat's storage was refused), they reach neither, so the loss is named.
 */
export function seatPluginSkillsLossNote(pluginId: string, skippedFiles: number, refusal: string): string | undefined {
  if (skippedFiles === 0) return undefined;
  return `${pluginId}: plugin_skills_not_delivered: its bundled skills (${skippedFiles} file(s)) are not copied to the project, and this seat's skill storage is refused (${refusal}); the plugin's other files are copied as before`;
}

/**
 * The seat plugin to load into this node's Claude process, or undefined: not a Claude seat, or OpenRig has kept no
 * skills for it. Derived from the node record alone, so every launch and continuation path finds the same storage.
 */
export function seatSkillPluginDir(
  node: { rig_id: string; logical_id: string; runtime: string | null },
  openrigHome?: string,
): string | undefined {
  if (node.runtime !== "claude-code") return undefined;
  const paths = seatSkillPaths({ rigId: node.rig_id, logicalId: node.logical_id, runtime: node.runtime }, openrigHome);
  return fs.existsSync(paths.pluginManifestPath) ? paths.pluginDir : undefined;
}

/** The seat plugin for a node, read from its record: what every launch and continuation path calls. Seat storage is
 *  always under the OpenRig home, so launch, teardown and restore all find the same place. */
export function seatSkillPluginDirForNode(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  nodeId: string,
): string | undefined {
  try {
    const row = db.prepare("SELECT rig_id, logical_id, runtime FROM nodes WHERE id = ?").get(nodeId) as
      { rig_id: string; logical_id: string; runtime: string | null } | undefined;
    return row ? seatSkillPluginDir(row) : undefined;
  } catch {
    return undefined;
  }
}

export interface SeatSkillRehydration {
  /** Files that were missing and were put back from their recorded source, with its mode. */
  restored: string[];
  /** Files that differ from what OpenRig recorded writing: kept as they are. */
  kept: string[];
  /** Files that are missing and whose recorded source is gone or has changed: named, not substituted. */
  missing: string[];
  /** Recorded files no longer inside the seat's storage (a link on the way): nothing written there. */
  refused: string[];
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Put back the seat's selected skills from what its manifest recorded, before a restore relaunches it. The saved
 * selection is kept (nothing is re-resolved). A missing file comes back only from its recorded source, and only when
 * that source still has the recorded bytes. A file that differs from the record is someone's edit: it is kept. Anything
 * that can't be put back is named. Nothing is replayed into a conversation; this only repairs the seat's storage.
 */
export function rehydrateSeatSkills(paths: SeatSkillPaths): SeatSkillRehydration {
  const out: SeatSkillRehydration = { restored: [], kept: [], missing: [], refused: [] };
  for (const [file, entry] of recordedSeatSkillFiles(paths)) {
    if (!insideSeatStorage(paths.root, file)) { out.refused.push(file); continue; }
    if (lexists(file)) {
      try { if (sha256(fs.readFileSync(file)) !== entry.sha256) out.kept.push(file); } catch { out.kept.push(file); }
      continue;
    }
    let bytes: Buffer;
    let mode: number;
    try {
      bytes = fs.readFileSync(entry.source);
      mode = fs.statSync(entry.source).mode & 0o777;
    } catch { out.missing.push(file); continue; }
    if (sha256(bytes) !== entry.sha256) { out.missing.push(file); continue; }
    try {
      // The recorded source still has the recorded bytes, so its mode (a helper's executable bit) comes back too.
      writeInsideSeatStorage(paths.root, file, bytes, mode);
      out.restored.push(file);
    } catch {
      out.refused.push(file);
    }
  }
  return out;
}

/** The storage of a seat that uses it (a Claude seat with its plugin, a Codex seat with its catalog), from its node
 *  record, or undefined (no storage: the project, as before). */
export function seatSkillPathsForNode(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  nodeId: string,
): SeatSkillPaths | undefined {
  try {
    const row = db.prepare("SELECT rig_id, logical_id, runtime FROM nodes WHERE id = ?").get(nodeId) as
      { rig_id: string; logical_id: string; runtime: string | null } | undefined;
    if (!row || (row.runtime !== "claude-code" && row.runtime !== "codex")) return undefined;
    const paths = seatSkillPaths({ rigId: row.rig_id, logicalId: row.logical_id, runtime: row.runtime });
    // A Claude seat uses its storage once its plugin exists; a Codex seat once its catalog does.
    return fs.existsSync(row.runtime === "codex" ? paths.catalogPath : paths.pluginManifestPath) ? paths : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A Claude or Codex seat whose storage was refused by a link: its plugin manifest (Claude) or catalog (Codex) is missing
 * because a link on the way out of its storage refused it, or (Codex) its projection record is a link, which the catalog
 * writer refuses too. Gives the skills root its skills were meant for and the reason, so each is refused there and named
 * rather than written into the project or where nothing reads it. Undefined for a seat whose storage is found the
 * ordinary way, and for one with no storage and no link (one that never had it), which keeps the project, as before.
 */
export function refusedSeatSkillsRootForNode(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  nodeId: string,
): { skillsRoot: string; reason: string } | undefined {
  try {
    const row = db.prepare("SELECT rig_id, logical_id, runtime FROM nodes WHERE id = ?").get(nodeId) as
      { rig_id: string; logical_id: string; runtime: string | null } | undefined;
    if (!row || (row.runtime !== "claude-code" && row.runtime !== "codex")) return undefined;
    const paths = seatSkillPaths({ rigId: row.rig_id, logicalId: row.logical_id, runtime: row.runtime });
    const marker = row.runtime === "codex" ? paths.catalogPath : paths.pluginManifestPath;
    if (fs.existsSync(marker)) return undefined; // the storage is found the ordinary way
    // The same paths the writers refuse: the Claude manifest; the Codex catalog and its projection record.
    const checked = row.runtime === "codex" ? [paths.catalogPath, paths.projectionsPath] : [paths.pluginManifestPath];
    const linked = checked.find((file) => !insideSeatStorage(paths.root, file));
    return linked
      ? { skillsRoot: paths.skillsRoot, reason: `${linked} is not inside this seat's storage (a link on the way); this seat's skills are not written` }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a seat's copy of a skill differs from its source (a file, or a whole skill folder compared file by file). */
export function seatSkillDiffers(source: string, target: string): boolean {
  const files = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.set(nodePath.relative(root, full), sha256(fs.readFileSync(full)));
      }
    };
    walk(root);
    return out;
  };
  try {
    if (!fs.statSync(source).isDirectory()) {
      const copy = nodePath.join(target, nodePath.basename(source));
      return !fs.existsSync(copy) || sha256(fs.readFileSync(copy)) !== sha256(fs.readFileSync(source));
    }
    const a = files(source);
    const b = files(target);
    return a.size !== b.size || [...a].some(([path, hash]) => b.get(path) !== hash);
  } catch {
    return true;
  }
}

/** Every Claude seat's skill folder under this OpenRig home, for the skills audit. They are seat output, never a source. */
export function listSeatSkillRoots(openrigHome: string = getOpenRigHome()): string[] {
  const seats = nodePath.join(nodePath.resolve(openrigHome), "state", "seats");
  const dirs = (dir: string): string[] => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  };
  return dirs(seats).flatMap((rig) => dirs(nodePath.join(seats, rig)).map((seat) => nodePath.join(seats, rig, seat, "claude-code", "plugin", "skills")))
    .filter((root) => fs.existsSync(root));
}

/**
 * For a fresh relaunch of a Claude seat with storage: which replayed skill entries to leave alone. A skill already in
 * the seat's storage is kept as it is (if it differs from its source, that is someone's edit, and it is named); only a
 * missing one is projected again from its saved source.
 */
export function seatSkillsToKeep(
  entries: ReadonlyArray<{ category: string; effectiveId: string; absolutePath: string }>,
  paths: SeatSkillPaths,
): { keep: Set<string>; warnings: string[] } {
  const keep = new Set<string>();
  const warnings: string[] = [];
  for (const entry of entries) {
    if (entry.category !== "skill") continue;
    const target = nodePath.join(paths.skillsRoot, entry.effectiveId);
    if (!fs.existsSync(target)) continue;
    if (seatSkillDiffers(entry.absolutePath, target)) {
      warnings.push(`Restore: kept ${target}: it differs from its source ${entry.absolutePath} (an edit is never overwritten)`);
    }
    keep.add(entry.effectiveId);
  }
  return { keep, warnings };
}

/**
 * For a fresh relaunch's replay, after rehydration: which saved skill entries and startup skill files not to write
 * again. A skill already in the seat's storage is left as it is (an edit is named), and so is a startup skill file whose
 * target is there. A missing file whose recorded source is gone or has changed is not put back by projection or install
 * either: that would substitute today's bytes for the saved selection. Everything else is projected or installed.
 */
export function seatSkillReplay(input: {
  entries: ReadonlyArray<{ category: string; effectiveId: string; absolutePath: string }>;
  files: ReadonlyArray<{ path: string; absolutePath: string; deliveryHint: string }>;
  paths: SeatSkillPaths;
  rehydration: Pick<SeatSkillRehydration, "missing" | "refused">;
  readFile?: (path: string) => string;
}): { skipEntryIds: Set<string>; skipFiles: Set<string>; warnings: string[] } {
  const { paths } = input;
  const notPutBack = [...input.rehydration.missing, ...input.rehydration.refused].map((f) => nodePath.resolve(f));
  const blocked = (target: string) => notPutBack.some((f) => f === target || f.startsWith(target + nodePath.sep));
  const kept = seatSkillsToKeep(input.entries, paths);
  const skipEntryIds = new Set(kept.keep);
  const warnings = [...kept.warnings];
  for (const entry of input.entries) {
    if (entry.category !== "skill" || skipEntryIds.has(entry.effectiveId)) continue;
    const target = nodePath.resolve(paths.skillsRoot, entry.effectiveId);
    if (blocked(target)) {
      skipEntryIds.add(entry.effectiveId);
      warnings.push(`Restore: ${target} not projected again: its recorded source is gone or has changed`);
    }
  }
  const skipFiles = new Set<string>();
  const read = input.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  for (const file of input.files) {
    let hint = file.deliveryHint;
    if (hint === "auto") { try { hint = file.path.endsWith("SKILL.md") || read(file.absolutePath).startsWith("# SKILL") ? "skill_install" : "other"; } catch { hint = "other"; } }
    if (hint !== "skill_install") continue;
    // The adapters' skill_install target: <skills root>/<the source's folder name>/<file name>.
    const target = nodePath.resolve(paths.skillsRoot, nodePath.basename(nodePath.dirname(file.absolutePath)), nodePath.basename(file.path));
    if (lexists(target)) {
      skipFiles.add(file.absolutePath);
      let differs = true;
      try { differs = !fs.readFileSync(target).equals(fs.readFileSync(file.absolutePath)); } catch {}
      if (differs) warnings.push(`Restore: kept ${target}: it differs from its source ${file.absolutePath} (an edit is never overwritten)`);
    } else if (blocked(target)) {
      skipFiles.add(file.absolutePath);
      warnings.push(`Restore: ${target} not installed again: its recorded source is gone or has changed`);
    }
  }
  return { skipEntryIds, skipFiles, warnings };
}

interface ProjectionRecord {
  files: Record<string, { sha256: string; source: string }>;
  /** What OpenRig last wrote as the seat's generated files (the Codex catalog), so an edit there is told apart. */
  generated?: Record<string, string>;
}

const readProjections = (path: string): ProjectionRecord => {
  try {
    const value = JSON.parse(fs.readFileSync(path, "utf8")) as ProjectionRecord;
    return value && typeof value.files === "object" && value.files ? value : { files: {} };
  } catch { return { files: {} }; }
};

function writeProjections(root: string, record: ProjectionRecord): void {
  writeInsideSeatStorage(root, nodePath.join(root, "skill-projections.json"),
    `${JSON.stringify({ schema: "openrig.seat-skill-projections/v1", files: record.files, ...(record.generated ? { generated: record.generated } : {}) }, null, 2)}\n`);
}

/** Record a skill file the Claude adapter wrote (or found already identical) in a seat's storage, so cleanup can tell
 *  it from an edit and a restore can put it back. `skillsRoot` is the binding's `seatSkillsRoot`. */
export function recordSeatSkillWrite(skillsRoot: string, dest: string, source: string, bytes: string | Buffer): void {
  // `<root>/plugin/skills` (Claude) or `<root>/skills` (Codex): the record sits at the seat's root.
  const root = seatRootOfSkills(skillsRoot);
  const record = readProjections(nodePath.join(root, "skill-projections.json"));
  record.files[nodePath.resolve(dest)] = { sha256: sha256(Buffer.from(bytes)), source: nodePath.resolve(source) };
  writeProjections(root, record);
}

/** OPR.0.7.0.9: the seat's launch additions' locations, beside its skills: `additions/` (the prompt file and plugin
 *  folders) and, for Claude, its generated plugin's `agents/`. The same record, restore and cleanup route covers them. */
export function seatAdditionLocations(paths: SeatSkillPaths): string[] {
  return [nodePath.join(paths.root, "additions"), ...(paths.skillsRoot === nodePath.join(paths.pluginDir, "skills") ? [nodePath.join(paths.pluginDir, "agents")] : [])];
}

/** Every file OpenRig recorded writing into this seat's skills or launch additions: its recorded hash and source. */
function recordedSeatSkillFiles(paths: SeatSkillPaths): Map<string, { sha256: string; source: string }> {
  const out = new Map<string, { sha256: string; source: string }>();
  const roots = [paths.skillsRoot, ...seatAdditionLocations(paths)].map((dir) => nodePath.resolve(dir) + nodePath.sep);
  const inside = (file: string) => roots.some((root) => file.startsWith(root));
  try {
    const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")) as { skills?: unknown };
    for (const skill of Array.isArray(manifest.skills) ? manifest.skills as Array<Record<string, unknown>> : []) {
      if (typeof skill["target"] !== "string" || typeof skill["sourceDir"] !== "string" || !skill["files"] || typeof skill["files"] !== "object") continue;
      const target = nodePath.resolve(skill["target"]);
      for (const [relative, digest] of Object.entries(skill["files"] as Record<string, unknown>)) {
        const file = nodePath.resolve(target, relative);
        if (typeof digest === "string" && inside(file)) out.set(file, { sha256: digest, source: nodePath.resolve(skill["sourceDir"], relative) });
      }
    }
  } catch {}
  for (const [file, entry] of Object.entries(readProjections(paths.projectionsPath).files)) {
    if (entry && typeof entry.sha256 === "string" && typeof entry.source === "string" && inside(nodePath.resolve(file))) out.set(nodePath.resolve(file), entry);
  }
  return out;
}

/** Whether OpenRig has a record of writing this seat's skills (so a restore can rebuild its storage). */
export function hasSeatSkillRecords(paths: SeatSkillPaths): boolean {
  return fs.existsSync(paths.manifestPath) || fs.existsSync(paths.projectionsPath);
}

export interface SeatSkillCleanup {
  /** Files OpenRig wrote and that were still exactly as written: removed. */
  removed: string[];
  /** Files edited since OpenRig wrote them, or never recorded as OpenRig's (generated ones included): kept. */
  kept: string[];
  /** Recorded files no longer inside the seat's storage (a link on the way): left alone. */
  refused: string[];
}

/**
 * Remove what OpenRig wrote into a seat's skills once the seat's consumers have stopped: only recorded files whose
 * bytes still match the record, and the generated plugin's manifest, so nothing points at the storage. Edited and
 * unrecorded files are kept and reported. The records themselves stay, unless `dropRecords` (the rig is deleted), so a
 * later restore can rebuild the seat's skills from their sources.
 */
export function cleanSeatSkills(paths: SeatSkillPaths, opts: { dropRecords?: boolean } = {}): SeatSkillCleanup {
  const out: SeatSkillCleanup = { removed: [], kept: [], refused: [] };
  if (!lexists(paths.root)) return out;
  // Every file this cleanup removes; only the folders on their paths may be removed afterwards.
  const removedFiles: string[] = [];
  for (const [file, entry] of recordedSeatSkillFiles(paths)) {
    if (!lexists(file)) continue;
    if (!insideSeatStorage(paths.root, file)) { out.refused.push(file); continue; }
    try {
      if (sha256(fs.readFileSync(file)) === entry.sha256 && removeInsideSeatStorage(paths.root, file)) { out.removed.push(file); removedFiles.push(file); }
      else out.kept.push(file);
    } catch { out.kept.push(file); }
  }
  const leftovers = (dir: string): string[] => {
    let found: string[] = [];
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, e.name);
        if (e.isDirectory()) found = found.concat(leftovers(full));
        else found.push(full);
      }
    } catch {}
    return found;
  };
  // The generated router, like the catalog below: removed only while it is exactly what OpenRig recorded writing.
  const router = nodePath.join(paths.skillsRoot, SEAT_SKILL_ROUTER_ID, "SKILL.md");
  if (lexists(router)) {
    const recorded = readProjections(paths.projectionsPath).generated?.[router];
    try {
      if (insideSeatStorage(paths.root, router) && recorded === sha256(fs.readFileSync(router)) && removeInsideSeatStorage(paths.root, router)) removedFiles.push(router);
    } catch {}
  }
  for (const dir of [paths.skillsRoot, ...seatAdditionLocations(paths)]) {
    // A linked location is refused above, file by file; nothing is walked through it.
    if (dir !== paths.skillsRoot && lexists(dir) && !anchored(seatsAnchor(paths.root), dir, "folder")) continue;
    for (const file of leftovers(dir)) if (!out.kept.includes(file) && !out.refused.includes(file)) out.kept.push(file);
  }
  // Nothing points at the storage any more: no Claude plugin, no Codex catalog (both are rebuilt on a restore). Each is
  // removed only while it is exactly what OpenRig wrote: the plugin manifest is a constant, and the catalog's digest
  // is recorded when OpenRig writes it. A differing or unrecorded one is someone's: kept and named.
  const generated = readProjections(paths.projectionsPath).generated ?? {};
  const owned = (file: string, expected: (bytes: Buffer) => boolean) => {
    if (!lexists(file)) return;
    try {
      if (insideSeatStorage(paths.root, file) && expected(fs.readFileSync(file)) && removeInsideSeatStorage(paths.root, file)) { removedFiles.push(file); return; }
    } catch {}
    out.kept.push(file);
  };
  owned(paths.pluginManifestPath, (bytes) => bytes.toString("utf8") === PLUGIN_MANIFEST);
  owned(paths.catalogPath, (bytes) => generated[paths.catalogPath] === sha256(bytes));
  if (opts.dropRecords && out.kept.length === 0 && out.refused.length === 0) {
    for (const record of [paths.manifestPath, paths.projectionsPath, nodePath.join(paths.root, "launch-additions.json")]) {
      try { if (removeInsideSeatStorage(paths.root, record)) removedFiles.push(record); } catch {}
    }
  }
  // Remove only the folders this cleanup emptied: those on the path of a file it removed, from the deepest up to the
  // rig's folder, each while it is still an empty real folder under the anchor. An empty folder OpenRig never wrote a
  // file into is not recorded ownership, so it stays; nothing is walked through a refused (linked) path.
  const anchor = seatsAnchor(paths.root);
  const emptied = new Set<string>();
  for (const file of removedFiles) {
    for (let dir = nodePath.dirname(nodePath.resolve(file)); dir.startsWith(anchor + nodePath.sep); dir = nodePath.dirname(dir)) emptied.add(dir);
  }
  for (const dir of [...emptied].sort((a, b) => b.split(nodePath.sep).length - a.split(nodePath.sep).length)) {
    try { if (anchored(anchor, dir, "folder") && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
  }
  out.kept.sort();
  out.refused.sort();
  return out;
}

/**
 * Copies a Claude seat's earlier launches put in the project, once the seat uses its own storage. They go only when the
 * project's loadout record names this seat as the sole owner and they are unchanged: that is the reconciler's own rule
 * for a skill no seat selects any more, run with this seat's selection emptied. A skill the person installed for the
 * project stays selected. While another seat still shares the copies, nothing is removed. Returns launch notes.
 */
export function migrateLegacyProjectSkills(input: {
  reconcile: (input: { loadout: SkillLoadout; runtime: SkillRuntime; cwd: string; apply: true; topologyOwner?: string }) => ReconcileSkillLoadoutResult;
  loadout: SkillLoadout;
  cwd: string;
  owner: string;
}): string[] {
  let owners: string[];
  try {
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(input.cwd, ".openrig", "skill-loadouts", "claude-code.json"), "utf8")) as { topologySelections?: Record<string, unknown> };
    owners = Object.keys(manifest.topologySelections ?? {});
  } catch {
    return [];
  }
  if (owners.length === 0) return [];
  const others = owners.filter((owner) => owner !== input.owner);
  if (others.length > 0) return [`legacy_project_skills_kept: other seats still share the project's copies (${others.join(", ")})`];
  const migrated = input.reconcile({
    loadout: { ...input.loadout, projectSelectionDeclared: false, projectSelection: [], entries: [], skipped: [] },
    runtime: "claude-code", cwd: input.cwd, apply: true, topologyOwner: input.owner,
  });
  if (!migrated.ok) return [`legacy_project_skills_kept: ${migrated.errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`];
  return migrated.removed.length > 0 ? [`legacy_project_skills_removed: ${migrated.removed.join(", ")} (now in this seat's own storage)`] : [];
}

export interface SeatSkillCatalog {
  path: string;
  /** A digest of the catalog's text, so a later apply can tell what the seat received from what is on disk now. */
  digest: string;
  count: number;
  /** Nothing was written: the file there differs from what OpenRig last wrote, or OpenRig never recorded writing it
   *  (`edited`), or the catalog's path isn't inside the seat's storage (`linked`, a link on the way). */
  kept?: boolean;
  reason?: "edited" | "linked";
}

/** The launch or restore warning for a catalog that wasn't written, naming why. */
export function seatCatalogKeptNote(catalog: SeatSkillCatalog): string {
  return catalog.reason === "linked"
    ? `seat_catalog_refused: ${catalog.path} is not inside this seat's storage (a link on the way); nothing was written there`
    : `seat_catalog_kept: ${catalog.path} differs from what OpenRig last wrote; kept as it is`;
}

/**
 * OPR.0.7.0.13 (Codex C2): write the seat's skill catalog from what is in its own storage: each skill's original
 * description (its trigger) and the exact SKILL.md to read, never the skill bodies. It is delivered to the seat through
 * its per-seat startup text, so it says plainly that it replaces any earlier list (a fork child carries its parent's).
 */
export function writeSeatSkillCatalog(paths: SeatSkillPaths): SeatSkillCatalog {
  const lines: string[] = [];
  let ids: string[] = [];
  // The generated router isn't one of the seat's skills; anything else under its reserved name (a team skill named so,
  // or an edited router) is listed like any skill, never hidden.
  const routerGenerated = resolveSeatSkillRouter(paths).written;
  try { ids = fs.readdirSync(paths.skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !(e.name === SEAT_SKILL_ROUTER_ID && routerGenerated)).map((e) => e.name).sort(); } catch {}
  for (const id of ids) {
    const file = nodePath.join(paths.skillsRoot, id, "SKILL.md");
    let parsed: ReturnType<typeof parseSkillFrontmatter> | undefined;
    try { parsed = parseSkillFrontmatter(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!parsed.ok) continue;
    const description = String(parsed.frontmatter.description).replace(/\s+/g, " ").trim();
    lines.push(`- **${parsed.frontmatter.name}**: ${description}`, `  Read before you use it: \`${file}\``);
  }
  const text = [
    "OpenRig: this seat's skills. This list replaces any earlier OpenRig skill list in this conversation.",
    "",
    lines.length > 0
      ? "Each skill says when to use it. When that moment comes, read its SKILL.md, then follow it."
      : "No OpenRig skills are kept for this seat.",
    "",
    ...lines,
    "",
  ].join("\n");
  const digest = sha256(Buffer.from(text));
  const count = lines.length / 2;
  // A linked catalog or record path anywhere from the anchor down: neither is read or written through it, and the reason
  // is named. (The skills folder listed above is read where it is, link or not; this guards the two files written here.)
  if (!insideSeatStorage(paths.root, paths.catalogPath) || !insideSeatStorage(paths.root, paths.projectionsPath)) {
    return { path: paths.catalogPath, digest, count, kept: true, reason: "linked" };
  }
  const record = readProjections(paths.projectionsPath);
  if (lexists(paths.catalogPath)) {
    let current: Buffer | undefined;
    try { if (insideSeatStorage(paths.root, paths.catalogPath)) current = fs.readFileSync(paths.catalogPath); } catch {}
    const ours = current !== undefined && (sha256(current) === digest || record.generated?.[paths.catalogPath] === sha256(current));
    if (!ours) return { path: paths.catalogPath, digest: current ? sha256(current) : digest, count, kept: true, reason: "edited" };
  }
  writeInsideSeatStorage(paths.root, paths.catalogPath, text);
  writeProjections(paths.root, { ...record, generated: { ...record.generated, [paths.catalogPath]: digest } });
  return { path: paths.catalogPath, digest, count };
}

/** The startup file, and the managed block id, that carry the bootstrap line into a seat's guidance file. */
export const SEAT_SKILLS_BOOTSTRAP_BLOCK_ID = "openrig-seat-skills.md";

/** OPR.0.7.0.13 (router, R1.1): the one constant bootstrap line, verbatim. The guidance asset carries exactly this text. */
export const SEAT_SKILLS_BOOTSTRAP_LINE = "OpenRig seat skills: if `OPENRIG_SESSION_NAME` is set, run `rig skill loadout --seat self` and use the router skill it names; if it isn't set, this line doesn't apply to you.";

/** Whether guidance text holds the seat-skills block with anything but the line: a person edited it. A start leaves such a
 *  block as it is, and down keeps it (both by `managedBlockBodyMatches`). */
export function seatSkillsLineEdited(content: string): boolean {
  return hasEditedManagedBlock(content, SEAT_SKILLS_BOOTSTRAP_BLOCK_ID, SEAT_SKILLS_BOOTSTRAP_LINE);
}

export interface FootprintSeat { seat: string; runtime: string; cwd: string; claudeManagedBlockFile?: string | null }
export interface SkillRouterFootprint {
  line: string;
  /** The exact text written: the line between OpenRig's markers, which let it be removed cleanly. */
  written: string;
  /** Where `written` goes in the file, and what's put before it. */
  placement: string;
  /** The exact bytes added to a file that already has text: `written` after the separator. */
  appended: string;
  files: Array<{ path: string; runtime: "claude-code" | "codex"; seats: string[] }>;
  notCovered: Array<{ seat: string; runtime: string; reason: string }>;
  ifNo: string;
}

/**
 * Slice 20 seam: the exact preview of the bootstrap line's footprint, before any write: the line verbatim, the exact text
 * written (the line between OpenRig's markers) and where it goes, and each file
 * it would go into (a Claude seat's rig file, `CLAUDE.md` or `CLAUDE.local.md`; a Codex seat's `AGENTS.md`), one entry
 * per file with every seat sharing it. Pure: no filesystem or settings read. The file rule is main's
 * `seatGuidanceFile` (restore-guidance.ts), repeated here until this branch carries it.
 */
export function describeSkillRouterFootprint(seats: FootprintSeat[]): SkillRouterFootprint {
  const byPath = new Map<string, { path: string; runtime: "claude-code" | "codex"; seats: string[] }>();
  const notCovered: SkillRouterFootprint["notCovered"] = [];
  for (const s of seats) {
    const name = s.runtime === "claude-code" ? (s.claudeManagedBlockFile ?? "CLAUDE.md") : s.runtime === "codex" ? "AGENTS.md" : null;
    if (!name) { notCovered.push({ seat: s.seat, runtime: s.runtime, reason: "this runtime has no managed guidance file for the line" }); continue; }
    const path = nodePath.join(s.cwd, name);
    const entry = byPath.get(path) ?? { path, runtime: s.runtime as "claude-code" | "codex", seats: [] };
    entry.seats.push(s.seat);
    byPath.set(path, entry);
  }
  // The guidance asset carries the line and a newline; the managed-block writer puts its markers around that.
  const written = managedBlockText(SEAT_SKILLS_BOOTSTRAP_BLOCK_ID, `${SEAT_SKILLS_BOOTSTRAP_LINE}\n`);
  return {
    line: SEAT_SKILLS_BOOTSTRAP_LINE,
    written,
    placement: "Added at the end of the file after two newlines. A file that doesn't exist yet holds only this, and a file that already has it gets it replaced in place.",
    appended: `${MANAGED_BLOCK_APPEND_SEPARATOR}${written}`,
    files: [...byPath.values()],
    notCovered,
    ifNo: "Nothing is written into these files. Each seat still has its own skills and router; a Codex seat still gets its skill list in its startup text, and any agent can run `rig skill loadout --seat self`, but nothing in the project points there.",
  };
}

/** OPR.0.7.0.13 (router): the id of the one router skill OpenRig generates for each seat. */
export const SEAT_SKILL_ROUTER_ID = "openrig-seat-router";

export interface SeatSkillRouter {
  id: string;
  path: string;
  /** The router file is there as OpenRig last wrote it. */
  written: boolean;
  /** Why it isn't: a file there that OpenRig didn't write or that was edited since (`edited`, kept as it is), or a
   *  link on the way into the seat's storage (`linked`, nothing read or written through it). Absent when it's written
   *  or simply not there yet. */
  kept?: "edited" | "linked";
}

/** The router's place in the seat's own storage, and whether it is there as OpenRig wrote it. Reads only. */
export function resolveSeatSkillRouter(paths: SeatSkillPaths): SeatSkillRouter {
  const file = nodePath.join(paths.skillsRoot, SEAT_SKILL_ROUTER_ID, "SKILL.md");
  if (!insideSeatStorage(paths.root, file) || !insideSeatStorage(paths.root, paths.projectionsPath)) {
    return { id: SEAT_SKILL_ROUTER_ID, path: file, written: false, kept: "linked" };
  }
  if (!lexists(file)) return { id: SEAT_SKILL_ROUTER_ID, path: file, written: false };
  let written = false;
  try { written = readProjections(paths.projectionsPath).generated?.[file] === sha256(fs.readFileSync(file)); } catch {}
  return { id: SEAT_SKILL_ROUTER_ID, path: file, written, ...(written ? {} : { kept: "edited" as const }) };
}

/**
 * OPR.0.7.0.13 (router, R1.1): write the one router skill OpenRig generates for this seat, in the seat's own storage,
 * with every other skill's trigger and the exact SKILL.md to read in its body. It is a skill like the others (for Claude,
 * `openrig:openrig-seat-router` through the seat plugin), so it is never listed in the Codex catalog, which stays as it
 * was. A router edited since OpenRig wrote it, or on a linked path, is kept and named, never overwritten.
 */
export function writeSeatSkillRouter(paths: SeatSkillPaths): SeatSkillRouter {
  const router = resolveSeatSkillRouter(paths);
  // A link on the way: nothing is read through it, and nothing written.
  if (router.kept === "linked") return { id: router.id, path: router.path, written: false, kept: "linked" };
  const lines: string[] = [];
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(paths.skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== SEAT_SKILL_ROUTER_ID).map((e) => e.name).sort();
  } catch {}
  for (const id of ids) {
    const file = nodePath.join(paths.skillsRoot, id, "SKILL.md");
    let parsed: ReturnType<typeof parseSkillFrontmatter> | undefined;
    try { parsed = parseSkillFrontmatter(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!parsed.ok) continue;
    const description = String(parsed.frontmatter.description).replace(/\s+/g, " ").trim();
    lines.push(`- **${parsed.frontmatter.name}**: ${description}`, `  Read before you use it: \`${file}\``);
  }
  const text = [
    "---",
    `name: ${SEAT_SKILL_ROUTER_ID}`,
    "description: Use first whenever you might need one of this OpenRig seat's own skills. It lists each skill, when to use it, and the exact file to read.",
    "---",
    "",
    "# This seat's OpenRig skills",
    "",
    lines.length > 0
      ? "Each skill says when to use it. When that moment comes, read its SKILL.md, then follow it."
      : "No other OpenRig skills are kept for this seat.",
    "",
    ...lines,
    "",
  ].join("\n");
  const digest = sha256(Buffer.from(text));
  if (!insideSeatStorage(paths.root, router.path) || !insideSeatStorage(paths.root, paths.projectionsPath)) {
    return { ...router, written: false, kept: "linked" };
  }
  const record = readProjections(paths.projectionsPath);
  if (lexists(router.path)) {
    let current: Buffer | undefined;
    try { current = fs.readFileSync(router.path); } catch {}
    const ours = current !== undefined && (sha256(current) === digest || record.generated?.[router.path] === sha256(current));
    if (!ours) return { ...router, written: false, kept: "edited" };
  }
  writeInsideSeatStorage(paths.root, router.path, text);
  writeProjections(paths.root, { ...record, generated: { ...record.generated, [router.path]: digest } });
  return { id: router.id, path: router.path, written: true };
}

/** The launch or restore warning for a router that wasn't written, naming why. */
export function seatRouterKeptNote(router: { path: string; kept?: "edited" | "linked" }): string {
  return router.kept === "linked"
    ? `seat_router_refused: ${router.path} is not inside this seat's storage (a link on the way); nothing was written there`
    : `seat_router_kept: ${router.path} differs from what OpenRig last wrote; kept as it is`;
}

/** Claude Code reads a seat's plugin from CLAUDE_CODE_PLUGIN_DIRS from v2.1.280; OpenRig doesn't check the version. */
export const TEAM_SKILLS_VERSION_NOTE = "team_skills_need_claude_2.1.280: this seat's skills reach Claude Code through CLAUDE_CODE_PLUGIN_DIRS, which Claude Code reads from v2.1.280; OpenRig doesn't check the version, and an older Claude starts without them";

/**
 * The version limit, named for a Claude seat with its own storage whenever any writer puts a skill there: its loadout,
 * a profile skill, or a startup skill file. A seat with no skills gets no note.
 */
export function claudeSeatSkillsNote(input: {
  loadoutReceipts: number;
  planEntries: ReadonlyArray<{ category: string }>;
  startupFiles: ReadonlyArray<{ path: string; deliveryHint: string }>;
}): string | undefined {
  const writesSkills = input.loadoutReceipts > 0
    || input.planEntries.some((e) => e.category === "skill")
    || input.startupFiles.some((f) => f.deliveryHint === "skill_install" || (f.deliveryHint === "auto" && f.path.endsWith("SKILL.md")));
  return writesSkills ? TEAM_SKILLS_VERSION_NOTE : undefined;
}
