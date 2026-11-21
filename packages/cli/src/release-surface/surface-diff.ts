// OPR.0.3.3.13.1 - CLI surface diff (Component 1 of slice 13).
//
// Given two git refs, reads `packages/cli/src/commands/*.ts` at each ref via
// `git show`, extracts the Commander surface (extract-surface.ts), diffs them,
// and emits a deterministic `release-surface-diff.yaml`. Fully offline and
// deterministic: the only inputs are the two refs + the repo's git object store;
// no network, no agent/LLM involvement (the deterministic half of slice 13's
// "deterministic for enumeration, agent for voice" split).

import { execFileSync } from "node:child_process";
import { stringify } from "yaml";

import { extractSurfaceFromSources, FLAG_SEP, type Surface } from "./extract-surface.js";

const COMMANDS_DIR = "packages/cli/src/commands";

export interface AddedCommand {
  name: string;
  subcommands: string[];
}
export interface AddedFlagsEntry {
  command: string;
  flags?: string[];
  subcommands?: string[];
}
export interface SurfaceDiff {
  release_from: string;
  release_to: string;
  added_commands: AddedCommand[];
  added_flags: AddedFlagsEntry[];
  removed_or_renamed: string[];
}

/** Honest 3-part error matching the repo's CLI error shape (queue.ts:88-111). */
export class SurfaceParserError extends Error {
  readonly fact: string;
  readonly consequence: string;
  readonly action: string;
  constructor(parts: { fact: string; consequence: string; action: string }) {
    super(parts.fact);
    this.name = "SurfaceParserError";
    this.fact = parts.fact;
    this.consequence = parts.consequence;
    this.action = parts.action;
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function firstToken(path: string): string {
  return path.split(" ")[0] ?? "";
}

function splitFlagEntry(entry: string): { command: string; flag: string } {
  const i = entry.indexOf(FLAG_SEP);
  return { command: entry.slice(0, i), flag: entry.slice(i + FLAG_SEP.length) };
}

export function resolveRepoRoot(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new SurfaceParserError({
      fact: `Not inside a git repository (cwd: ${cwd}).`,
      consequence: "The surface parser reads CLI sources at two git refs; without a repo it cannot run.",
      action: "Run from inside the openrig git repository, or pass an explicit repoRoot.",
    });
  }
}

interface TreeEntry {
  sha: string;
  path: string;
}

function listCommandTree(repoRoot: string, ref: string): TreeEntry[] {
  let out: string;
  try {
    out = git(repoRoot, ["ls-tree", ref, `${COMMANDS_DIR}/`]);
  } catch (err) {
    throw new SurfaceParserError({
      fact: `Could not list ${COMMANDS_DIR}/ at ref "${ref}": ${String((err as Error).message).split("\n")[0]}`,
      consequence: "The CLI surface for that ref could not be read, so no release-surface diff was produced.",
      action: `Verify the ref exists (git rev-parse "${ref}") and that ${COMMANDS_DIR}/ is present at that ref.`,
    });
  }
  const entries: TreeEntry[] = [];
  for (const line of out.split("\n")) {
    // "<mode> blob <sha>\t<path>"
    const m = line.match(/^\S+\s+blob\s+(\S+)\t(.+)$/);
    if (!m) continue;
    const path = m[2]!;
    if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("/index.ts")) {
      entries.push({ sha: m[1]!, path });
    }
  }
  if (entries.length === 0) {
    throw new SurfaceParserError({
      fact: `No Commander command files found under ${COMMANDS_DIR}/ at ref "${ref}".`,
      consequence: "An empty command layout would make the diff misreport the entire surface as removed or added.",
      action: `Confirm ${COMMANDS_DIR}/ exists at "${ref}" and holds the CLI command registrations.`,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

// One `git cat-file --batch` reads every blob for a ref (vs one `git show` per
// file). Keeps the parser fast enough to run repeatedly (and the determinism
// test under timeout). Byte-accurate: cat-file emits `<oid> blob <size>\n` then
// exactly <size> content bytes then `\n`, per requested oid, in request order.
function readBlobs(repoRoot: string, entries: TreeEntry[]): Map<string, string> {
  const input = entries.map((e) => e.sha).join("\n") + "\n";
  const buf = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input,
    maxBuffer: 128 * 1024 * 1024,
  }) as unknown as Buffer;
  const result = new Map<string, string>();
  let pos = 0;
  for (const entry of entries) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.toString("utf8", pos, nl);
    const size = Number.parseInt(header.split(" ")[2] ?? "", 10);
    if (!Number.isFinite(size)) {
      throw new SurfaceParserError({
        fact: `git cat-file returned an unreadable record for blob ${entry.sha} ("${header}").`,
        consequence: "The command source could not be read, so the surface diff would be wrong.",
        action: `Verify the repository object store is intact (git fsck) and the ref is valid.`,
      });
    }
    const contentStart = nl + 1;
    result.set(entry.sha, buf.toString("utf8", contentStart, contentStart + size));
    pos = contentStart + size + 1; // skip content + trailing newline
  }
  return result;
}

function readSurfaceAtRef(repoRoot: string, ref: string): Surface {
  const entries = listCommandTree(repoRoot, ref);
  const blobs = readBlobs(repoRoot, entries);
  const sources = entries.map((e) => ({ name: e.path, text: blobs.get(e.sha) ?? "" }));
  return extractSurfaceFromSources(sources);
}

/** Pure diff of two extracted surfaces into the slice-13 YAML shape. */
export function computeDiff(
  from: Surface,
  to: Surface,
  releaseFrom: string,
  releaseTo: string,
): SurfaceDiff {
  const addedCmdPaths = [...to.commands].filter((c) => !from.commands.has(c));
  const removedCmdPaths = [...from.commands].filter((c) => !to.commands.has(c));
  const addedFlagEntries = [...to.flags].filter((f) => !from.flags.has(f));
  const removedFlagEntries = [...from.flags].filter((f) => !to.flags.has(f));

  const addedCmdSet = new Set(addedCmdPaths);
  // A top-level command is brand-new when its single-token path was added.
  const newTopCommands = new Set(addedCmdPaths.filter((p) => !p.includes(" ")));

  // added_commands: each brand-new top-level command + its added sub-paths.
  const added_commands: AddedCommand[] = [...newTopCommands].sort().map((name) => ({
    name,
    subcommands: addedCmdPaths
      .filter((p) => p !== name && firstToken(p) === name)
      .map((p) => p.split(" ").slice(1).join(" "))
      .sort(),
  }));

  // added_flags: PRE-EXISTING commands that gained flags (keyed by full command
  // path) and/or new subcommands (keyed by their existing top-level command).
  const flagsByCommand = new Map<string, Set<string>>();
  for (const entry of addedFlagEntries) {
    const { command, flag } = splitFlagEntry(entry);
    if (newTopCommands.has(firstToken(command))) continue; // new command -> flags implied by added_commands
    if (addedCmdSet.has(command)) continue; // brand-new subcommand -> flags implied by its listing
    if (!flagsByCommand.has(command)) flagsByCommand.set(command, new Set());
    flagsByCommand.get(command)!.add(flag);
  }
  const subsByTop = new Map<string, Set<string>>();
  for (const p of addedCmdPaths) {
    if (!p.includes(" ")) continue; // brand-new top-level command (added_commands)
    const top = firstToken(p);
    if (newTopCommands.has(top)) continue; // subtree of a brand-new top-level command
    if (!subsByTop.has(top)) subsByTop.set(top, new Set());
    subsByTop.get(top)!.add(p.split(" ").slice(1).join(" "));
  }
  const changedCommands = new Set<string>([...flagsByCommand.keys(), ...subsByTop.keys()]);
  const added_flags: AddedFlagsEntry[] = [...changedCommands].sort().map((command) => {
    const entry: AddedFlagsEntry = { command };
    const fl = flagsByCommand.get(command);
    if (fl && fl.size > 0) entry.flags = [...fl].sort();
    const sub = subsByTop.get(command);
    if (sub && sub.size > 0) entry.subcommands = [...sub].sort();
    return entry;
  });

  const removed_or_renamed = [
    ...removedCmdPaths,
    ...removedFlagEntries.map((e) => {
      const { command, flag } = splitFlagEntry(e);
      return `${command} ${flag}`;
    }),
  ].sort();

  return { release_from: releaseFrom, release_to: releaseTo, added_commands, added_flags, removed_or_renamed };
}

/** Default `--from`: the latest `v*` tag reachable before `to`. */
function defaultFrom(repoRoot: string, to: string): string {
  try {
    const commit = `${to}^{commit}`;
    // A release can have multiple tags. Exclude all names on the target itself
    // so describe can walk every parent of a merge looking for an earlier release.
    const tags = git(repoRoot, ["tag", "--no-column", "--list", "v*", "--points-at", commit]).split("\n").filter(Boolean);
    return git(repoRoot, ["describe", "--tags", "--abbrev=0", "--match", "v*", ...tags.map(tag => `--exclude=${tag}`), commit]).trim();
  } catch {
    throw new SurfaceParserError({
      fact: `No release tag could be resolved before "${to}" for the default --from ref.`,
      consequence: "Without a prior release ref the surface diff cannot be computed.",
      action: "Pass --from <ref> to choose a comparison base.",
    });
  }
}

export function generateSurfaceDiff(opts: {
  from?: string;
  to?: string;
  cwd?: string;
  repoRoot?: string;
}): SurfaceDiff {
  const repoRoot = opts.repoRoot ?? resolveRepoRoot(opts.cwd ?? process.cwd());
  const to = opts.to ?? "HEAD";
  const from = opts.from ?? defaultFrom(repoRoot, to);
  const fromSurface = readSurfaceAtRef(repoRoot, from);
  const toSurface = readSurfaceAtRef(repoRoot, to);
  return computeDiff(fromSurface, toSurface, from, to);
}

/** Deterministic YAML serialization (stable key + element order). */
export function diffToYaml(diff: SurfaceDiff): string {
  return stringify(diff, { sortMapEntries: false });
}
