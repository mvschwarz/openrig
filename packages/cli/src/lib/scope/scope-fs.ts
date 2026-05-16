// release-0.3.2 slice 12 — filesystem + git helpers shared across
// `rig scope` verbs. Mission/slice discovery, frontmatter parse/write,
// auto-numbering, git mv wrapper. Keeps slice/mission command files
// thin.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type {
  MissionInfo,
  SliceInfo,
  SliceState,
} from "./types.js";
import { ScopeCliError } from "./types.js";
import {
  DEFAULT_PROJECT_PREFIX,
  inferMissionDotId,
  nextEscapeBandOrdinal,
} from "./dot-id.js";

const FRONTMATTER_DELIM = "---\n";
const SLICE_DIRNAME_RE = /^(\d+)-(.+)$/;

// ---------------------------------------------------------------------
// Frontmatter parse + write
// ---------------------------------------------------------------------

/** Split a markdown file into [frontmatter, body]. Returns `[{}, content]`
 *  when no frontmatter delimiter is present. */
export function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith(FRONTMATTER_DELIM)) {
    return { frontmatter: {}, body: content };
  }
  const rest = content.slice(FRONTMATTER_DELIM.length);
  const endIdx = rest.indexOf(`\n${FRONTMATTER_DELIM.trim()}\n`);
  if (endIdx === -1) {
    // Allow trailing `---` without a final newline (last char of file).
    const endIdx2 = rest.indexOf(`\n---`);
    if (endIdx2 === -1) return { frontmatter: {}, body: content };
    const raw = rest.slice(0, endIdx2);
    return { frontmatter: parseYamlSafely(raw), body: rest.slice(endIdx2 + 4).replace(/^\n/, "") };
  }
  const raw = rest.slice(0, endIdx);
  const body = rest.slice(endIdx + `\n${FRONTMATTER_DELIM.trim()}\n`.length);
  return { frontmatter: parseYamlSafely(raw), body };
}

function parseYamlSafely(raw: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Re-stitch frontmatter + body into a single markdown string. */
export function joinFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trim();
  const trailing = body.startsWith("\n") ? "" : "\n";
  return `---\n${yaml}\n---\n${trailing}${body}`;
}

/** Read + parse frontmatter from a markdown file. Returns `{}` if the
 *  file is missing OR has no frontmatter (graceful for placeholder
 *  missions that pre-date the convention). */
export function readFrontmatter(absPath: string): Record<string, unknown> {
  try {
    return splitFrontmatter(fs.readFileSync(absPath, "utf8")).frontmatter;
  } catch {
    return {};
  }
}

/** Update specific keys in a markdown file's frontmatter. Existing
 *  unknown keys are preserved. Generates minimal frontmatter when
 *  absent. */
export function updateFrontmatter(
  absPath: string,
  updates: Record<string, unknown>,
): void {
  const original = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : "";
  const { frontmatter, body } = splitFrontmatter(original);
  const merged = { ...frontmatter, ...updates };
  fs.writeFileSync(absPath, joinFrontmatter(merged, body), "utf8");
}

// ---------------------------------------------------------------------
// Mission discovery
// ---------------------------------------------------------------------

/** Locate the missions root for the working substrate. Resolution
 *  order:
 *    1. Explicit override (env or arg)
 *    2. $OPENRIG_WORK_ROOT/missions
 *    3. Search up from cwd for a `missions/` folder
 */
export function resolveMissionsRoot(opts: {
  override?: string | null;
  cwd?: string;
} = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const fromOverride = opts.override ?? process.env.OPENRIG_WORK_ROOT;
  if (fromOverride) {
    const candidate = path.isAbsolute(fromOverride) ? fromOverride : path.resolve(cwd, fromOverride);
    const missions = path.join(candidate, "missions");
    if (fs.existsSync(missions) && fs.statSync(missions).isDirectory()) return missions;
    if (path.basename(candidate) === "missions" && fs.existsSync(candidate)) return candidate;
  }
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "missions");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ScopeCliError({
    fact: `Could not locate a missions/ root from cwd ${cwd}.`,
    consequence: "No mission tree to operate on.",
    action: "cd into the substrate workspace, or set OPENRIG_WORK_ROOT=/path/to/substrate/shared-docs/openrig-work.",
  });
}

