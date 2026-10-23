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

export function mergeManagedBlock(
  fs: ManagedBlockMergeFsOps,
  targetPath: string,
  blockId: string,
  content: string,
  options?: MergeManagedBlockOptions,
): void {
  const begin = MANAGED_BLOCK_START(blockId);
  const end = MANAGED_BLOCK_END(blockId);
  const block = managedBlockText(blockId, content);

  if (!fs.exists(targetPath)) {
    fs.mkdirp?.(nodePath.dirname(targetPath));
    fs.writeFile(targetPath, block);
    const warnings = excludeNewGeneratedFiles(nodePath.dirname(targetPath), [targetPath]);
    options?.warnings?.push(...warnings);
    return;
  }

  const existing = fs.readFile(targetPath);
  const allReplaceIds = Array.from(new Set([blockId, ...(options?.replaceBlockIds ?? [])]));
  const replaceableIds = allReplaceIds.filter((id) => {
    const candidateBegin = MANAGED_BLOCK_START(id);
    const candidateEnd = MANAGED_BLOCK_END(id);
    const legacyBegin = LEGACY_BLOCK_START(id);
    const legacyEnd = LEGACY_BLOCK_END(id);
    return (
      (existing.includes(candidateBegin) && existing.includes(candidateEnd)) ||
      (existing.includes(legacyBegin) && existing.includes(legacyEnd))
    );
  });

  if (replaceableIds.length > 0) {
    let updated = existing;
    for (const id of replaceableIds) {
      const candidateBegin = MANAGED_BLOCK_START(id);
      const candidateEnd = MANAGED_BLOCK_END(id);
      const regex = new RegExp(`${escapeRegex(candidateBegin)}[\\s\\S]*?${escapeRegex(candidateEnd)}`, "g");
      // A replacer function inserts the block literally; a replacement string
      // would expand `$$`, `$&`, `` $` `` and `$'` in the authored content.
      const replacement = id === blockId ? block : "";
      updated = updated.replace(regex, () => replacement);
      // Legacy marker variant from prior installs — replace with the
      // OpenRig form (or strip when not the active block id).
      const legacyBegin = LEGACY_BLOCK_START(id);
      const legacyEnd = LEGACY_BLOCK_END(id);
      const legacyRegex = new RegExp(`${escapeRegex(legacyBegin)}[\\s\\S]*?${escapeRegex(legacyEnd)}`, "g");
      updated = updated.replace(legacyRegex, () => replacement);
    }
    if (!updated.includes(begin) || !updated.includes(end)) {
      updated = `${updated.trim()}\n\n${block}`.trim();
    }
    fs.writeFile(targetPath, `${updated}\n`);
    return;
  }

  fs.writeFile(targetPath, `${existing}${MANAGED_BLOCK_APPEND_SEPARATOR}${block}`);
}

/** Each `blockId` block in `content` (current markers): the whole block and the text between its markers. */
function managedBlockPattern(blockId: string): RegExp {
  return new RegExp(`${escapeRegex(MANAGED_BLOCK_START(blockId))}([\\s\\S]*?)${escapeRegex(MANAGED_BLOCK_END(blockId))}`, "g");
}

/** Whether a block's body still holds `written`: the same bytes, ignoring only the writer's own framing (newlines at either
 *  end, and CRLF line endings). A person's spaces count, so an indented line is an edit. */
export function managedBlockBodyMatches(body: string, written: string): boolean {
  const frame = (text: string) => text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return frame(body) === frame(written);
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
  const cleaned = stripManagedBlocks(working).replace(/\u0000openrig-kept-(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]!);
  if (cleaned.length === 0) {
    fs.deleteFile(targetPath);
    return { changed: true, keptEdited };
  }

  if (cleaned !== original.trim()) {
    fs.writeFile(targetPath, `${cleaned}\n`);
    return { changed: true, keptEdited };
  }

  return { changed: false, keptEdited };
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
