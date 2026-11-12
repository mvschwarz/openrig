import nodePath from "node:path";
import { excludeNewGeneratedFiles } from "./generated-file-hygiene.js";

// Pre-release: projection markers that land in user-managed files
// (CLAUDE.md / AGENTS.md) carry the canonical product name. New writes
// emit the OpenRig form; legacy "RIGGED" markers from prior installs
// are still recognized by stripManagedBlocks below for clean uninstall.
export const MANAGED_BLOCK_START = (id: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->`;
export const MANAGED_BLOCK_END = (id: string) => `<!-- END OpenRig MANAGED BLOCK: ${id} -->`;
const LEGACY_BLOCK_START = (id: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${id} -->`;

// #25 — the file a rig's Claude Code seats receive managed blocks in
// (`managed_blocks: { claude-code: <file> }`). This is the set supported in
// this release, not every file Claude Code can load.
export const CLAUDE_MANAGED_BLOCK_FILES = ["CLAUDE.md", "CLAUDE.local.md"] as const;
export type ClaudeManagedBlockFile = (typeof CLAUDE_MANAGED_BLOCK_FILES)[number];
export const DEFAULT_CLAUDE_MANAGED_BLOCK_FILE: ClaudeManagedBlockFile = "CLAUDE.md";
const LEGACY_BLOCK_END = (id: string) => `<!-- END RIGGED MANAGED BLOCK: ${id} -->`;

export interface ManagedBlockMergeFsOps {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdirp?(path: string): void;
}

export interface ManagedBlockCleanupFsOps extends ManagedBlockMergeFsOps {
  deleteFile(path: string): void;
}

export interface MergeManagedBlockOptions {
  replaceBlockIds?: string[];
  warnings?: string[];
}

/** The exact text of a managed block as `mergeManagedBlock` writes it: the markers around the content. */
export function managedBlockText(blockId: string, content: string): string {
  return `${MANAGED_BLOCK_START(blockId)}\n${content}\n${MANAGED_BLOCK_END(blockId)}`;
}

/** What `mergeManagedBlock` puts between a file's existing text and a block it adds at the end. */
export const MANAGED_BLOCK_APPEND_SEPARATOR = "\n\n";

/** A BEGIN or END marker for `blockId`, in the current or the legacy form, as an editor or formatter may leave it: any
 *  run of whitespace, line breaks included, between its words. */
function markerSource(kind: "BEGIN" | "END", blockId: string): string {
  return `<!--\\s*${kind}\\s+(?:OpenRig|RIGGED)\\s+MANAGED\\s+BLOCK:\\s*${escapeRegex(blockId)}\\s*-->`;
}

/** One `blockId` block in a file: where it and its body start and end, and the text between its markers. */
export interface FoundManagedBlock { start: number; end: number; bodyStart: number; bodyEnd: number; body: string }

/** Every `blockId` block in `content`, in order: each BEGIN paired with the next marker when that marker is an END. A
 *  marker left without a pair (an END with no BEGIN before it, or a BEGIN followed by another BEGIN or by nothing) is
 *  counted in `unpaired`: where its block ends, or starts, can't be read. */
export function findManagedBlocks(content: string, blockId: string): { blocks: FoundManagedBlock[]; unpaired: number } {
  const markers = [...content.matchAll(new RegExp(`(${markerSource("BEGIN", blockId)})|${markerSource("END", blockId)}`, "g"))]
    .map((m) => ({ begin: m[1] !== undefined, index: m.index!, length: m[0].length }));
  const blocks: FoundManagedBlock[] = [];
  let unpaired = 0;
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    const next = markers[i + 1];
    if (marker.begin && next && !next.begin) {
      const bodyStart = marker.index + marker.length;
      blocks.push({ start: marker.index, end: next.index + next.length, bodyStart, bodyEnd: next.index, body: content.slice(bodyStart, next.index) });
      i++;
    } else {
      unpaired++;
    }
  }
  return { blocks, unpaired };
}