/** List mission folders under the missions root. A mission is any
 *  top-level folder containing a README.md. */
export function listMissions(missionsRoot: string): MissionInfo[] {
  if (!fs.existsSync(missionsRoot)) return [];
  const entries = fs.readdirSync(missionsRoot, { withFileTypes: true });
  const out: MissionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absPath = path.join(missionsRoot, entry.name);
    const readmePath = path.join(absPath, "README.md");
    const hasReadme = fs.existsSync(readmePath);
    const frontmatter = hasReadme ? readFrontmatter(readmePath) : {};
    const slicesDir = path.join(absPath, "slices");
    const closedDir = path.join(absPath, "closed");
    const activeSliceCount = countSliceDirs(slicesDir);
    const closedSliceCount = countSliceDirs(closedDir);
    const id = pickIdFromFrontmatter(frontmatter);
    out.push({
      name: entry.name,
      absPath,
      readmePath: hasReadme ? readmePath : null,
      frontmatter,
      id,
      activeSliceCount,
      closedSliceCount,
    });
  }
  // Stable order: by mission name.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function countSliceDirs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLICE_DIRNAME_RE.test(e.name))
    .length;
}

function pickIdFromFrontmatter(fm: Record<string, unknown>): string | null {
  const candidate = fm.id ?? fm.dotId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/** Resolve a mission by name OR path relative to the missions root.
 *  Throws ScopeCliError on miss. */
export function findMission(missionsRoot: string, identifier: string): MissionInfo {
  const candidates = [
    path.join(missionsRoot, identifier),
    path.isAbsolute(identifier) ? identifier : path.resolve(missionsRoot, identifier),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return buildMissionInfo(missionsRoot, candidate);
    }
  }
  throw new ScopeCliError({
    fact: `Mission "${identifier}" not found under ${missionsRoot}.`,
    consequence: "Command did not run.",
    action: "List available missions with: rig scope mission ls",
  });
}

function buildMissionInfo(missionsRoot: string, absPath: string): MissionInfo {
  const readmePath = path.join(absPath, "README.md");
  const hasReadme = fs.existsSync(readmePath);
  const frontmatter = hasReadme ? readFrontmatter(readmePath) : {};
  return {
    name: path.basename(absPath),
    absPath,
    readmePath: hasReadme ? readmePath : null,
    frontmatter,
    id: pickIdFromFrontmatter(frontmatter),
    activeSliceCount: countSliceDirs(path.join(absPath, "slices")),
    closedSliceCount: countSliceDirs(path.join(absPath, "closed")),
  };
}

// ---------------------------------------------------------------------
// Slice discovery
// ---------------------------------------------------------------------

export function listSlices(
  mission: MissionInfo,
  state: SliceState,
): SliceInfo[] {
  const dirs: Array<{ root: string; bucket: "active" | "closed" }> = [];
  if (state === "active" || state === "shipped" || state === "all") {
    dirs.push({ root: path.join(mission.absPath, "slices"), bucket: "active" });
  }
  if (state === "closed" || state === "all") {
    dirs.push({ root: path.join(mission.absPath, "closed"), bucket: "closed" });
  }
  const out: SliceInfo[] = [];
  for (const { root } of dirs) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = SLICE_DIRNAME_RE.exec(entry.name);
      if (!m) continue;
      const sliceInfo = buildSliceInfo(mission, root, entry.name);
      out.push(sliceInfo);
    }
  }
  if (state === "active") {
    // active = not in closed/, but also not shipped status.
    return out.filter((s) => {
      const st = (s.status ?? "").toLowerCase();
      return !st.startsWith("closed") && !st.startsWith("shipped");
    });
  }
  if (state === "shipped") {
    return out.filter((s) => (s.status ?? "").toLowerCase().startsWith("shipped"));
  }
  return out;
}

