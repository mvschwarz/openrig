import nodePath from "node:path";

// Pre-release: projection markers that land in user-managed files
// (CLAUDE.md / AGENTS.md) carry the canonical product name. New writes
// emit the OpenRig form; legacy "RIGGED" markers from prior installs
// are still recognized by stripManagedBlocks below for clean uninstall.
export const MANAGED_BLOCK_START = (id: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->`;
export const MANAGED_BLOCK_END = (id: string) => `<!-- END OpenRig MANAGED BLOCK: ${id} -->`;
const LEGACY_BLOCK_START = (id: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${id} -->`;
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
}

export function mergeManagedBlock(
  fs: ManagedBlockMergeFsOps,
  targetPath: string,
  blockId: string,
  content: string,
  options?: MergeManagedBlockOptions,
): void {
  const begin = MANAGED_BLOCK_START(blockId);
  const end = MANAGED_BLOCK_END(blockId);
  const block = `${begin}\n${content}\n${end}`;

  if (!fs.exists(targetPath)) {
    fs.mkdirp?.(nodePath.dirname(targetPath));
    fs.writeFile(targetPath, block);
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
      updated = updated.replace(regex, id === blockId ? block : "");
      // Legacy marker variant from prior installs — replace with the
      // OpenRig form (or strip when not the active block id).
      const legacyBegin = LEGACY_BLOCK_START(id);
      const legacyEnd = LEGACY_BLOCK_END(id);
      const legacyRegex = new RegExp(`${escapeRegex(legacyBegin)}[\\s\\S]*?${escapeRegex(legacyEnd)}`, "g");
      updated = updated.replace(legacyRegex, id === blockId ? block : "");
    }
    if (!updated.includes(begin) || !updated.includes(end)) {
      updated = `${updated.trim()}\n\n${block}`.trim();
    }
    fs.writeFile(targetPath, `${updated}\n`);
    return;
  }

  fs.writeFile(targetPath, `${existing}\n\n${block}`);
}

export function removeManagedBlocksFromFile(fs: ManagedBlockCleanupFsOps, targetPath: string): boolean {
  if (!fs.exists(targetPath)) {
    return false;
  }

  const original = fs.readFile(targetPath);
  const cleaned = stripManagedBlocks(original);
  if (cleaned.length === 0) {
    fs.deleteFile(targetPath);
    return true;
  }

  if (cleaned !== original.trim()) {
    fs.writeFile(targetPath, `${cleaned}\n`);
    return true;
  }

  return false;
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