/** The note for a block OpenRig didn't write because a marker of it has lost its pair. */
export function damagedManagedBlockNote(targetPath: string, blockId: string): string {
  return `guidance_block_markers_damaged: ${targetPath}: ${blockId} has a BEGIN or END marker without its pair, so OpenRig `
    + "didn't add another copy; restore the missing marker or remove the partial block, and OpenRig's next write keeps one block";
}

/**
 * `existing` with `blockId`'s block written as `block`, or null when it can't be written without a second copy: the file
 * has a marker of that block without its pair, and no complete copy. The first copy is replaced in place and a later copy
 * is removed with the separator before it, so a file that collected copies keeps one; with `keepLater`, a later copy it
 * names stays, unless it repeats one already kept. Blocks of `replaceBlockIds` (older ids) are removed. A file with none
 * of these gets the block at its end.
 */
export function mergeManagedBlockText(existing: string, blockId: string, block: string, replaceBlockIds: readonly string[] = [],
  keepLater?: (body: string) => boolean): string | null {
  const own = findManagedBlocks(existing, blockId);
  if (own.blocks.length === 0 && own.unpaired > 0) return null;
  const keptLater: string[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  own.blocks.forEach((found, i) => {
    if (i === 0) edits.push({ start: found.start, end: found.end, text: block });
    else if (keepLater?.(found.body) && !keptLater.some((body) => managedBlockBodyMatches(body, found.body))) keptLater.push(found.body);
    else edits.push({ start: withSeparator(existing, found.start), end: found.end, text: "" });
  });
  for (const id of new Set(replaceBlockIds)) {
    if (id === blockId) continue;
    for (const found of findManagedBlocks(existing, id).blocks) edits.push({ start: found.start, end: found.end, text: "" });
  }
  if (edits.length === 0) return `${existing}${MANAGED_BLOCK_APPEND_SEPARATOR}${block}`;
  // A block of one id inside another's is left to the outer edit.
  const ordered: typeof edits = [];
  for (const edit of edits.sort((a, b) => a.start - b.start)) if (edit.start >= (ordered.at(-1)?.end ?? 0)) ordered.push(edit);
  let updated = existing;
  // The block goes in by slicing, never a replacement string, so `$&` and the like in authored content stay as written.
  for (const edit of ordered.reverse()) updated = `${updated.slice(0, edit.start)}${edit.text}${updated.slice(edit.end)}`;
  if (own.blocks.length === 0) updated = `${updated.trim()}\n\n${block}`.trim();
  // End with one newline only when the file doesn't already: re-merging on every launch must not add a line each time
  // (#2372), and blank lines a person left after the last block stay.
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

/** Where a later copy's removal starts: before the newlines that separate it from the text above, so removing the copy
 *  takes the separator the writer put there. */
function withSeparator(content: string, start: number): number {
  let from = start;
  while (from > 0 && content[from - 1] === "\n") from--;
  return from;
}

/** Write `blockId`'s block into a guidance file (see `mergeManagedBlockText`). Returns false, writing nothing and naming
 *  the block in `warnings`, when a marker of it has lost its pair. */
export function mergeManagedBlock(
  fs: ManagedBlockMergeFsOps,
  targetPath: string,
  blockId: string,
  content: string,
  options?: MergeManagedBlockOptions,
): boolean {
  const block = managedBlockText(blockId, content);

  if (!fs.exists(targetPath)) {
    fs.mkdirp?.(nodePath.dirname(targetPath));
    fs.writeFile(targetPath, block);
    const warnings = excludeNewGeneratedFiles(nodePath.dirname(targetPath), [targetPath]);
    options?.warnings?.push(...warnings);
    return true;
  }

  const existing = fs.readFile(targetPath);
  const merged = mergeManagedBlockText(existing, blockId, block, options?.replaceBlockIds ?? []);
  if (merged === null) {
    options?.warnings?.push(damagedManagedBlockNote(targetPath, blockId));
    return false;
  }
  fs.writeFile(targetPath, merged);
  if (findManagedBlocks(existing, blockId).unpaired > 0) options?.warnings?.push(unpairedMarkerNote(targetPath, blockId));
  return true;
}

/** The note for a marker without its pair left beside a block that was written. */
export function unpairedMarkerNote(targetPath: string, blockId: string): string {
  return `guidance_block_marker_unpaired: ${targetPath}: ${blockId} was written, and a BEGIN or END marker of it without its `
    + "pair was left as it is; remove it or restore its pair";
}

/** `content` with each `blockId` block whose markers an editor rewrapped written back in OpenRig's own form, its body
 *  exactly as it is. Markers already in the current or legacy form stay as they are. */
export function withCanonicalMarkers(content: string, blockId: string): string {
  let updated = content;
  for (const found of findManagedBlocks(content, blockId).blocks.reverse()) {
    const begin = content.slice(found.start, found.bodyStart);
    const end = content.slice(found.bodyEnd, found.end);
    const exact = (begin === MANAGED_BLOCK_START(blockId) && end === MANAGED_BLOCK_END(blockId))
      || (begin === LEGACY_BLOCK_START(blockId) && end === LEGACY_BLOCK_END(blockId));
    if (exact) continue;
    updated = `${updated.slice(0, found.start)}${MANAGED_BLOCK_START(blockId)}${found.body}${MANAGED_BLOCK_END(blockId)}${updated.slice(found.end)}`;
  }
  return updated;
}

/** Each `blockId` block in `content` (current markers): the whole block and the text between its markers. */
function managedBlockPattern(blockId: string): RegExp {
  return new RegExp(`${escapeRegex(MANAGED_BLOCK_START(blockId))}([\\s\\S]*?)${escapeRegex(MANAGED_BLOCK_END(blockId))}`, "g");
}

/** A block body without the writer's own framing: CRLF line endings become LF, and newlines at either end go. */
export function frameManagedBlockBody(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/** Whether a block's body still holds `written`: the same bytes, ignoring only the writer's own framing (newlines at either
 *  end, and CRLF line endings). A person's spaces count, so an indented line is an edit. */
export function managedBlockBodyMatches(body: string, written: string): boolean {
  return frameManagedBlockBody(body) === frameManagedBlockBody(written);
}

/** The bodies of every `blockId` block in `content`, in the current or the legacy marker form. */
export function managedBlockBodies(content: string, blockId: string): string[] {
  const legacy = new RegExp(`${escapeRegex(LEGACY_BLOCK_START(blockId))}([\\s\\S]*?)${escapeRegex(LEGACY_BLOCK_END(blockId))}`, "g");
  return [...content.matchAll(managedBlockPattern(blockId)), ...content.matchAll(legacy)].map((m) => m[1]!);
}

/** How many `blockId` blocks `content` opens, in the current or the legacy marker form, complete or not. More openings than
 *  `managedBlockBodies` returns means part of a block is missing its END. */
export function managedBlockOpenings(content: string, blockId: string): number {
  return content.split(MANAGED_BLOCK_START(blockId)).length - 1 + content.split(LEGACY_BLOCK_START(blockId)).length - 1;
}

/** #2456: how a block already in a guidance file stands against its current source and OpenRig's record of what it last
 *  wrote there (a hash of the framed body, `managedBlockBodyHash`):
 *  - `absent`: the file holds no such block;
 *  - `current`: it holds the source's text;
 *  - `stale`: it holds what OpenRig last wrote, and the source has changed since, so it's OpenRig's to refresh;
 *  - `edited`: it holds something else, which someone wrote by hand;
 *  - `unrecorded`: it differs from the source and OpenRig has no record of writing it, so which of the two is unknown;
 *  - `damaged`: it holds a marker of the block without its pair, and no complete copy, so the block can't be read.
 *  A block written more than once counts as edited when any copy is. */
export type ManagedBlockStanding = "absent" | "current" | "stale" | "edited" | "unrecorded" | "damaged";

export function managedBlockStanding(content: string, blockId: string, source: string, recordedHash: string | undefined,
  hash: (body: string) => string): ManagedBlockStanding {
  const found = findManagedBlocks(content, blockId);
  const bodies = found.blocks.map((block) => block.body);
  if (bodies.length === 0) return found.unpaired > 0 ? "damaged" : "absent";
  if (bodies.every((body) => managedBlockBodyMatches(body, source))) return "current";
  if (recordedHash === undefined) return "unrecorded";
  return bodies.every((body) => hash(body) === recordedHash) ? "stale" : "edited";
}

/** `content` with the extra copies of a `blockId` block taken out where no one's text is lost: a later copy whose body
 *  repeats an earlier copy's, and, beside a copy that's kept, a copy that `isOpenRigs` says holds only what OpenRig
 *  wrote. Every other copy stays where it is. Null when there's nothing to take out. */
export function pruneManagedBlockCopies(content: string, blockId: string, isOpenRigs: (body: string) => boolean): string | null {
  const { blocks } = findManagedBlocks(content, blockId);
  if (blocks.length < 2) return null;
  const kept: FoundManagedBlock[] = [];
  const removed: FoundManagedBlock[] = [];
  for (const block of blocks) {
    if (kept.some((other) => managedBlockBodyMatches(other.body, block.body))) removed.push(block);
    else kept.push(block);
  }
  const people = kept.filter((block) => !isOpenRigs(block.body));
  if (people.length > 0) for (const block of kept.filter((b) => isOpenRigs(b.body))) removed.push(block);
  if (removed.length === 0) return null;
  let updated = content;
  for (const block of removed.sort((a, b) => b.start - a.start)) {
    // A copy goes with the newlines before it; one that starts the file goes with the newlines after it instead.
    const from = withSeparator(content, block.start);
    let to = block.end;
    if (from === 0) while (updated[to] === "\n") to++;
    updated = `${updated.slice(0, from)}${updated.slice(to)}`;
  }
  return updated;
}

/** Whether `content` holds a `blockId` block whose body is anything but `written`: someone edited it. */
export function hasEditedManagedBlock(content: string, blockId: string, written: string): boolean {
  return [...content.matchAll(managedBlockPattern(blockId))].some((m) => !managedBlockBodyMatches(m[1]!, written));
}

/** What a removal did: whether the file changed, and the ids of blocks kept because they were edited. */
export interface ManagedBlockRemoval { changed: boolean; keptEdited: string[] }

/**
 * Remove OpenRig's managed blocks from a guidance file. A block named in `writtenBodies` is removed only while its body is
 * still what OpenRig writes there; an edited one is kept, in place, and named in `keptEdited`. Blocks with no known body
 * are removed as before.
 */
export function removeManagedBlocksFromFile(
  fs: ManagedBlockCleanupFsOps,
  targetPath: string,
  writtenBodies: Readonly<Record<string, string>> = {},
): ManagedBlockRemoval {
  if (!fs.exists(targetPath)) {
    return { changed: false, keptEdited: [] };
  }

  const original = fs.readFile(targetPath);
  const keptEdited: string[] = [];
  const kept: string[] = [];
  let working = original;
  for (const [id, body] of Object.entries(writtenBodies)) {
    working = working.replace(managedBlockPattern(id), (whole: string, inner: string) => {
      if (managedBlockBodyMatches(inner, body)) return whole;
      if (!keptEdited.includes(id)) keptEdited.push(id);
      kept.push(whole);
      return `\u0000openrig-kept-${kept.length - 1}\u0000`;
    });
  }
  // OpenRig's blocks and the newlines its writer adds come out exactly, so an unchanged file gets its bytes back; a file in
  // any other shape is cleaned and its blank lines normalized, as before.
  const exact = removeBlocksAsWritten(working);
  const cleaned = (exact ?? stripManagedBlocks(working)).replace(/\u0000openrig-kept-(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]!);
  // A file the writer created goes when nothing else is left; a file that was there before keeps its bytes, even empty.
  if (cleaned.length === 0 && (exact === null || working.startsWith("<!-- BEGIN OpenRig MANAGED BLOCK: "))) {
    fs.deleteFile(targetPath);
    return { changed: true, keptEdited };
  }

  if (exact === null ? cleaned !== original.trim() : cleaned !== original) {
    fs.writeFile(targetPath, exact === null ? `${cleaned}\n` : cleaned);
    return { changed: true, keptEdited };
  }

  return { changed: false, keptEdited };
}

/** The current writer's blocks where `stripManagedBlocks` finds them: the same matches, with each block's own span. */
const CURRENT_BLOCK = /(?:\n|^)\s*(<!-- BEGIN OpenRig MANAGED BLOCK: [\s\S]*?<!-- END OpenRig MANAGED BLOCK: [^>]+ -->)(\s*)(?=\n|$)/g;

/**
 * `content` with OpenRig's blocks taken out as `mergeManagedBlock` put them in: each block, the separator it wrote before
 * the first (none when that block started a new file), and the newline-only text between and after blocks, where the
 * writer puts its separators (a later merge ends the file with a newline). Text a person adds is kept. Blank lines a
 * person adds right next to a block, between blocks or after the last, go with it: they can't be told from the writer's.
 * Null when the file isn't in that shape, such as a legacy block, or text against a block without the writer's separator.
 */
function removeBlocksAsWritten(content: string): string | null {
  if (content.includes("<!-- BEGIN RIGGED MANAGED BLOCK:")) return null;
  const spans = [...content.matchAll(CURRENT_BLOCK)].map((m) => {
    const end = m.index! + m[0].length - m[2]!.length;
    return { start: end - m[1]!.length, end };
  });
  let kept = "";
  for (let i = 0; i <= spans.length; i++) {
    const text = content.slice(i === 0 ? 0 : spans[i - 1]!.end, i < spans.length ? spans[i]!.start : content.length);
    if (i > 0 && /^\n*$/.test(text)) continue;
    if (i === spans.length || (i === 0 && text === "")) { kept += text; continue; }
    if (!text.endsWith(MANAGED_BLOCK_APPEND_SEPARATOR)) return null;
    kept += text.slice(0, -MANAGED_BLOCK_APPEND_SEPARATOR.length);
  }
  return kept;
}

export function stripManagedBlocks(content: string): string {
  // Recognize both the OpenRig form (current writes) and the legacy
  // RIGGED form (existing user files written by prior installs) so
  // uninstall + cleanup paths handle both transitional states.
  return content
    .replace(/(?:\n|^)\s*<!-- BEGIN OpenRig MANAGED BLOCK: [\s\S]*?<!-- END OpenRig MANAGED BLOCK: [^>]+ -->\s*(?=\n|$)/g, "\n")
    .replace(/(?:\n|^)\s*<!-- BEGIN RIGGED MANAGED BLOCK: [\s\S]*?<!-- END RIGGED MANAGED BLOCK: [^>]+ -->\s*(?=\n|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A seat's own role guidance, which is delivered per seat through send_text and never merged into a guidance file
 *  pod-mates share (ADR-0006). Its id is `rig-role`. Projections saved before that id still carry `role` and are
 *  restored from that saved selection, so `role` counts too when its source is the agent's own `guidance/role.md`;
 *  shared guidance that happens to be named `role` and comes from another file still merges. */
export function isPerSeatRoleGuidance(blockId: string, sourcePath?: string): boolean {
  if (blockId === "rig-role") return true;
  return blockId === "role" && sourcePath !== undefined && PER_SEAT_ROLE_PATH.test(sourcePath);
}

/** An agent's own role file: `guidance/role.md`. */
const PER_SEAT_ROLE_PATH = /(^|[\\/])guidance[\\/]role\.md$/;

/** A startup file that is a seat's own role: marked `orientation: role`, or at the per-seat `guidance/role.md` path.
 *  With the `auto` hint it is delivered by send_text, never merged into a guidance file pod-mates share (ADR-0006),
 *  where each launch would overwrite the last seat's role. An explicit hint is kept as written. */
export function isPerSeatRoleStartupFile(path: string, orientation?: string): boolean {
  return orientation === "role" || PER_SEAT_ROLE_PATH.test(path);
}

/** The warning a skipped legacy `role` leaves in the projection result: a spec saved before `rig-role` may have had no
 *  other route for it. A `rig-role` skip is the designed path, so it adds none. */
export function perSeatRoleSkipWarning(blockId: string, targetPath: string): string | undefined {
  if (blockId === "rig-role") return undefined;
  return `${blockId}: not merged into ${targetPath}, the guidance file pod-mates share, because guidance/role.md is a seat's own role. `
    + "A seat's role reaches it only as a send_text startup file; a seat whose spec has none starts without its role.";
}