function buildSliceInfo(mission: MissionInfo, sliceRoot: string, dirName: string): SliceInfo {
  const m = SLICE_DIRNAME_RE.exec(dirName);
  const nn = m ? Number(m[1]) : null;
  const slug = m ? m[2]! : null;
  const absPath = path.join(sliceRoot, dirName);
  const readmePath = path.join(absPath, "README.md");
  const hasReadme = fs.existsSync(readmePath);
  const frontmatter = hasReadme ? readFrontmatter(readmePath) : {};
  const id = pickIdFromFrontmatter(frontmatter);
  const status = typeof frontmatter.status === "string" ? (frontmatter.status as string).toLowerCase() : null;
  return {
    name: dirName,
    absPath,
    readmePath: hasReadme ? readmePath : null,
    frontmatter,
    nn,
    slug,
    missionName: mission.name,
    id,
    status,
  };
}

/** Resolve a slice path (absolute, relative-to-substrate, or
 *  relative-to-mission) into a SliceInfo. */
export function findSlice(
  missionsRoot: string,
  slicePath: string,
  hintMission?: string | null,
): SliceInfo {
  const candidates: string[] = [];
  if (path.isAbsolute(slicePath)) {
    candidates.push(slicePath);
  } else {
    candidates.push(path.resolve(missionsRoot, "..", slicePath));
    candidates.push(path.resolve(missionsRoot, slicePath));
    if (hintMission) {
      candidates.push(path.join(missionsRoot, hintMission, "slices", slicePath));
      candidates.push(path.join(missionsRoot, hintMission, "closed", slicePath));
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      // Walk up to find the owning mission.
      const owningMissionPath = findOwningMission(missionsRoot, candidate);
      if (!owningMissionPath) {
        throw new ScopeCliError({
          fact: `Slice path "${slicePath}" resolved to ${candidate} but no parent mission was found.`,
          consequence: "Cannot determine mission context for this slice.",
          action: "Ensure the slice lives under <missionsRoot>/<mission>/{slices,closed}/.",
        });
      }
      const mission = buildMissionInfo(missionsRoot, owningMissionPath);
      const sliceRoot = path.dirname(candidate);
      return buildSliceInfo(mission, sliceRoot, path.basename(candidate));
    }
  }
  throw new ScopeCliError({
    fact: `Slice "${slicePath}" not found.`,
    consequence: "Command did not run.",
    action: "Check the path. List slices in a mission with: rig scope slice ls --mission <name>",
  });
}

function findOwningMission(missionsRoot: string, slicePath: string): string | null {
  let dir = path.dirname(slicePath);
  while (dir.startsWith(missionsRoot) && dir !== missionsRoot) {
    if (path.dirname(dir) === missionsRoot) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// ---------------------------------------------------------------------
// Auto-numbering
// ---------------------------------------------------------------------

/** Find the next available NN for a mission's slices/ folder. Scans
 *  BOTH slices/ AND closed/ so numbers are never reused (§3.2). */
export function nextSliceNN(missionAbsPath: string): number {
  let max = 0;
  for (const subdir of ["slices", "closed"]) {
    const root = path.join(missionAbsPath, subdir);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = SLICE_DIRNAME_RE.exec(entry.name);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/** Mint or read the dot-ID for a mission. If the mission's README has
 *  an `id:` field, return it. Otherwise infer from the folder name
 *  (release-X.Y.Z → OPR.X.Y.Z; otherwise escape band). */
export function ensureMissionId(
  mission: MissionInfo,
  missionsRoot: string,
): string {
  if (mission.id) return mission.id;
  // Try release-pattern first; if it matches, no peer scan needed.
  try {
    const id = inferMissionDotId(mission.name, null);
    return id;
  } catch {
    // Fall through to escape-band path.
  }
  const peers = listMissions(missionsRoot).filter((m) => m.name !== mission.name);
  const ordinal = nextEscapeBandOrdinal(peers.map((p) => p.id));
  return inferMissionDotId(mission.name, ordinal);
}

// ---------------------------------------------------------------------
// Git move
// ---------------------------------------------------------------------

/** Return the git toplevel for a path, or null if not inside a repo. */
export function gitTopLevel(absPath: string): string | null {
  const dir = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Refuse to move a path with uncommitted local changes. Catches the
 *  "dirty working tree" risk in §11.1 / §3.4 — `git mv` would silently
 *  carry along the user's in-progress edits. */
export function assertCleanWorkingTree(repoRoot: string, relPath: string): void {
  let status: string;
  try {
    status = execFileSync(
      "git",
      ["-C", repoRoot, "status", "--porcelain", "--", relPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    throw new ScopeCliError({
      fact: `git status failed for ${relPath} in ${repoRoot}: ${(err as Error).message}`,
      consequence: "Could not verify the slice's working-tree state. Move aborted.",
      action: "Check the repository at " + repoRoot + " and retry.",
    });
  }
  if (status.trim().length > 0) {
    throw new ScopeCliError({
      fact: `Working tree under ${relPath} has uncommitted changes:\n${status.trimEnd()}`,
      consequence: "Refusing to git mv — your local edits would silently move with the slice.",
      action: "Commit (git commit -m '...') or stash (git stash) and retry.",
    });
  }
}

/** Move a directory using `git mv` when inside a repo; fall back to
 *  `fs.renameSync` with a warning when not. Returns true if git was
 *  used. */
export function moveSlice(srcAbs: string, destAbs: string, opts: {
  /** Stage the move (default true). git mv stages by default; we
   *  preserve that semantic. */
  commit?: boolean;
} = {}): { usedGit: boolean; repoRoot: string | null } {
  if (!fs.existsSync(srcAbs)) {
    throw new ScopeCliError({
      fact: `Source path ${srcAbs} does not exist.`,
      consequence: "Move did not run.",
      action: "Verify the slice path and retry.",
    });
  }
  if (fs.existsSync(destAbs)) {
    throw new ScopeCliError({
      fact: `Destination path ${destAbs} already exists.`,
      consequence: "Refusing to overwrite an existing slice.",
      action: "Pick a different destination, or remove the existing folder first.",
    });
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const repoRoot = gitTopLevel(srcAbs);
  if (!repoRoot) {
    fs.renameSync(srcAbs, destAbs);
    return { usedGit: false, repoRoot: null };
  }
  // Normalize symlinks (macOS /var/folders → /private/var/folders) so
  // path.relative produces a path INSIDE the repo, not a ../../escape.
  const realSrcAbs = fs.realpathSync(srcAbs);
  const realDestParent = fs.realpathSync(path.dirname(destAbs));
  const realDestAbs = path.join(realDestParent, path.basename(destAbs));
  const srcRel = path.relative(repoRoot, realSrcAbs);
  assertCleanWorkingTree(repoRoot, srcRel);
  const destRel = path.relative(repoRoot, realDestAbs);
  try {
    execFileSync("git", ["-C", repoRoot, "mv", srcRel, destRel], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new ScopeCliError({
      fact: `git mv ${srcRel} ${destRel} failed: ${(err as Error).message}`,
      consequence: "Move aborted; source unchanged.",
      action: "Inspect the repo state and retry.",
    });
  }
  if (opts.commit) {
    // Future hook; v0 doesn't auto-commit.
  }
  return { usedGit: true, repoRoot };
}

// ---------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------

export function todayDateISO(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export { DEFAULT_PROJECT_PREFIX };
